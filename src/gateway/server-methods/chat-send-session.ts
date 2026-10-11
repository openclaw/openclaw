import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { isDeepStrictEqual } from "node:util";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  readAgentRuntimeRestrictionErrorDetails,
  type ErrorShape,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolveAgentEntry } from "../../agents/agent-scope-config.js";
import {
  modelFallbackOverrideFromAvailability,
  resolveModelFallbackAvailability,
} from "../../agents/agent-scope.js";
import { getRegisteredAgentHarness } from "../../agents/harness/registry.js";
import {
  findNormalizedProviderValue,
  parseModelRef,
} from "../../agents/model-selection-normalize.js";
import { resolveProviderIdForAuth } from "../../agents/provider-auth-aliases.js";
import { resolveEffectiveAgentRuntime } from "../../agents/thinking-runtime.js";
import { resolveAgentTimeoutMs } from "../../agents/timeout.js";
import { resolveTextCommand } from "../../auto-reply/commands-registry.js";
import {
  resolveSessionRoutingContract,
  SESSION_ROUTING_CHANGED_ERROR_REASON,
} from "../../config/sessions/main-session.js";
import { prepareQualifiedSessionEntryTarget } from "../../config/sessions/session-accessor.js";
import type { QualifiedSessionEntryAccessTarget } from "../../config/sessions/session-accessor.types.js";
import { buildSessionCreationStamp } from "../../config/sessions/session-entry-provenance.js";
import type { CapturedSessionEntryReadSource } from "../../config/sessions/session-entry-read-source.types.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { measureDiagnosticsTimelineSpan } from "../../infra/diagnostics-timeline.js";
import { isIncognitoSessionKey } from "../../routing/session-key.js";
import { resolveMissingAgentHarnessSessionError } from "../../sessions/agent-harness-session-key.js";
import { assertPreparedSkillLibrarySelection } from "../../skills/library/selection.js";
import { sessionDeliveryChannel } from "../../utils/delivery-context.read.js";
import { isBrowserOperatorUiClient } from "../../utils/message-channel.js";
import { authorizeGatewaySessionCreation, resolveCreatorSandbox } from "../operator-role-policy.js";
import { hasGatewayAdminScope } from "../operator-scopes.js";
import { pendingChatSendDedupeKey } from "../server-shared.js";
import { resolveOperatorSessionCreation } from "../session-creation-provenance.js";
import {
  resolveChatSendSessionKey,
  resolveRequestedSessionAgentId,
} from "../session-request-agent.js";
import { captureSessionMutationRouting } from "../session-sharing-preparation.js";
import {
  withGatewaySessionEntry,
  withQualifiedGatewaySessionEntry,
} from "../session-utils-store.js";
import {
  loadSessionEntry,
  prepareDeletedAgentSessionCheck,
  resolveSessionModelRef,
} from "../session-utils.js";
import { prepareSkillLibrarySessionCreation } from "../skill-library-session.js";
import { createRestartSafeChatRequest } from "./chat-restart-recovery.js";
import type { NormalizedChatSendRequest } from "./chat-send-request.js";
import { roundedChatSendTimingMs } from "./chat-server-timing.js";
import { emitSessionsChanged } from "./session-change-event.js";
import { resolveSessionNativeRuntimeRestriction } from "./sessions-patch-model-selection.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

