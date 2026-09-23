import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  ErrorCodes,
  errorShape,
  readAgentRuntimeRestrictionErrorDetails,
  type ErrorShape,
} from "../../../packages/gateway-protocol/src/index.js";
import { getRegisteredAgentHarness } from "../../agents/harness/registry.js";
import { resolveProviderIdForAuth } from "../../agents/provider-auth-aliases.js";
import { resolveEffectiveAgentRuntime } from "../../agents/thinking-runtime.js";
import { resolveAgentTimeoutMs } from "../../agents/timeout.js";
import { resolveTextCommand } from "../../auto-reply/commands-registry.js";
import {
  resolveAgentMainSessionKey,
  resolveSessionRoutingContract,
} from "../../config/sessions/main-session.js";
import { buildSessionCreationStamp } from "../../config/sessions/session-entry-provenance.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { measureDiagnosticsTimelineSpanSync } from "../../infra/diagnostics-timeline.js";
import { isIncognitoSessionKey } from "../../routing/session-key.js";
import { resolveMissingAgentHarnessSessionError } from "../../sessions/agent-harness-session-key.js";
import { assertPreparedSkillLibrarySelection } from "../../skills/library/selection.js";
import { isBrowserOperatorUiClient } from "../../utils/message-channel.js";
import { authorizeGatewaySessionCreation, resolveCreatorSandbox } from "../operator-role-policy.js";
import { pendingChatSendDedupeKey } from "../server-shared.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import {
  loadSessionEntry,
  resolveDeletedAgentIdFromSessionKey,
  resolveSessionModelRef,
} from "../session-utils.js";
import { prepareSkillLibrarySessionCreation } from "../skill-library-session.js";
import { hasGatewayAdminScope, resolveChatSendActiveScopeKey } from "./chat-origin-routing.js";
import { createRestartSafeChatRequest } from "./chat-restart-recovery.js";
import type { NormalizedChatSendRequest } from "./chat-send-request.js";
import { roundedChatSendTimingMs } from "./chat-server-timing.js";
import { normalizeOptionalChatText } from "./chat-text-normalization.js";
import { emitSessionsChanged } from "./session-change-event.js";
import { resolveOperatorSessionCreation } from "./session-creation-provenance.js";
import { resolveSessionNativeRuntimeRestriction } from "./sessions-patch-model-selection.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

// Preparing the canonical creator defaults does not itself persist a session.
export function prepareChatSendSessionEntry(params: {
  cfg: OpenClawConfig;
  client: GatewayRequestHandlerOptions["client"];
  agentId: string;
  getRuntimeConfig: () => OpenClawConfig;
}): { entry: SessionEntry; assertSkillSelection: () => void } {
  const { cfg, client, agentId, getRuntimeConfig } = params;
  const creationError = authorizeGatewaySessionCreation({ cfg, client, agentId });
  if (creationError) {
    throw new Error(creationError.message);
  }
  const creation = prepareSkillLibrarySessionCreation(
    client,
    getRuntimeConfig,
    resolveOperatorSessionCreation(client),
  );
  const assertSkillSelection = () =>
    assertPreparedSkillLibrarySelection(creation.skillLibrarySelections);
  const createdAt = Date.now();
  // A caller's retry ID must never revive a retained transcript window.
  const sessionId = randomUUID();
  return {
    entry: {
      ...buildSessionCreationStamp({
        ...creation,
        sandbox: resolveCreatorSandbox(cfg, creation),
        now: createdAt,
      }),
      sessionId,
      lifecycleRevision: randomUUID(),
      updatedAt: createdAt,
      sessionStartedAt: createdAt,
      lastInteractionAt: createdAt,
      chatType: "direct",
    },
    assertSkillSelection,
  };
}

