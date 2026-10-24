import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import {
  ErrorCodes,
  errorShape,
  validateChatPredictParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolveSessionWorkStartError } from "../../config/sessions/session-work-start.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import { racePromiseWithAbortSignal } from "../../infra/abort-signal.js";
import {
  getRpcSourceForGateway,
  getRpcSourceIdentity,
} from "../../sessions/session-controller.rpc-sources.js";
import { waitForChatAbortTerminalPersistence } from "../chat-abort-lifecycle-internal.js";
import { chatRunBelongsToAgent } from "../chat-run-owner.js";
import { captureGatewayOperatorRunAuthority } from "../operator-run-authority.js";
import { SessionMutationAuthorizationChangedError } from "../session-mutation-authorization-error.js";
import { withReadySessionRows } from "../session-row-prepared-read.js";
import { getSessionRowProjection } from "../session-row-projection-access.js";
import { captureRpcSourceScopeMatcher } from "../session-runtime-scope.js";
import { readChatHistoryPage } from "./chat-history-pages.js";
import { prepareChatHistorySessionRead } from "./chat-history-session-read.js";
import { resolveVisibleActiveSessionRunState } from "./session-active-runs.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

class PredictionObsoleteError extends Error {}

function conversationText(messages: unknown[]): string | undefined {
  const turns = messages.flatMap((value) => {
    const message = asOptionalRecord(value);
    if (!message || (message.role !== "user" && message.role !== "assistant")) {
      return [];
    }
    const text =
      typeof message.content === "string"
        ? message.content
        : Array.isArray(message.content)
          ? message.content
              .flatMap((content) => {
                const block = asOptionalRecord(content);
                return block?.type === "text" && typeof block.text === "string" ? [block.text] : [];
              })
              .join("\n")
          : "";
    return text.trim() ? [{ role: message.role, text: text.slice(0, 2_000) }] : [];
  });
  if (turns.at(-1)?.role !== "assistant" || !turns.some((turn) => turn.role === "user")) {
    return undefined;
  }
  return JSON.stringify(turns.slice(-8));
}