// These inputs prepare model/runtime selection, native restrictions, command/retry
// semantics, and creator defaults. Sharing authorization rechecks live policy;
// unrelated logging and UI publications do not invalidate a prepared send.
function chatSendPreparationConfig(
  cfg: OpenClawConfig,
  agentId: string,
  entry?: SessionEntry,
  request?: Pick<NormalizedChatSendRequest, "explicitOrigin">,
  sessionKey?: string,
) {
  const defaults = cfg.agents?.defaults;
  const agent = resolveAgentEntry(cfg, agentId);
  const selected = resolveSessionModelRef(cfg, entry, agentId);
  const fallbacks =
    modelFallbackOverrideFromAvailability(
      resolveModelFallbackAvailability({
        cfg,
        agentId,
        sessionKey,
        hasSessionModelOverride: Boolean(entry?.modelOverride),
        modelOverrideSource:
          entry?.modelOverrideSource === "default" ? undefined : entry?.modelOverrideSource,
        modelSelectionLocked: entry?.modelSelectionLocked,
      }),
    ) ?? [];
  const modelRefs = [
    selected,
    ...fallbacks.flatMap((model) => {
      const parsed = parseModelRef(model, selected.provider);
      return parsed ? [parsed] : [];
    }),
  ];
  const providers = Object.fromEntries(
    [...new Set(modelRefs.map(({ provider }) => provider))].map((id) => {
      const provider = findNormalizedProviderValue(cfg.models?.providers, id);
      return [
        id,
        provider
          ? {
              ...provider,
              models: provider.models?.filter(({ id: model }) =>
                modelRefs.some((ref) => ref.provider === id && ref.model === model),
              ),
            }
          : undefined,
      ];
    }),
  );
  const channels = [
    ...new Set(
      [
        "webchat",
        request?.explicitOrigin?.originatingChannel,
        sessionDeliveryChannel(entry),
      ].filter((channel): channel is string => Boolean(channel)),
    ),
  ];
  return {
    defaultModel: defaults?.model,
    agentModel: agent?.model,
    defaultModels: defaults?.models,
    agentModels: agent?.models,
    defaultModelPolicy: defaults?.modelPolicy,
    agentModelPolicy: agent?.modelPolicy,
    runtime: agent?.runtime,
    models: { mode: cfg.models?.mode, providers },
    auth: cfg.auth,
    plugins: cfg.plugins,
    workspace: agent?.workspace ?? defaults?.workspace,
    agentDir: agent?.agentDir,
    timeoutSeconds: defaults?.timeoutSeconds,
    defaultSandbox: defaults?.sandbox,
    agentSandbox: agent?.sandbox,
    tools: cfg.tools,
    agentTools: agent?.tools,
    channels: {
      defaults: cfg.channels?.defaults,
      selected: Object.fromEntries(channels.map((channel) => [channel, cfg.channels?.[channel]])),
    },
    roles: cfg.gateway?.roles,
    nodeCommands: cfg.gateway?.nodes?.commands,
    commands: cfg.commands,
    sendPolicy: cfg.session?.sendPolicy,
    reset: cfg.session?.reset,
    resetByType: cfg.session?.resetByType,
    resetByChannel: cfg.session?.resetByChannel,
  };
}