function loadChatSendSessionContext(params: {
  request: NormalizedChatSendRequest;
  context: GatewayRequestHandlerOptions["context"];
}) {
  const { request, context } = params;
  const { p, explicitOrigin, normalizedAttachments } = request;
  const rawSessionKey = p.sessionKey;
  const agentIdOverride = normalizeOptionalChatText(p.agentId);
  const clientRunId = p.idempotencyKey;
  const pendingChatSendKey = pendingChatSendDedupeKey(clientRunId);
  const runtimeConfig = context.getRuntimeConfig();
  const requestedAgent = resolveRequestedSessionAgentId(
    runtimeConfig,
    rawSessionKey,
    agentIdOverride,
  );
  if (!requestedAgent.ok) {
    return { ok: false as const, error: requestedAgent.error };
  }
  const requestedAgentId = requestedAgent.agentId;
  // Outside configured global scope, `global` + agentId is the shipped webchat
  // alias for that agent's main thread. Resolve it before every store lookup so
  // reconnect replay cannot create a parallel literal `global` transcript.
  const sessionLoadKey =
    runtimeConfig.session?.scope !== "global" && rawSessionKey.trim().toLowerCase() === "global"
      ? resolveAgentMainSessionKey({ cfg: runtimeConfig, agentId: requestedAgentId })
      : rawSessionKey;
  const sessionLoadOptions = { agentId: requestedAgentId };
  const sessionLoadStartedAtMs = performance.now();
  const sessionLoadResult = measureDiagnosticsTimelineSpanSync(
    "gateway.chat_send.load_session",
    () => loadSessionEntry(sessionLoadKey, sessionLoadOptions, runtimeConfig),
    {
      phase: "agent-turn",
      attributes: {
        runId: clientRunId,
        hasAttachments: normalizedAttachments.length > 0,
        hasExplicitOrigin: explicitOrigin !== undefined,
      },
    },
  );
  const sessionLoadMs = roundedChatSendTimingMs(performance.now() - sessionLoadStartedAtMs);
  const { cfg, agentId, storePath, entry, canonicalKey: sessionKey, legacyKey } = sessionLoadResult;
  const expectedSessionRoutingContract = normalizeOptionalChatText(
    p.expectedSessionRoutingContract,
  );
  const expectedLeafEntryId =
    p.expectedLeafEntryId === null ? null : normalizeOptionalChatText(p.expectedLeafEntryId);
  const sessionRoutingChanged = (candidateConfig: OpenClawConfig) =>
    expectedSessionRoutingContract !== undefined &&
    expectedSessionRoutingContract.toLowerCase() !== resolveSessionRoutingContract(candidateConfig);
  return {
    ok: true as const,
    value: {
      rawSessionKey,
      sessionLoadKey,
      clientRunId,
      pendingChatSendKey,
      sessionLoadOptions,
      sessionLoadMs,
      cfg,
      agentId,
      selectedAgent: requestedAgent,
      storePath,
      ...(sessionLoadResult.readSource ? { readSource: sessionLoadResult.readSource } : {}),
      entry,
      sessionKey,
      legacyKey,
      sessionRoutingChanged,
      expectedLeafEntryId,
      agentIdOverride,
      requestedAgentId,
    },
  };
}

