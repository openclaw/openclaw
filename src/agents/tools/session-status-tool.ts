import { readStringValue } from "@openclaw/normalization-core/string-coerce";
import { Type, type Static } from "typebox";
import type {
  ElevatedLevel,
  ReasoningLevel,
  ThinkLevel,
  VerboseLevel,
} from "../../auto-reply/thinking.js";
import { resolveSessionStorePathCore, type SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import {
  buildAgentMainSessionKey,
  isIncognitoSessionKey,
  parseAgentSessionKey,
  resolveAgentIdFromSessionKey,
} from "../../routing/session-key.js";
import {
  getSessionStateVersion,
  listSessionStateEventsSince,
} from "../../sessions/session-state-events.js";
import { createLazyPromise } from "../../shared/lazy-promise.js";
import {
  deliveryContextFromSession,
  sessionDeliveryChannel,
  sessionDeliveryOrigin,
  type DeliveryContext,
} from "../../utils/delivery-context.read.js";
import { normalizeDeliveryContext } from "../../utils/delivery-context.shared.js";
import {
  isDeliverableMessageChannel,
  normalizeMessageChannel,
} from "../../utils/message-channel.js";
import {
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  resolveSessionAgentIds,
} from "../agent-scope.js";
import { resolveDefaultModelForAgent } from "../model-selection.js";
import { resolveThinkingDefault } from "../model-thinking-default.js";
import { loadPublishedPreparedModelCatalog } from "../prepared-model-catalog.js";
import { resolveSessionModelIdentityRef } from "../session-model-ref.js";
import {
  describeSessionStatusTool,
  SESSION_STATUS_TOOL_DISPLAY_SUMMARY,
} from "../tool-description-presets.js";
import type { AnyAgentTool } from "./common.js";
import { readNonNegativeIntegerParam, readToolStringParam } from "./common.js";
import {
  callAgentToolGatewayRequest,
  hasGatewayToolRoutingContext,
  type AgentToolGatewayRequestCaller,
} from "./in-process-gateway.js";
import {
  resolveSessionToolTargetAgentId,
  runWithScopedSessionAccess,
} from "./scoped-session-access.js";
import { patchSessionStatusModel } from "./session-status-model.js";
import {
  listImplicitDefaultDirectFallbackKeys,
  resolveImplicitCurrentSessionFallback,
  resolveSessionStatusEntry,
  resolveStoreScopedRequesterKey,
} from "./session-status-session-resolve.js";
import {
  formatSessionToolAccessDenial,
  resolveCurrentSessionClientAlias,
  resolveSessionReference,
  resolveSessionToolAccess,
  resolveSessionToolContext,
  resolveVisibleSessionReference,
  shouldResolveSessionIdInput,
} from "./sessions-helpers.js";

const SessionStatusToolSchema = Type.Object({
  sessionKey: Type.Optional(Type.String()),
  model: Type.Optional(Type.String()),
  changesSince: Type.Optional(Type.Integer({ minimum: 0 })),
});

const SessionStatusOriginSchema = Type.Object(
  {
    provider: Type.Optional(Type.String()),
    accountId: Type.Optional(Type.String()),
    threadId: Type.Optional(Type.Union([Type.String(), Type.Number()])),
  },
  { additionalProperties: false },
);

const SessionStatusDeliveryContextSchema = Type.Object(
  {
    channel: Type.Optional(Type.String()),
    to: Type.Optional(Type.String()),
    accountId: Type.Optional(Type.String()),
    threadId: Type.Optional(Type.Union([Type.String(), Type.Number()])),
  },
  { additionalProperties: false },
);

const SessionStatusStateEventPayloadSchema = Type.Object(
  {
    outcome: Type.Optional(
      Type.Union([Type.Literal("error"), Type.Literal("timeout"), Type.Literal("cancelled")]),
    ),
    channel: Type.Optional(Type.String()),
    turns: Type.Optional(Type.Integer({ minimum: 1 })),
  },
  { additionalProperties: false },
);

const SessionStatusStateEventSchema = Type.Object(
  {
    sequence: Type.Integer(),
    kind: Type.String(),
    actorType: Type.Union([Type.Literal("human"), Type.Literal("agent"), Type.Literal("system")]),
    occurredAt: Type.Number(),
    summary: Type.String(),
    actorId: Type.Optional(Type.String()),
    runId: Type.Optional(Type.String()),
    payload: Type.Optional(SessionStatusStateEventPayloadSchema),
  },
  { additionalProperties: false },
);

const SessionStatusOutputSchema = Type.Object(
  {
    ok: Type.Literal(true),
    sessionKey: Type.String(),
    agentId: Type.String(),
    changedModel: Type.Boolean(),
    stateVersion: Type.Integer(),
    statusText: Type.String(),
    stateChanges: Type.Optional(
      Type.Object(
        {
          events: Type.Array(SessionStatusStateEventSchema),
          truncated: Type.Boolean(),
          earliestAvailableSequence: Type.Integer(),
          historyGap: Type.Boolean(),
        },
        { additionalProperties: false },
      ),
    ),
    model: Type.Optional(Type.String()),
    modelProvider: Type.Optional(Type.String()),
    modelOverride: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    origin: Type.Optional(SessionStatusOriginSchema),
    active: Type.Optional(SessionStatusDeliveryContextSchema),
    deliveryContext: Type.Optional(SessionStatusDeliveryContextSchema),
  },
  { additionalProperties: false },
);

type SessionStatusStateChanges = ReturnType<typeof listSessionStateEventsSince>;

function compactSessionStateEventPayload(
  payload: Record<string, unknown> | undefined,
): { outcome?: "error" | "timeout" | "cancelled"; channel?: string; turns?: number } | undefined {
  if (!payload) {
    return undefined;
  }
  const outcome =
    payload.outcome === "error" || payload.outcome === "timeout" || payload.outcome === "cancelled"
      ? payload.outcome
      : undefined;
  const channel = readStringValue(payload.channel);
  const turns =
    typeof payload.turns === "number" && Number.isSafeInteger(payload.turns) && payload.turns > 0
      ? payload.turns
      : undefined;
  return outcome || channel || turns !== undefined
    ? {
        ...(outcome ? { outcome } : {}),
        ...(channel ? { channel } : {}),
        ...(turns !== undefined ? { turns } : {}),
      }
    : undefined;
}

function compactSessionStateChanges(stateChanges: SessionStatusStateChanges) {
  return {
    ...stateChanges,
    events: stateChanges.events.map((event) => {
      const payload = compactSessionStateEventPayload(event.payload);
      return {
        sequence: event.sequence,
        kind: event.kind,
        actorType: event.actorType,
        occurredAt: event.occurredAt,
        summary: event.summary,
        ...(event.actorId ? { actorId: event.actorId } : {}),
        ...(event.runId ? { runId: event.runId } : {}),
        ...(payload ? { payload } : {}),
      };
    }),
  };
}

const loadCommandsStatusRuntime = createLazyPromise(() => import("../../status/status-text.js"));

type ActiveStatusModelIdentity = { provider?: string; model: string };

type SessionStatusOriginDetails = Static<typeof SessionStatusOriginSchema>;
type SessionStatusDeliveryContextDetails = Static<typeof SessionStatusDeliveryContextSchema>;

type SessionStatusRouteDetails = {
  origin?: SessionStatusOriginDetails;
  active?: SessionStatusDeliveryContextDetails;
  deliveryContext?: SessionStatusDeliveryContextDetails;
};

const INTERNAL_SESSION_KEY_ORIGIN_PREFIXES = new Set(["main", "cron", "subagent", "acp"]);

function readRouteThreadId(value: unknown): string | number | undefined {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return undefined;
}

function compactOriginDetails(
  params: SessionStatusOriginDetails,
): SessionStatusOriginDetails | undefined {
  const threadId = readRouteThreadId(params.threadId);
  const details: SessionStatusOriginDetails = {
    ...(params.provider ? { provider: params.provider } : {}),
    ...(params.accountId ? { accountId: params.accountId } : {}),
    ...(threadId !== undefined ? { threadId } : {}),
  };
  return Object.keys(details).length ? details : undefined;
}

function compactDeliveryContextDetails(
  params: SessionStatusDeliveryContextDetails,
): SessionStatusDeliveryContextDetails | undefined {
  const threadId = readRouteThreadId(params.threadId);
  const details: SessionStatusDeliveryContextDetails = {
    ...(params.channel ? { channel: params.channel } : {}),
    ...(params.to ? { to: params.to } : {}),
    ...(params.accountId ? { accountId: params.accountId } : {}),
    ...(threadId !== undefined ? { threadId } : {}),
  };
  return Object.keys(details).length ? details : undefined;
}

function normalizeStatusDeliveryContext(
  context?: DeliveryContext,
): SessionStatusDeliveryContextDetails | undefined {
  return compactDeliveryContextDetails({
    channel: readStringValue(context?.channel),
    to: readStringValue(context?.to),
    accountId: readStringValue(context?.accountId),
    threadId: context?.threadId,
  });
}

function normalizeActiveDeliveryContext(
  context?: DeliveryContext,
): SessionStatusDeliveryContextDetails | undefined {
  if (!context) {
    return undefined;
  }
  const normalized = normalizeDeliveryContext(context);
  const rawChannel = readStringValue(normalized?.channel) ?? readStringValue(context.channel);
  const channel = rawChannel ? (normalizeMessageChannel(rawChannel) ?? rawChannel) : undefined;
  return compactDeliveryContextDetails({
    channel,
    to: readStringValue(normalized?.to) ?? readStringValue(context.to),
    accountId: readStringValue(normalized?.accountId) ?? readStringValue(context.accountId),
    threadId: normalized?.threadId ?? context.threadId,
  });
}

function inferOriginProviderFromSessionKey(sessionKey: string): string | undefined {
  const parsed = parseAgentSessionKey(sessionKey);
  const head = readStringValue(parsed?.rest.split(":")[0]);
  if (!head || INTERNAL_SESSION_KEY_ORIGIN_PREFIXES.has(head.toLowerCase())) {
    return undefined;
  }
  const channel = normalizeMessageChannel(head);
  return channel && isDeliverableMessageChannel(channel) ? channel : undefined;
}

function buildSessionStatusRouteDetails(params: {
  entry: SessionEntry;
  sessionKey: string;
  activeDeliveryContext?: DeliveryContext;
  isLiveRunSession?: boolean;
}): SessionStatusRouteDetails {
  const origin = compactOriginDetails({
    provider:
      readStringValue(sessionDeliveryOrigin(params.entry)?.provider) ??
      inferOriginProviderFromSessionKey(params.sessionKey),
    accountId: readStringValue(sessionDeliveryOrigin(params.entry)?.accountId),
    threadId: sessionDeliveryOrigin(params.entry)?.threadId,
  });
  const deliveryContext = normalizeStatusDeliveryContext(deliveryContextFromSession(params.entry));
  const active = params.isLiveRunSession
    ? normalizeActiveDeliveryContext(params.activeDeliveryContext)
    : undefined;

  return {
    ...(origin ? { origin } : {}),
    ...(active ? { active } : {}),
    ...(deliveryContext ? { deliveryContext } : {}),
  };
}

function formatSessionStatusRouteContext(details: SessionStatusRouteDetails): string | undefined {
  if (Object.keys(details).length === 0) {
    return undefined;
  }
  return `Route context:
\`\`\`json
${JSON.stringify(details, null, 2)}
\`\`\``;
}

function formatSessionStateChanges(details: {
  stateVersion: number;
  stateChanges: ReturnType<typeof compactSessionStateChanges>;
}): string {
  return `Session state changes:
\`\`\`json
${JSON.stringify(details, null, 2)}
\`\`\``;
}

function resolveActiveStatusModelIdentity(params: {
  activeModelId?: string;
  activeModelProvider?: string;
  isImplicitCurrentRequest: boolean;
  isSemanticCurrentRequest: boolean;
  liveSessionKeys: ReadonlySet<string>;
  modelRaw?: string;
  resolvedKey: string;
  resolvedAgentId: string;
  requesterAgentId: string;
}): ActiveStatusModelIdentity | undefined {
  const activeModelId = params.activeModelId?.trim();
  if (!activeModelId || params.modelRaw !== undefined) {
    return undefined;
  }
  if (!params.isSemanticCurrentRequest && !params.isImplicitCurrentRequest) {
    return undefined;
  }
  if (params.resolvedAgentId !== params.requesterAgentId) {
    return undefined;
  }
  if (!params.liveSessionKeys.has(params.resolvedKey.trim())) {
    return undefined;
  }
  const activeModelProvider = params.activeModelProvider?.trim();
  return activeModelProvider
    ? { provider: activeModelProvider, model: activeModelId }
    : { model: activeModelId };
}

function withActiveStatusModelIdentity(
  entry: SessionEntry,
  identity: ActiveStatusModelIdentity,
): SessionEntry {
  const next: SessionEntry = {
    ...entry,
    model: identity.model,
    ...(identity.provider ? { modelProvider: identity.provider } : {}),
  };
  delete next.providerOverride;
  delete next.modelOverride;
  delete next.modelOverrideSource;
  delete next.modelOverrideRouteResolution;
  return next;
}

export function createSessionStatusTool(opts?: {
  agentSessionKey?: string;
  requesterAgentIdOverride?: string;
  /**
   * The actual live run session key. When the tool is constructed with a sandbox/policy
   * session key (e.g. a Telegram direct peer key), this allows `session_status({sessionKey:
   * "current"})` to resolve to the live run session instead of the stale sandbox key.
   */
  runSessionKey?: string;
  config?: OpenClawConfig;
  sandboxed?: boolean;
  activeModelProvider?: string;
  activeModelId?: string;
  metadataSnapshot?: PluginMetadataSnapshot;
  callGateway?: AgentToolGatewayRequestCaller;
  /** Active live-run route, kept separate from the persisted/origin delivery route. */
  activeDeliveryContext?: DeliveryContext;
}): AnyAgentTool {
  return {
    label: "Session Status",
    name: "session_status",
    displaySummary: SESSION_STATUS_TOOL_DISPLAY_SUMMARY,
    description: describeSessionStatusTool(),
    parameters: SessionStatusToolSchema,
    outputSchema: SessionStatusOutputSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const gatewayCall = opts?.callGateway ?? callAgentToolGatewayRequest;
      const gatewayScoped = opts?.callGateway !== undefined || hasGatewayToolRoutingContext();
      const changesSince = readNonNegativeIntegerParam(params, "changesSince");
      const {
        cfg,
        mainKey,
        alias,
        effectiveRequesterKey,
        mainSessionKey,
        restrictToSpawned,
        sessionVisibility,
        a2aPolicy,
      } = resolveSessionToolContext(opts);
      const requesterAgentId = resolveSessionAgentIds({
        config: cfg,
        sessionKey: opts?.agentSessionKey ?? effectiveRequesterKey,
        agentId: opts?.requesterAgentIdOverride,
      }).sessionAgentId;
      const visibilityRequesterKey = (opts?.agentSessionKey ?? effectiveRequesterKey).trim();
      const usesLegacyMainAlias = alias === mainKey;
      const isLegacyMainVisibilityKey = (sessionKey: string) => {
        const trimmed = sessionKey.trim();
        return usesLegacyMainAlias && (trimmed === "main" || trimmed === mainKey);
      };
      const resolveVisibilityMainSessionKey = (sessionAgentId: string) => {
        const requesterParsed = parseAgentSessionKey(visibilityRequesterKey);
        if (
          resolveAgentIdFromSessionKey(visibilityRequesterKey, requesterAgentId) ===
            sessionAgentId &&
          (requesterParsed?.rest === mainKey || isLegacyMainVisibilityKey(visibilityRequesterKey))
        ) {
          return visibilityRequesterKey;
        }
        return buildAgentMainSessionKey({
          agentId: sessionAgentId,
          mainKey,
        });
      };
      const normalizeVisibilityTargetSessionKey = (sessionKey: string, sessionAgentId: string) => {
        const trimmed = sessionKey.trim();
        if (!trimmed) {
          return trimmed;
        }
        if (trimmed.startsWith("agent:")) {
          const parsed = parseAgentSessionKey(trimmed);
          if (parsed?.rest === mainKey) {
            return resolveVisibilityMainSessionKey(sessionAgentId);
          }
          return trimmed;
        }
        // Preserve legacy bare main keys for requester tree checks.
        if (isLegacyMainVisibilityKey(trimmed)) {
          return resolveVisibilityMainSessionKey(sessionAgentId);
        }
        return trimmed;
      };
      const accessByTarget = new Map<
        string,
        Awaited<ReturnType<typeof resolveSessionToolAccess>>
      >();
      const requireVisibilityAccess = async (
        target: {
          targetSessionKey: string;
          targetAgentId: string;
          authorizationTargetSessionKey: string;
          requesterOwned: boolean;
        },
        displayKey = target.targetSessionKey,
      ) => {
        const cacheKey = `${target.requesterOwned ? "owned" : "unowned"}:${target.targetAgentId}:${target.targetSessionKey}:${target.authorizationTargetSessionKey}`;
        const access =
          accessByTarget.get(cacheKey) ??
          (await resolveSessionToolAccess({
            ...target,
            action: "status",
            requesterAgentId,
            requesterSessionKey: visibilityRequesterKey,
            mainSessionKey,
            visibility: sessionVisibility,
            a2aPolicy,
            callGateway: gatewayCall,
          }));
        accessByTarget.set(cacheKey, access);
        if (!access.allowed) {
          throw new Error(
            formatSessionToolAccessDenial(access, {
              action: "status",
              targetSessionKey: displayKey,
            }),
          );
        }
        return access;
      };

      const requestedKeyParam = readToolStringParam(params, "sessionKey");
      const isImplicitRunSessionStatus =
        requestedKeyParam === undefined && Boolean(opts?.runSessionKey?.trim());
      let requestedKeyRaw = requestedKeyParam ?? opts?.agentSessionKey;

      // No-arg status should prefer the live run session when available (#82669).
      if (isImplicitRunSessionStatus) {
        requestedKeyRaw = opts?.runSessionKey;
      }
      let requestedKeyInput = requestedKeyRaw?.trim() ?? "";

      // Track whether this is a semantic-current request (literal "current" or a
      // current-client alias) BEFORE any rewrite, so visibility treats it as self.
      const isSemanticCurrentRequest =
        requestedKeyInput === "current" ||
        isImplicitRunSessionStatus ||
        Boolean(
          resolveCurrentSessionClientAlias({
            key: requestedKeyInput,
            requesterInternalKey: effectiveRequesterKey,
          }),
        );

      // Resolve semantic "current" to the live run session key for lookup purposes (#76708).
      // In sandboxed channel runs there may be no separate runSessionKey because the sandbox
      // key already is the live requester; avoid probing literal "current" through the gateway.
      if (requestedKeyInput === "current" && (opts?.runSessionKey || opts?.sandboxed === true)) {
        requestedKeyRaw = opts.runSessionKey ?? effectiveRequesterKey;
        requestedKeyInput = requestedKeyRaw?.trim() ?? "";
      }

      const currentSessionAlias = resolveCurrentSessionClientAlias({
        key: requestedKeyInput,
        requesterInternalKey: effectiveRequesterKey,
      });
      if (currentSessionAlias) {
        requestedKeyRaw = opts?.runSessionKey ?? currentSessionAlias;
        requestedKeyInput = requestedKeyRaw?.trim() ?? "";
      }
      const effectiveRequesterLookupKey = effectiveRequesterKey.trim();
      let resolvedViaSessionId = false;
      let resolvedViaImplicitCurrentFallback = false;
      if (!requestedKeyInput) {
        throw new Error("sessionKey required");
      }
      requestedKeyRaw = requestedKeyInput;
      let resolvedRequesterOwned = false;

      const deferTargetOwnerResolution =
        !isSemanticCurrentRequest && shouldResolveSessionIdInput(requestedKeyInput);
      let agentId = deferTargetOwnerResolution
        ? requesterAgentId
        : resolveSessionToolTargetAgentId({
            cfg,
            targetSessionKey: requestedKeyInput,
            requesterAgentId,
          });
      // Semantic current is self for ordinary visibility, but its live-run key can
      // still be process-only. Preserve that target for the shared guard before storage.
      const mustCheckRequestedKeyBeforeStore =
        !isSemanticCurrentRequest || isIncognitoSessionKey(requestedKeyInput);
      if (mustCheckRequestedKeyBeforeStore && !deferTargetOwnerResolution) {
        await requireVisibilityAccess({
          targetSessionKey: requestedKeyInput,
          targetAgentId: agentId,
          authorizationTargetSessionKey: normalizeVisibilityTargetSessionKey(
            requestedKeyInput,
            agentId,
          ),
          requesterOwned: false,
        });
      }
      let storePath = resolveSessionStorePathCore(cfg.session?.store, { agentId });
      let storeScopedRequesterKey = resolveStoreScopedRequesterKey({
        requesterKey: effectiveRequesterKey,
        agentId,
        mainKey,
      });

      const readStatusEntry = (keyRaw: string, includeAliasFallback?: boolean) =>
        resolveSessionStatusEntry({
          cfg,
          agentId,
          keyRaw,
          alias,
          mainKey,
          requesterInternalKey: storeScopedRequesterKey,
          includeAliasFallback,
        });

      // Resolve against the requester-scoped store first to avoid leaking default agent data.
      let resolved = deferTargetOwnerResolution
        ? undefined
        : readStatusEntry(requestedKeyRaw, requestedKeyInput !== "current");

      if (
        !resolved &&
        (requestedKeyInput === "current" || shouldResolveSessionIdInput(requestedKeyInput))
      ) {
        const resolvedSession = await resolveSessionReference({
          action: "status",
          sessionKey: requestedKeyInput,
          ...(requestedKeyInput === "current" ? { agentId: requesterAgentId } : {}),
          keyAgentId: requesterAgentId,
          alias,
          mainKey,
          requesterInternalKey: effectiveRequesterKey,
          restrictToSpawned,
          callGateway: gatewayCall,
        });
        if (resolvedSession.ok) {
          const visibleSession = await resolveVisibleSessionReference({
            action: "status",
            resolvedSession,
            requesterSessionKey: effectiveRequesterKey,
            requesterAgentId,
            restrictToSpawned: opts?.sandboxed === true,
            visibilitySessionKey: requestedKeyInput,
            callGateway: gatewayCall,
          });
          if (!visibleSession.ok) {
            // The resolver's copy already names the denying policy (including the
            // watched-group carve-out); a local string here would drift from it.
            throw new Error(visibleSession.error);
          }
          const visibleAgentId = resolveSessionToolTargetAgentId({
            cfg,
            targetSessionKey: visibleSession.key,
            resolvedAgentId: visibleSession.agentId,
            requesterAgentId,
          });
          if (opts?.sandboxed === true || visibleAgentId !== requesterAgentId) {
            await requireVisibilityAccess(
              {
                targetSessionKey: visibleSession.key,
                targetAgentId: visibleAgentId,
                authorizationTargetSessionKey: normalizeVisibilityTargetSessionKey(
                  visibleSession.key,
                  visibleAgentId,
                ),
                requesterOwned: visibleSession.requesterOwned,
              },
              visibleSession.displayKey,
            );
          }
          resolvedRequesterOwned = visibleSession.requesterOwned;
          resolvedViaSessionId = resolvedSession.resolvedViaSessionId;
          requestedKeyRaw = visibleSession.key;
          requestedKeyInput = requestedKeyRaw.trim();
          agentId = visibleAgentId;
          storePath = resolveSessionStorePathCore(cfg.session?.store, { agentId });
          storeScopedRequesterKey = resolveStoreScopedRequesterKey({
            requesterKey: effectiveRequesterKey,
            agentId,
            mainKey,
          });
          resolved = readStatusEntry(requestedKeyRaw);
        } else if (!resolvedSession.notFound || resolvedSession.status === "forbidden") {
          throw new Error(resolvedSession.error);
        }
      }

      if (!resolved && requestedKeyInput === "current" && effectiveRequesterLookupKey) {
        resolved = readStatusEntry(effectiveRequesterLookupKey, false);
      }

      if (!resolved && requestedKeyInput === "current") {
        resolved = readStatusEntry(requestedKeyRaw, true);
      }

      if (!resolved && requestedKeyParam === undefined) {
        for (const fallbackKey of listImplicitDefaultDirectFallbackKeys({
          keyRaw: requestedKeyRaw,
          mainKey,
        })) {
          resolved = readStatusEntry(fallbackKey, true);
          if (resolved) {
            resolvedViaImplicitCurrentFallback = true;
            break;
          }
        }
      }

      if (!resolved) {
        const runSessionFallbackKey = opts?.runSessionKey?.trim();
        const fallback = resolveImplicitCurrentSessionFallback({
          agentId,
          allowFallback: isSemanticCurrentRequest || requestedKeyParam === undefined,
          cfg,
          fallbackKey:
            (isSemanticCurrentRequest || isImplicitRunSessionStatus) && runSessionFallbackKey
              ? runSessionFallbackKey
              : isSemanticCurrentRequest
                ? effectiveRequesterLookupKey
                : storeScopedRequesterKey,
        });
        if (fallback) {
          resolved = fallback;
          resolvedViaImplicitCurrentFallback = true;
        }
      }

      if (!resolved) {
        const kind = shouldResolveSessionIdInput(requestedKeyInput) ? "sessionId" : "sessionKey";
        throw new Error(`Unknown ${kind}: ${requestedKeyInput}`);
      }

      // Preserve caller-scoped raw-key/current lookups as "self" for visibility checks.
      const shouldTreatVisibilityTargetAsSelf =
        isSemanticCurrentRequest ||
        resolvedViaImplicitCurrentFallback ||
        (!resolvedViaSessionId &&
          (requestedKeyInput === "current" ||
            (resolved.key === requestedKeyInput && agentId === requesterAgentId)));
      const visibilityTargetKey =
        shouldTreatVisibilityTargetAsSelf && !isIncognitoSessionKey(resolved.key)
          ? visibilityRequesterKey
          : normalizeVisibilityTargetSessionKey(resolved.key, agentId);
      const access = await requireVisibilityAccess(
        {
          targetSessionKey: resolved.key,
          targetAgentId: agentId,
          authorizationTargetSessionKey: visibilityTargetKey,
          requesterOwned: resolvedRequesterOwned,
        },
        requestedKeyInput,
      );
      let scopedResolved = resolved;

      return await runWithScopedSessionAccess({
        cfg,
        agentId,
        expectedSessionId: access.expectedSessionId,
        targetSessionKey: scopedResolved.key,
        run: async () => {
          const configured = resolveDefaultModelForAgent({ cfg, agentId });
          const selectedAgentDir = resolveAgentDir(cfg, agentId);
          const selectedWorkspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
          const modelRaw = readToolStringParam(params, "model");
          let changedModel = false;
          if (typeof modelRaw === "string") {
            const patched = await patchSessionStatusModel({
              cfg,
              agentId,
              agentDir: selectedAgentDir,
              workspaceDir: selectedWorkspaceDir,
              storePath,
              raw: modelRaw,
              resolved: scopedResolved,
              metadataSnapshot: opts?.metadataSnapshot,
              gatewayCall: gatewayScoped ? gatewayCall : undefined,
            });
            scopedResolved = patched.resolved;
            changedModel = patched.changedModel;
          }

          const isImplicitCurrentRequest = requestedKeyParam === undefined;
          const liveSessionKeys = new Set(
            [
              opts?.runSessionKey,
              storeScopedRequesterKey,
              effectiveRequesterKey,
              visibilityRequesterKey,
            ]
              .map((value) => value?.trim())
              .filter((value): value is string => Boolean(value)),
          );
          const activeModelIdentity = resolveActiveStatusModelIdentity({
            activeModelId: opts?.activeModelId,
            activeModelProvider: opts?.activeModelProvider,
            isImplicitCurrentRequest,
            isSemanticCurrentRequest,
            liveSessionKeys,
            modelRaw,
            resolvedKey: scopedResolved.key,
            resolvedAgentId: agentId,
            requesterAgentId,
          });
          const runtimeModelIdentity =
            activeModelIdentity ??
            resolveSessionModelIdentityRef(
              cfg,
              scopedResolved.entry,
              agentId,
              `${configured.provider}/${configured.model}`,
            );
          const hasExplicitModelOverride = Boolean(
            !activeModelIdentity &&
            (scopedResolved.entry.providerOverride?.trim() ||
              scopedResolved.entry.modelOverride?.trim()),
          );
          const runtimeProviderForCard = runtimeModelIdentity.provider?.trim();
          const runtimeModelForCard = runtimeModelIdentity.model.trim();
          const defaultProviderForCard = hasExplicitModelOverride
            ? configured.provider
            : (runtimeProviderForCard ?? "");
          const defaultModelForCard = hasExplicitModelOverride
            ? configured.model
            : runtimeModelForCard || configured.model;
          const statusSessionEntry = activeModelIdentity
            ? withActiveStatusModelIdentity(scopedResolved.entry, activeModelIdentity)
            : !hasExplicitModelOverride && !runtimeProviderForCard && runtimeModelForCard
              ? { ...scopedResolved.entry, providerOverride: "" }
              : scopedResolved.entry;
          const providerOverrideForCard = statusSessionEntry.providerOverride?.trim();
          const providerForCard = providerOverrideForCard ?? defaultProviderForCard;
          const primaryModelLabel =
            providerForCard && defaultModelForCard
              ? `${providerForCard}/${defaultModelForCard}`
              : defaultModelForCard;
          const isGroup =
            statusSessionEntry.chatType === "group" ||
            statusSessionEntry.chatType === "channel" ||
            scopedResolved.key.includes(":group:") ||
            scopedResolved.key.includes(":channel:");
          // Tool status may read persisted/configured facts, but must not start provider discovery.
          const thinkingCatalog = await loadPublishedPreparedModelCatalog({
            config: cfg,
            agentId,
            agentDir: selectedAgentDir,
            readOnly: true,
            ...(statusSessionEntry.spawnedWorkspaceDir
              ? { workspaceDir: statusSessionEntry.spawnedWorkspaceDir }
              : {}),
          });
          const { buildStatusText } = await loadCommandsStatusRuntime();
          const statusText = await buildStatusText({
            cfg,
            agentId,
            sessionEntry: statusSessionEntry,
            sessionKey: scopedResolved.key,
            parentSessionKey: statusSessionEntry.parentSessionKey,
            sessionScope: cfg.session?.scope,
            storePath,
            statusChannel: sessionDeliveryChannel(statusSessionEntry) ?? "unknown",
            workspaceDir: statusSessionEntry.spawnedWorkspaceDir,
            provider: providerForCard,
            model: defaultModelForCard,
            thinkingCatalog,
            resolvedThinkLevel: statusSessionEntry.thinkingLevel as ThinkLevel | undefined,
            resolvedFastMode: statusSessionEntry.fastMode,
            resolvedVerboseLevel: (statusSessionEntry.verboseLevel ?? "off") as VerboseLevel,
            resolvedReasoningLevel: (statusSessionEntry.reasoningLevel ?? "off") as ReasoningLevel,
            resolvedElevatedLevel: statusSessionEntry.elevatedLevel as ElevatedLevel | undefined,
            resolveDefaultThinkingLevel: async (selection) =>
              resolveThinkingDefault({
                cfg,
                agentId,
                provider: selection?.provider ?? providerForCard,
                model: selection?.model ?? defaultModelForCard,
                agentRuntime: selection?.agentRuntime,
                catalog: thinkingCatalog,
              }),
            isGroup,
            defaultGroupActivation: () => "mention",
            primaryModelLabelOverride: primaryModelLabel,
            ...(providerForCard ? {} : { modelAuthOverride: undefined }),
            includeTranscriptUsage: true,
          });
          const fullStatusText = statusText;
          const resultOverrideProvider = statusSessionEntry.providerOverride?.trim();
          const resultOverrideModel = statusSessionEntry.modelOverride?.trim();
          const activeRouteRunSessionKey = opts?.runSessionKey?.trim();
          const isLiveRouteSession = activeRouteRunSessionKey
            ? agentId === requesterAgentId && scopedResolved.key.trim() === activeRouteRunSessionKey
            : agentId === requesterAgentId && liveSessionKeys.has(scopedResolved.key.trim());
          const routeDetails = buildSessionStatusRouteDetails({
            entry: statusSessionEntry,
            sessionKey: scopedResolved.key,
            activeDeliveryContext: opts?.activeDeliveryContext,
            isLiveRunSession: isLiveRouteSession,
          });
          const routeContextText = formatSessionStatusRouteContext(routeDetails);
          const stateVersion = getSessionStateVersion(scopedResolved.key, agentId);
          const rawStateChanges =
            changesSince !== undefined
              ? listSessionStateEventsSince(scopedResolved.key, agentId, changesSince, 200)
              : undefined;
          const stateChanges = rawStateChanges
            ? compactSessionStateChanges(rawStateChanges)
            : undefined;
          const extraBlocks = [
            routeContextText,
            stateChanges ? formatSessionStateChanges({ stateVersion, stateChanges }) : undefined,
          ].filter((block): block is string => Boolean(block));
          const visibleStatusText =
            extraBlocks.length > 0
              ? `${fullStatusText}\n\n${extraBlocks.join("\n\n")}`
              : fullStatusText;
          const modelOverrideForResult =
            modelRaw === undefined
              ? undefined
              : resultOverrideModel
                ? resultOverrideProvider
                  ? `${resultOverrideProvider}/${resultOverrideModel}`
                  : resultOverrideModel
                : null;

          return {
            content: [{ type: "text", text: visibleStatusText }],
            details: {
              ok: true,
              sessionKey: scopedResolved.key,
              agentId,
              changedModel,
              stateVersion,
              ...(stateChanges ? { stateChanges } : {}),
              ...(modelRaw !== undefined
                ? {
                    model: resultOverrideModel ?? defaultModelForCard,
                    ...((resultOverrideProvider ?? providerForCard)
                      ? { modelProvider: resultOverrideProvider ?? providerForCard }
                      : {}),
                    modelOverride: modelOverrideForResult,
                  }
                : {}),
              statusText: visibleStatusText,
              ...routeDetails,
            },
          };
        },
      });
    },
  };
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