// Preparing the canonical creator defaults does not itself persist a session.
export async function prepareChatSendSessionEntry(params: {
  cfg: OpenClawConfig;
  client: GatewayRequestHandlerOptions["client"];
  agentId: string;
  getRuntimeConfig: () => OpenClawConfig;
}): Promise<{ entry: SessionEntry; assertSkillSelection: () => void }> {
  const { cfg, client, agentId, getRuntimeConfig } = params;
  const creationError = authorizeGatewaySessionCreation({ cfg, client, agentId });
  if (creationError) {
    throw new Error(creationError.message);
  }
  const creation = await prepareSkillLibrarySessionCreation(
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

async function loadChatSendSessionContext(params: {
  request: NormalizedChatSendRequest;
  context: GatewayRequestHandlerOptions["context"];
}) {
  const { request, context } = params;
  const { p, explicitOrigin, normalizedAttachments } = request;
  const rawSessionKey = p.sessionKey;
  if (!rawSessionKey.trim()) {
    return { ok: false as const, error: "sessionKey must not be blank" };
  }
  const agentIdOverride = normalizeOptionalString(p.agentId);
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
  const sessionLoadKey = resolveChatSendSessionKey(runtimeConfig, rawSessionKey, requestedAgentId);
  const sessionLoadOptions = { agentId: requestedAgentId };
  const assertRoutingCurrent = captureSessionMutationRouting(runtimeConfig);
  const assertConfigCurrent = () => assertRoutingCurrent(context.getRuntimeConfig());
  const sessionLoadStartedAtMs = performance.now();
  const sessionLoadResult = await measureDiagnosticsTimelineSpan(
    "gateway.chat_send.load_session",
    () =>
      request.stopCommand
        ? loadSessionEntry(sessionLoadKey, sessionLoadOptions, runtimeConfig)
        : withGatewaySessionEntry(
            sessionLoadKey,
            sessionLoadOptions,
            (entry) => entry,
            runtimeConfig,
            assertConfigCurrent,
          ),
    {
      phase: "agent-turn",
      attributes: {
        runId: clientRunId,
        hasAttachments: normalizedAttachments.length > 0,
        hasExplicitOrigin: explicitOrigin !== undefined,
      },
    },
  );
  assertConfigCurrent();
  const preparationFor = (config: OpenClawConfig) =>
    chatSendPreparationConfig(
      config,
      requestedAgentId,
      sessionLoadResult.entry,
      request,
      sessionLoadKey,
    );
  if (
    !isDeepStrictEqual(preparationFor(runtimeConfig), preparationFor(context.getRuntimeConfig()))
  ) {
    throw new Error("Session preparation changed; retry.");
  }
  const sessionLoadMs = roundedChatSendTimingMs(performance.now() - sessionLoadStartedAtMs);
  const { cfg, agentId, storePath, entry, canonicalKey: sessionKey, legacyKey } = sessionLoadResult;
  const expectedSessionRoutingContract = normalizeOptionalString(p.expectedSessionRoutingContract);
  const expectedLeafEntryId =
    p.expectedLeafEntryId === null ? null : normalizeOptionalString(p.expectedLeafEntryId);
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
      ...(request.explicitOrigin ? { preparationOrigin: request.explicitOrigin } : {}),
      storePath,
      ...(sessionLoadResult.readSource ? { readSource: sessionLoadResult.readSource } : {}),
      ...(sessionLoadResult.capturedReadSource
        ? { capturedReadSource: sessionLoadResult.capturedReadSource }
        : {}),
      ...(sessionLoadResult.capturedReadSources
        ? { capturedReadSources: sessionLoadResult.capturedReadSources }
        : {}),
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
export async function prepareChatSendSession(params: {
  isDirectExternalUser?: boolean;
  request: NormalizedChatSendRequest;
  context: GatewayRequestHandlerOptions["context"];
  client: GatewayRequestHandlerOptions["client"];
  assertCurrent?: () => void;
}) {
  const loaded = await loadChatSendSessionContext(params);
  if (!loaded.ok) {
    return loaded;
  }
  const loadedValue = loaded.value;
  const { request, client } = params;
  const { p, explicitOrigin, normalizedAttachments, turnKind, rawMessage } = request;
  const { cfg, agentId, sessionKey, entry, legacyKey } = loadedValue;
  if (isIncognitoSessionKey(sessionKey) && !entry) {
    return { ok: false as const, error: `Incognito session "${sessionKey}" was not found.` };
  }
  const missingHarnessSessionError = resolveMissingAgentHarnessSessionError(sessionKey, entry);
  if (missingHarnessSessionError) {
    return { ok: false as const, error: missingHarnessSessionError };
  }

  const deletedAgent = prepareDeletedAgentSessionCheck({
    cfg,
    sessionKey,
    entry,
    acpMetadataSessionKey: legacyKey,
    assertCurrent: params.assertCurrent,
  });
  const deletedAgentId = deletedAgent instanceof Promise ? await deletedAgent : deletedAgent;
  if (deletedAgent instanceof Promise) {
    params.assertCurrent?.();
  }
  if (deletedAgentId !== null) {
    return {
      ok: false as const,
      error: `Agent "${deletedAgentId}" no longer exists in configuration`,
    };
  }

  const requestedSessionId = normalizeOptionalString(p.sessionId);
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
  const resolvedSessionModel = resolveSessionModelRef(cfg, entry, agentId);
  const resolvedSessionAuthProvider = resolveProviderIdForAuth(resolvedSessionModel.provider, {
    config: cfg,
  });
  const timeoutMs = resolveAgentTimeoutMs({ cfg, overrideMs: p.timeoutMs });
  const now = Date.now();
  const restartSafeRequest = await createRestartSafeChatRequest({
    goalRequestFingerprint: request.goalOperation?.requestFingerprint,
    cfg,
    eligible:
      (isBrowserOperatorUiClient(request.clientInfo) || params.isDirectExternalUser === true) &&
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
      resolvedSessionModel,
      resolvedSessionAuthProvider,
      timeoutMs,
      now,
      restartSafeRequest,
    },
  };
}

export type LoadedChatSendSession = Extract<
  Awaited<ReturnType<typeof prepareChatSendSession>>,
  { ok: true }
>["value"];

export type PreparedChatSendSession = LoadedChatSendSession & {
  sessionTarget: QualifiedSessionEntryAccessTarget;
  assertSessionTargetCurrent: () => void;
  releaseSessionTarget: () => void;
  activeRunScopeKey: string;
  readSource?: CapturedSessionEntryReadSource;
};

export function qualifyChatSendSession(loaded: LoadedChatSendSession): PreparedChatSendSession {
  const qualified = prepareQualifiedSessionEntryTarget(
    {
      ...loaded,
      canonicalKey: loaded.sessionKey,
      requestedKey: loaded.sessionLoadKey,
      storeKey: loaded.legacyKey ?? loaded.sessionKey,
      readSource: loaded.capturedReadSource,
    },
    loaded.capturedReadSources,
  );
  return {
    ...loaded,
    sessionTarget: qualified.target,
    assertSessionTargetCurrent: qualified.assertCurrent,
    releaseSessionTarget: qualified.release,
    activeRunScopeKey: qualified.target.canonicalKey,
    readSource: qualified.target.readSource,
  };
}

/** Validate a worker-prepared admission row against the qualified session source. */
function assertCurrentChatSendSession(
  session: PreparedChatSendSession,
  latest: ReturnType<typeof loadSessionEntry>,
) {
  if (session.sessionRoutingChanged(latest.cfg)) {
    throw new Error(SESSION_ROUTING_CHANGED_ERROR_REASON);
  }
  if (
    latest.agentId !== session.sessionTarget.agentId ||
    (latest.legacyKey ?? latest.canonicalKey) !== session.sessionTarget.storeKey ||
    !isDeepStrictEqual(latest.capturedReadSource, session.sessionTarget.readSource)
  ) {
    throw new Error("Session storage changed while starting work. Retry.");
  }
  session.assertSessionTargetCurrent();
}

export function withCurrentChatSendSession<T>(params: {
  session: PreparedChatSendSession;
  getRuntimeConfig: () => OpenClawConfig;
  includeMembership: boolean;
  consume: Parameters<typeof withGatewaySessionEntry<T>>[2];
}) {
  const { session } = params;
  const assertRoutingCurrent = captureSessionMutationRouting(session.cfg);
  const preparationRequest = { explicitOrigin: session.preparationOrigin };
  const preparationConfig = chatSendPreparationConfig(
    session.cfg,
    session.agentId,
    session.entry,
    preparationRequest,
    session.sessionKey,
  );
  const assertConfigCurrent = () => {
    const currentConfig = params.getRuntimeConfig();
    assertRoutingCurrent(currentConfig);
    if (session.sessionRoutingChanged(currentConfig)) {
      throw new Error(SESSION_ROUTING_CHANGED_ERROR_REASON);
    }
    if (
      !isDeepStrictEqual(
        preparationConfig,
        chatSendPreparationConfig(
          currentConfig,
          session.agentId,
          session.entry,
          preparationRequest,
          session.sessionKey,
        ),
      )
    ) {
      throw new Error("Session preparation changed; retry.");
    }
  };
  const consume: typeof params.consume = (latest, membership, assertSourceCurrent) => {
    assertCurrentChatSendSession(session, latest);
    return params.consume(latest, membership, assertSourceCurrent);
  };
  if (isIncognitoSessionKey(session.sessionKey)) {
    return withGatewaySessionEntry(
      session.sessionLoadKey,
      { ...session.sessionLoadOptions, includeMembership: params.includeMembership },
      consume,
      session.cfg,
      assertConfigCurrent,
    );
  }
  return withQualifiedGatewaySessionEntry({
    cfg: session.cfg,
    target: session.sessionTarget,
    logicalStorePath: session.storePath,
    includeMembership: params.includeMembership,
    consume,
    assertConfigCurrent,
  });
}

/** Refuse before send admission so confirmation can retain the unsent composer. */
export async function prepareChatSendNativeRuntimeRestriction(params: {
  request: NormalizedChatSendRequest;
  session: PreparedChatSendSession;
  client: GatewayRequestHandlerOptions["client"];
  context: GatewayRequestHandlerOptions["context"];
  assertCurrent?: () => void;
  assertCurrentAsync?: () => Promise<void>;
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
  const restrictionFor = (
    config: OpenClawConfig,
    selectedEntry: Parameters<typeof resolveSessionNativeRuntimeRestriction>[0]["entry"],
    model: typeof resolvedSessionModel,
    persistedEntry?: SessionEntry,
  ) =>
    resolveSessionNativeRuntimeRestriction({
      operation: "send",
      cfg: config,
      agentId,
      sessionKey,
      entry: selectedEntry,
      persistedEntry,
      harness,
      provider: model.provider,
      modelId: model.model,
      callerCanConsent: hasGatewayAdminScope(client),
    });
  const creation = resolveOperatorSessionCreation(client);
  const prospectiveEntry =
    entry ??
    buildSessionCreationStamp({
      ...creation,
      sandbox: resolveCreatorSandbox(cfg, creation),
      now: session.now,
    });
  const restriction = restrictionFor(cfg, prospectiveEntry, resolvedSessionModel, entry);
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
  await (params.assertCurrentAsync ? params.assertCurrentAsync() : params.assertCurrent?.());
  const scope = { agentId, sessionKey, storePath: session.storePath };
  const snapshot = await loadReplySessionInitializationSnapshot(scope);
  await (params.assertCurrentAsync ? params.assertCurrentAsync() : params.assertCurrent?.());
  const sessionChanged = () =>
    errorShape(ErrorCodes.INVALID_REQUEST, "Session changed before native confirmation. Retry.");
  if (snapshot.currentEntry) {
    return sessionChanged();
  }
  const prepared = await prepareChatSendSessionEntry({
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
      session.assertSessionTargetCurrent();
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
        restrictionFor(currentConfig, prepared.entry, currentModel)?.details,
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
    return sessionChanged();
  }
  await recordSessionCreated(cfg, { agentId, sessionKey, entry: committed.sessionEntry });
  emitSessionsChanged(context, { agentId, sessionKey, reason: "create" });
  return restrictionFor(
    context.getRuntimeConfig(),
    committed.sessionEntry,
    resolvedSessionModel,
    committed.sessionEntry,
  );
}