/** Load and validate the session/model facts shared by later admission and dispatch phases. */
export function prepareChatSendSession(params: {
  request: NormalizedChatSendRequest;
  context: GatewayRequestHandlerOptions["context"];
  client: GatewayRequestHandlerOptions["client"];
}) {
  const loaded = loadChatSendSessionContext(params);
  if (!loaded.ok) {
    return loaded;
  }
  const loadedValue = loaded.value;
  const { request, client } = params;
  const { p, explicitOrigin, normalizedAttachments, turnKind, rawMessage } = request;
  const { cfg, agentId, sessionKey, entry, legacyKey, selectedAgent } = loadedValue;
  if (isIncognitoSessionKey(sessionKey) && !entry) {
    return { ok: false as const, error: `Incognito session "${sessionKey}" was not found.` };
  }
  const missingHarnessSessionError = resolveMissingAgentHarnessSessionError(sessionKey, entry);
  if (missingHarnessSessionError) {
    return { ok: false as const, error: missingHarnessSessionError };
  }

  const deletedAgentId = resolveDeletedAgentIdFromSessionKey(cfg, sessionKey, entry, {
    acpMetadataSessionKey: legacyKey ?? sessionKey,
  });
  if (deletedAgentId !== null) {
    return {
      ok: false as const,
      error: `Agent "${deletedAgentId}" no longer exists in configuration`,
    };
  }

  const requestedSessionId = normalizeOptionalChatText(p.sessionId);
  const backingSessionId = entry?.sessionId ?? requestedSessionId;
  if (!entry) {
    const creationError = authorizeGatewaySessionCreation({
      cfg,
      client,
      agentId,
    });
    if (creationError) {
      return { ok: false as const, error: creationError };
    }
  }
  const activeRunScopeKey = resolveChatSendActiveScopeKey({
    sessionKey,
    agentId: selectedAgent.agentId,
    mainKey: cfg.session?.mainKey,
  });
  const resolvedSessionModel = resolveSessionModelRef(cfg, entry, agentId);
  const resolvedSessionAuthProvider = resolveProviderIdForAuth(resolvedSessionModel.provider, {
    config: cfg,
  });
  const timeoutMs = resolveAgentTimeoutMs({ cfg, overrideMs: p.timeoutMs });
  const now = Date.now();
  const restartSafeRequest = createRestartSafeChatRequest({
    goalRequestFingerprint: request.goalOperation?.requestFingerprint,
    cfg,
    eligible:
      isBrowserOperatorUiClient(request.clientInfo) &&
      turnKind === "main" &&
      normalizedAttachments.length === 0 &&
      !request.reconnectResumeRequested &&
      explicitOrigin === undefined &&
      p.deliver !== true &&
      p.thinking === undefined &&
      p.fastMode === undefined &&
      p.fastAutoOnSeconds === undefined &&
      p.timeoutMs === undefined &&
      request.systemInputProvenance === undefined &&
      request.systemProvenanceReceipt === undefined &&
      !request.suppressCommandInterpretation,
    message: rawMessage,
    mentions: p.mentions,
    senderIsOwner: hasGatewayAdminScope(client),
  });

  return {
    ok: true as const,
    value: {
      ...loadedValue,
      requestedSessionId,
      backingSessionId,
      activeRunScopeKey,
      resolvedSessionModel,
      resolvedSessionAuthProvider,
      timeoutMs,
      now,
      restartSafeRequest,
    },
  };
}

export type PreparedChatSendSession = Extract<
  ReturnType<typeof prepareChatSendSession>,
  { ok: true }
>["value"];