export const chatPredictionHandlers: GatewayRequestHandlers = {
  "chat.predict": async (options) => {
    const {
      params,
      respond,
      context,
      client,
      signal,
      sessionMutationAuthorization,
      sessionAccessAuthority,
      hasCurrentClientAuthority,
    } = options;
    if (!assertValidParams(params, validateChatPredictParams, "chat.predict", respond)) {
      return;
    }
    const feature =
      context.getRuntimeConfig().gateway?.controlUi?.experimental?.composerPredictions;
    if (feature?.enabled !== true) {
      respond(true, { text: null });
      return;
    }
    // This is a human composer affordance, not an alternate agent tool or system inference route.
    if (!client?.connId || !sessionAccessAuthority) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.FORBIDDEN,
          "Composer predictions require a connected composer with session write access.",
        ),
      );
      return;
    }
    const connId = client.connId;
    let selection: Awaited<ReturnType<typeof prepareChatHistorySessionRead>>;
    let operator: Awaited<ReturnType<typeof captureGatewayOperatorRunAuthority>>;
    try {
      const target = sessionAccessAuthority.target;
      const projectedTarget = getSessionRowProjection(context)?.sharingTarget({
        agentId: target.agentId,
        key: target.sessionKey,
      });
      const resolveGatewayContext = context.resolveGatewayContext;
      const pending = getRpcSourceForGateway(params.runId, resolveGatewayContext);
      const pendingIdentity = pending && getRpcSourceIdentity(pending);
      if (
        pending &&
        projectedTarget &&
        captureRpcSourceScopeMatcher({
          storePath: projectedTarget.storePath,
          resolveGatewayContext,
        })(pending) &&
        pendingIdentity?.sessionId === target.sessionId &&
        pendingIdentity.sessionKey === target.sessionKey &&
        chatRunBelongsToAgent(pendingIdentity, target.agentId) &&
        (pending.adapter.projectSessionTerminalPending ||
          pending.adapter.projectSessionTerminalPersistence)
      ) {
        // Successful finals precede their durable row update. Join that existing
        // owner before taking the history snapshot; a null reply is not retried.
        await racePromiseWithAbortSignal(waitForChatAbortTerminalPersistence(pending), signal);
        sessionAccessAuthority.assertCurrent();
      }
      selection = await prepareChatHistorySessionRead({
        context,
        client,
        respond,
        signal,
        sessionMutationAuthorization,
        method: "chat.predict",
        sessionKey: params.sessionKey,
      });
      if (!selection) {
        return;
      }
      const { selectedSession, entry, rowProjection, queries, readCurrentSharing } = selection;
      const { cfg, agentId, canonicalKey, storePath } = selectedSession;
      if (!entry) {
        respond(true, { text: null });
        return;
      }
      const sessionId = entry.sessionId;
      const choice = feature.model ?? "utility";
      const assertCompletedAnchor = (current: InternalSessionEntry | undefined) => {
        if (
          !sessionId ||
          current?.sessionId !== sessionId ||
          current.lastRunId !== params.runId ||
          current.status !== "done" ||
          current.lifecycleRunId ||
          resolveSessionWorkStartError(canonicalKey, current) ||
          resolveVisibleActiveSessionRunState({
            storePath,
            resolveGatewayContext,
            requestedKey: params.sessionKey,
            canonicalKey,
            sessionId,
            agentId,
            includeTerminalPersistence: true,
          }).active
        ) {
          throw new PredictionObsoleteError();
        }
      };
      const assertCurrent = () => {
        signal?.throwIfAborted();
        sessionAccessAuthority.assertCurrent();
        if (
          hasCurrentClientAuthority?.() === false ||
          context.isConnectionActive?.(connId) === false
        ) {
          throw new PredictionObsoleteError();
        }
        const currentFeature =
          context.getRuntimeConfig().gateway?.controlUi?.experimental?.composerPredictions;
        if (currentFeature?.enabled !== true || (currentFeature.model ?? "utility") !== choice) {
          throw new PredictionObsoleteError();
        }
        const row = rowProjection.describe(
          { key: canonicalKey, agentId, storePath },
          selectedSession.record,
        );
        assertCompletedAnchor(row?.storedEntry ?? row?.entry);
      };
      assertCompletedAnchor(entry);
      if (
        !(await withReadySessionRows(rowProjection, queries, (read) =>
          Boolean(readCurrentSharing(read)),
        ))
      ) {
        return;
      }
      assertCurrent();
      const history = await readChatHistoryPage(
        {
          entry,
          provider: undefined,
          sessionId,
          storePath,
          sessionAgentId: agentId,
          canonicalKey,
          max: 12,
          maxHistoryBytes: 24_000,
          responseHistoryBytes: 24_000,
          effectiveMaxChars: 2_000,
          toolResultMaxChars: 0,
          offset: undefined,
          messageId: undefined,
          ignoreCliSessionImports: true,
        },
        signal,
      );
      assertCurrent();
      const conversation = conversationText(history.messages);
      if (!conversation) {
        respond(true, { text: null });
        return;
      }
      operator = await captureGatewayOperatorRunAuthority({
        client,
        context,
        hasCurrentClientAuthority,
        invocationAuthority: { assertCurrent, signal },
      });
      assertCurrent();
      if (!operator) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.FORBIDDEN,
            "Composer predictions require an authenticated operator.",
          ),
        );
        return;
      }
      const { completeComposerPrediction } = await import("../composer-prediction-completion.js");
      assertCurrent();
      const text = await completeComposerPrediction({
        cfg,
        agentId,
        sessionKey: canonicalKey,
        entry,
        choice,
        conversation,
        assertCurrent,
        operatorAuthority: operator.authority,
        signal,
      });
      assertCurrent();
      respond(true, { text });
    } catch (error) {
      if (error instanceof PredictionObsoleteError) {
        respond(true, { text: null });
      } else if (error instanceof SessionMutationAuthorizationChangedError) {
        respond(false, undefined, error.error);
      } else {
        // Provider errors may contain credentials or prompt details; never forward them.
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.UNAVAILABLE,
            "Composer predictions are unavailable for the selected model.",
          ),
        );
      }
    } finally {
      operator?.release();
      selection?.release();
    }
  },
};
