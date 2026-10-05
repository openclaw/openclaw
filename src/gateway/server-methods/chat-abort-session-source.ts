import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { withSessionEntryReadOnlyInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import { isIncognitoSessionKey, normalizeAgentId } from "../../routing/session-key.js";
import { parseAgentSessionKey } from "../../sessions/session-key-utils.js";
import {
  resolveRequestedSessionAgentId,
  tryResolveSessionCompatibilityOwnerAgentId,
} from "../session-request-agent.js";
import { prepareSessionMutationFacts } from "../session-sharing-preparation.js";
import { resolveSessionStoreKey } from "../session-utils.js";
import { resolveChatAbortRequester } from "./chat-abort-authorization.js";
import type { ChatAbortSessionSnapshot } from "./chat-aborted-partial.js";
import { readGatewayRequestMutationAuthority } from "./session-mutation-guards.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

export function resolveChatAbortSessionTarget(input: {
  options: GatewayRequestHandlerOptions;
  authority: ReturnType<typeof readGatewayRequestMutationAuthority>;
  requester: ReturnType<typeof resolveChatAbortRequester>;
  rawSessionKey: string;
  requestedAgentId?: string;
  discardPendingInput?: boolean;
}) {
  const {
    options: { context, respond, sessionMutationAuthorization },
    authority,
    requester,
    rawSessionKey,
    requestedAgentId,
    discardPendingInput,
  } = input;
  const agentIdOverride = normalizeOptionalString(requestedAgentId);
  const abortCfg = context.getRuntimeConfig();
  const parsedAbortSessionKey = parseAgentSessionKey(rawSessionKey);
  const compatibilityDefaultAgentId = tryResolveSessionCompatibilityOwnerAgentId(
    abortCfg,
    rawSessionKey,
  );
  const inferredSessionAgentId =
    !agentIdOverride && parsedAbortSessionKey
      ? normalizeAgentId(parsedAbortSessionKey.agentId)
      : undefined;
  const bareSessionAgentResolution = !parsedAbortSessionKey
    ? resolveRequestedSessionAgentId(abortCfg, rawSessionKey, agentIdOverride)
    : undefined;
  if (bareSessionAgentResolution && !bareSessionAgentResolution.ok) {
    respond(false, undefined, bareSessionAgentResolution.error);
    return undefined;
  }
  const abortAgentId = parsedAbortSessionKey
    ? (agentIdOverride ?? inferredSessionAgentId)
    : bareSessionAgentResolution?.agentId;
  if (!abortAgentId) {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        rawSessionKey.trim().toLowerCase() === "global"
          ? "agentId is required for global chat.abort when no compatibility owner exists"
          : "agentId is required for unscoped chat.abort when no compatibility owner exists",
      ),
    );
    return undefined;
  }
  if (
    agentIdOverride &&
    parsedAbortSessionKey &&
    normalizeAgentId(parsedAbortSessionKey.agentId) !== normalizeAgentId(agentIdOverride)
  ) {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        `agentId "${agentIdOverride}" does not match session key "${rawSessionKey}"`,
      ),
    );
    return undefined;
  }
  const canonicalAbortSessionKey = resolveSessionStoreKey({
    cfg: abortCfg,
    sessionKey: rawSessionKey,
    storeAgentId: abortAgentId,
  });
  if (discardPendingInput && isIncognitoSessionKey(canonicalAbortSessionKey)) {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        "Removing accepted queued input is unavailable in incognito sessions. Use Stop to cancel it.",
      ),
    );
    return undefined;
  }
  const narrow =
    authority.sessionScope === "operator.sessions.write" ||
    requester.sessionAuthority !== undefined;
  const admittedTarget = sessionMutationAuthorization?.admittedTarget;
  if (
    narrow &&
    (!admittedTarget?.sessionId.trim() ||
      admittedTarget.sessionKey !== canonicalAbortSessionKey ||
      admittedTarget.agentId !== normalizeAgentId(abortAgentId))
  ) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, "session target is unavailable"),
    );
    return undefined;
  }
  const requiredSessionId = narrow ? admittedTarget?.sessionId : undefined;
  return {
    abortCfg,
    abortAgentId,
    canonicalAbortSessionKey,
    compatibilityDefaultAgentId,
    requiredSessionId,
    narrow,
  };
}

export async function prepareChatAbortSessionSource(input: {
  abortCfg: ReturnType<GatewayRequestHandlerOptions["context"]["getRuntimeConfig"]>;
  abortAgentId: string;
  canonicalAbortSessionKey: string;
  context: GatewayRequestHandlerOptions["context"];
  assertCurrent: () => void;
  installSourceGuard: (assertCurrent: () => void) => void;
}) {
  const {
    abortCfg,
    abortAgentId,
    canonicalAbortSessionKey,
    context,
    assertCurrent,
    installSourceGuard,
  } = input;
  let releaseFacts: (() => void) | undefined;
  const abortSession: ChatAbortSessionSnapshot = await (async () => {
    try {
      const facts = await prepareSessionMutationFacts({
        cfg: abortCfg,
        sessionKey: canonicalAbortSessionKey,
        agentId: abortAgentId,
        allowMissing: true,
      });
      releaseFacts = facts.release;
      const initial = facts.readCurrent(context.getRuntimeConfig());
      const selected = initial.target;
      installSourceGuard(() => {
        const current = facts.readCurrent(context.getRuntimeConfig());
        if (
          current.target?.entry.sessionId !== selected?.entry.sessionId ||
          current.target?.entry.lifecycleRevision !== selected?.entry.lifecycleRevision ||
          current.target?.storeKey !== selected?.storeKey ||
          current.target?.agentId !== selected?.agentId ||
          current.target?.storePath !== selected?.storePath ||
          current.sourceAgentId !== initial.sourceAgentId ||
          current.sourcePath !== initial.sourcePath
        ) {
          throw new Error("Session changed before cancellation; refresh and retry.");
        }
      });
      const entry = selected
        ? await withSessionEntryReadOnlyInWorker(
            {
              agentId: selected.agentId,
              sessionKey: selected.storeKey,
              storePath: initial.sourcePath ?? selected.storePath,
              projection: "list",
              hydrateSkillPromptRefs: false,
              readConsistency: "latest",
            },
            assertCurrent,
            async (read, owner) => {
              owner.assertCurrent();
              if (!read.ok) {
                throw read.error;
              }
              return read.value;
            },
          )
        : undefined;
      assertCurrent();
      if (
        selected &&
        (entry?.sessionId !== selected.entry.sessionId ||
          entry.lifecycleRevision !== selected.entry.lifecycleRevision)
      ) {
        throw new Error("Session changed while preparing cancellation; refresh and retry.");
      }
      return {
        ok: true as const,
        value: {
          cfg: abortCfg,
          agentId: facts.storageTarget.agentId,
          canonicalKey: facts.storageTarget.canonicalKey,
          storePath: facts.storageTarget.storePath,
          entry,
        },
      };
    } catch (error) {
      return { ok: false as const, error };
    }
  })();
  return { abortSession, releaseFacts };
}