/** Refuse before send admission so confirmation can retain the unsent composer. */
export async function prepareChatSendNativeRuntimeRestriction(params: {
  request: NormalizedChatSendRequest;
  session: PreparedChatSendSession;
  client: GatewayRequestHandlerOptions["client"];
  context: GatewayRequestHandlerOptions["context"];
  assertCurrent?: () => void;
}): Promise<ErrorShape | undefined> {
  const { request, session, client, context } = params;
  const { entry, cfg, agentId, sessionKey, resolvedSessionModel } = session;
  if (
    request.turnKind !== "main" ||
    request.stopCommand ||
    (!entry && session.requestedSessionId) ||
    (!request.suppressCommandInterpretation && resolveTextCommand(request.inboundMessage, cfg))
  ) {
    return undefined;
  }
  const runtime = resolveEffectiveAgentRuntime({
    cfg,
    agentId,
    sessionKey,
    sessionEntry: entry,
    provider: resolvedSessionModel.provider,
    modelId: resolvedSessionModel.model,
  });
  if (runtime === "openclaw") {
    return undefined;
  }
  // Availability and implicit-runtime fallback belong to the execution selector.
  const harness = getRegisteredAgentHarness(runtime)?.harness;
  if (!harness || harness.executionEnvironment !== "host-only") {
    return undefined;
  }
  const creation = resolveOperatorSessionCreation(client);
  const prospectiveEntry =
    entry ??
    buildSessionCreationStamp({
      ...creation,
      sandbox: resolveCreatorSandbox(cfg, creation),
      now: session.now,
    });
  const restriction = resolveSessionNativeRuntimeRestriction({
    operation: "send",
    cfg,
    agentId,
    sessionKey,
    entry: prospectiveEntry,
    persistedEntry: entry,
    harness,
    provider: resolvedSessionModel.provider,
    modelId: resolvedSessionModel.model,
    callerCanConsent: hasGatewayAdminScope(client),
  });
  const details = readAgentRuntimeRestrictionErrorDetails(restriction?.details);
  if (
    entry ||
    !restriction ||
    !hasGatewayAdminScope(client) ||
    !details ||
    details.reason === "sandbox-required" ||
    details.reason === "remote-execution"
  ) {
    return restriction;
  }

  // The original authorized send initializes its real row, not its input or a run.
  // Reuse reply initialization so consent can bind the existing incarnation contract.
  const [
    { loadReplySessionInitializationSnapshot, commitReplySessionInitialization },
    { recordSessionCreated },
  ] = await Promise.all([
    import("../../config/sessions/session-accessor.reset.js"),
    import("../../sessions/session-created.js"),
  ]);
  params.assertCurrent?.();
  const scope = { agentId, sessionKey, storePath: session.storePath };
  const snapshot = loadReplySessionInitializationSnapshot(scope);
  if (snapshot.currentEntry) {
    return errorShape(
      ErrorCodes.INVALID_REQUEST,
      "Session changed before native confirmation. Retry.",
    );
  }
  const prepared = prepareChatSendSessionEntry({
    cfg,
    client,
    agentId,
    getRuntimeConfig: context.getRuntimeConfig,
  });
  const committed = await commitReplySessionInitialization({
    ...scope,
    activeSessionKey: sessionKey,
    expectedRevision: snapshot.revision,
    sessionEntry: prepared.entry,
    commitGuard: () => {
      params.assertCurrent?.();
      prepared.assertSkillSelection();
      const currentConfig = context.getRuntimeConfig();
      const current = loadSessionEntry(session.sessionLoadKey, session.sessionLoadOptions);
      const currentCreation = resolveOperatorSessionCreation(client);
      const currentModel = resolveSessionModelRef(currentConfig, undefined, agentId);
      const creationError = authorizeGatewaySessionCreation({
        cfg: currentConfig,
        client,
        agentId,
      });
      const currentRestriction = readAgentRuntimeRestrictionErrorDetails(
        resolveSessionNativeRuntimeRestriction({
          operation: "send",
          cfg: currentConfig,
          agentId,
          sessionKey,
          entry: prepared.entry,
          persistedEntry: undefined,
          harness,
          provider: currentModel.provider,
          modelId: currentModel.model,
          callerCanConsent: hasGatewayAdminScope(client),
        })?.details,
      );
      if (
        creationError ||
        !hasGatewayAdminScope(client) ||
        current.entry ||
        current.storePath !== session.storePath ||
        current.canonicalKey !== sessionKey ||
        session.sessionRoutingChanged(currentConfig) ||
        currentCreation.actor?.id !== prepared.entry.createdActor?.id ||
        resolveCreatorSandbox(currentConfig, currentCreation) !== prepared.entry.sandbox ||
        currentModel.provider !== resolvedSessionModel.provider ||
        currentModel.model !== resolvedSessionModel.model ||
        currentRestriction?.reason !== details.reason ||
        resolveEffectiveAgentRuntime({
          cfg: currentConfig,
          agentId,
          sessionKey,
          provider: currentModel.provider,
          modelId: currentModel.model,
        }) !== runtime
      ) {
        throw new Error(creationError?.message ?? "Native session creation changed before commit.");
      }
    },
  });
  if (!committed.ok) {
    return errorShape(
      ErrorCodes.INVALID_REQUEST,
      "Session changed before native confirmation. Retry.",
    );
  }
  recordSessionCreated(cfg, { agentId, sessionKey, entry: committed.sessionEntry });
  emitSessionsChanged(context, { agentId, sessionKey, reason: "create" });
  return resolveSessionNativeRuntimeRestriction({
    operation: "send",
    cfg: context.getRuntimeConfig(),
    agentId,
    sessionKey,
    entry: committed.sessionEntry,
    persistedEntry: committed.sessionEntry,
    harness,
    provider: resolvedSessionModel.provider,
    modelId: resolvedSessionModel.model,
    callerCanConsent: hasGatewayAdminScope(client),
  });
}
