import {
  ErrorCodes,
  errorShape,
  validateChatAnswerCancelParams,
  validateChatAnswerTransformParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { getCliSessionBinding } from "../../config/sessions/cli-session-binding.js";
import { captureSessionActorTranscriptRead } from "../../config/sessions/session-actor-transcript-read.js";
import { answerLensRevision, readAnswerLensSource } from "../answer-lens.js";
import { projectChatDisplayMessage } from "../chat-display-projection.js";
import { captureGatewayOperatorRunAuthority } from "../operator-run-authority.js";
import { SessionMutationAuthorizationChangedError } from "../session-mutation-authorization-error.js";
import { withReadySessionRows } from "../session-row-prepared-read.js";
import { resolveSessionModelRef } from "../session-utils.js";
import { readChatHistoryMessageById } from "./chat-history-pages.js";
import { prepareChatHistorySessionRead } from "./chat-history-session-read.js";
import type { GatewayClient, GatewayRequestHandlers, RespondFn } from "./types.js";
import { assertValidParams } from "./validation.js";

// Connection lifetime scopes cancellation; no retained variants or transcript state live here.
const pending = new WeakMap<
  GatewayClient,
  Map<string, { answer: string; controller: AbortController }>
>();

export const chatAnswerTransformHandlers: GatewayRequestHandlers = {
  "chat.answer.cancel": async ({ params, client, respond }) => {
    if (!assertValidParams(params, validateChatAnswerCancelParams, "chat.answer.cancel", respond)) {
      return;
    }
    const request = client && pending.get(client)?.get(params.requestId);
    request?.controller.abort();
    respond(true, { cancelled: Boolean(request) });
  },
  "chat.answer.transform": async (options) => {
    const {
      params,
      context,
      client,
      signal: requestSignal,
      sessionMutationAuthorization,
      hasCurrentClientAuthority,
    } = options;
    let responded = false;
    const respond: RespondFn = (...args) => {
      responded = true;
      options.respond(...args);
    };
    if (
      !assertValidParams(
        params,
        validateChatAnswerTransformParams,
        "chat.answer.transform",
        respond,
      )
    ) {
      return;
    }
    const fail = (message: string, code?: string) =>
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, message, code ? { details: { code } } : undefined),
      );
    if (!client?.connId) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.FORBIDDEN, "Answer Lens requires a connected operator."),
      );
      return;
    }
    const connId = client.connId;
    let requests = pending.get(client);
    if (!requests) {
      requests = new Map();
      pending.set(client, requests);
    }
    if (requests.has(params.requestId)) {
      fail("Answer Lens request ID is already in use.");
      return;
    }
    const answer = JSON.stringify([params.agentId, params.sessionKey, params.messageId]);
    for (const active of requests.values()) {
      if (active.answer === answer) {
        active.controller.abort();
      }
    }
    if (requests.size >= 4) {
      fail("Wait for an existing Answer Lens request to finish.");
      return;
    }
    const controller = new AbortController();
    requests.set(params.requestId, { answer, controller });
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(30_000),
      ...(requestSignal ? [requestSignal] : []),
    ]);
    let assertSourceCurrent: (() => void) | undefined;
    const assertCurrent = () => {
      signal.throwIfAborted();
      sessionMutationAuthorization?.assertCurrent();
      assertSourceCurrent?.();
      if (
        hasCurrentClientAuthority?.() === false ||
        context.isConnectionActive?.(connId) === false
      ) {
        throw new Error("Answer Lens connection retired.");
      }
    };
    let selection: Awaited<ReturnType<typeof prepareChatHistorySessionRead>>;
    let operator: Awaited<ReturnType<typeof captureGatewayOperatorRunAuthority>>;
    try {
      selection = await prepareChatHistorySessionRead({
        context,
        client,
        respond,
        signal,
        sessionMutationAuthorization,
        method: "chat.answer.transform",
        sessionKey: params.sessionKey,
        agentIdOverride: params.agentId,
      });
      if (!selection) {
        return;
      }
      const { selectedSession, entry, queries, readCurrentSharing, rowProjection } = selection;
      const { cfg, agentId, storePath, canonicalKey } = selectedSession;
      if (!entry?.sessionId) {
        fail("The source answer is unavailable.");
        return;
      }
      const memory = captureSessionActorTranscriptRead(
        {
          agentId,
          sessionId: entry.sessionId,
          sessionKey: canonicalKey,
          storePath,
          sessionEntry: entry,
        },
        signal,
      );
      // Private actor authority must outlive the read and fence every provider/socket effect.
      assertSourceCurrent = memory
        ? memory.assertCurrent
        : () => {
            if (!readCurrentSharing(rowProjection)) {
              throw new Error("Answer Lens access changed.");
            }
          };
      const withCurrent = <T>(consume: () => T) =>
        withReadySessionRows(rowProjection, queries, (read) => {
          assertCurrent();
          return readCurrentSharing(read) ? consume() : undefined;
        });
      const readSource = async () => {
        const source = await readChatHistoryMessageById({
          entry,
          provider: getCliSessionBinding(entry, "claude-cli")?.sessionId
            ? resolveSessionModelRef(cfg, entry, agentId, { allowPluginNormalization: false })
                .provider
            : undefined,
          sessionAgentId: agentId,
          sessionId: entry.sessionId,
          canonicalKey,
          storePath,
          messageId: params.messageId,
          max: 1,
          maxHistoryBytes: 64_000,
          effectiveMaxChars: 32_001,
          offset: undefined,
        });
        if (!source.found || source.oversized || !source.message) {
          return undefined;
        }
        return readAnswerLensSource(
          projectChatDisplayMessage(source.message, { maxChars: 32_001 }),
        );
      };
      const text = await readSource();
      if (!(await withCurrent(() => true))) {
        return;
      }
      if (!text) {
        fail("Answer Lens requires a completed assistant answer of at most 32,000 characters.");
        return;
      }
      const sourceRevision = answerLensRevision(text);
      const original = params.coverage === "full" && params.wording === "original";
      if (!original && params.sourceRevision !== sourceRevision) {
        fail(
          "The source answer changed. Reopen Answer Lens and try again.",
          "ANSWER_LENS_SOURCE_CHANGED",
        );
        return;
      }
      const identity = {
        messageId: params.messageId,
        sourceRevision,
        coverage: params.coverage,
        wording: params.wording,
      };
      if (original) {
        await withCurrent(() => respond(true, { ...identity, text, durationMs: 0 }));
        return;
      }
      if (text.includes("`") || /^ {0,3}~{3,}/m.test(text) || /^(?: {4}|\t)\S/m.test(text)) {
        fail("Answer Lens currently supports prose-only answers; code stays unchanged.");
        return;
      }
      operator = await captureGatewayOperatorRunAuthority({
        client,
        context,
        hasCurrentClientAuthority,
        invocationAuthority: { assertCurrent, signal },
      });
      if (!operator) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.FORBIDDEN, "Answer Lens requires an authenticated operator."),
        );
        return;
      }
      const { completeAnswerLens } = await import("../answer-lens-completion.js");
      if (!(await withCurrent(() => true))) {
        return;
      }
      const start = performance.now();
      const result = await completeAnswerLens({
        cfg,
        agentId,
        source: text,
        coverage: params.coverage,
        wording: params.wording,
        assertCurrent,
        operatorAuthority: operator.authority,
        signal,
        onText: (partialText) => {
          assertCurrent();
          if (partialText.length > 48_000) {
            controller.abort();
            throw new Error("Invalid Answer Lens output.");
          }
          context.broadcastToConnIds(
            "chat.answer.delta",
            {
              ...identity,
              requestId: params.requestId,
              sessionKey: canonicalKey,
              agentId,
              text: partialText,
            },
            new Set([connId]),
          );
        },
      });
      // A source edit or branch change during inference must not publish a stale variant.
      const currentText = await readSource();
      await withCurrent(() => {
        if (currentText !== text) {
          fail(
            "The source answer changed. Reopen Answer Lens and try again.",
            "ANSWER_LENS_SOURCE_CHANGED",
          );
          return;
        }
        respond(true, {
          ...identity,
          text: result.text,
          model: `${result.provider}/${result.model}`,
          durationMs: Math.round(performance.now() - start),
          ...(result.usage ? { usage: result.usage } : {}),
        });
      });
    } catch (error) {
      if (responded) {
        return;
      }
      if (error instanceof SessionMutationAuthorizationChangedError) {
        respond(false, undefined, error.error);
      } else {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.UNAVAILABLE,
            signal.aborted
              ? "Answer Lens was cancelled or timed out."
              : "Answer Lens is unavailable for the configured utility model. Try again or restore Original.",
          ),
        );
      }
    } finally {
      operator?.release();
      selection?.release();
      requests.delete(params.requestId);
    }
  },
};
