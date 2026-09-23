/**
 * sessions_send built-in tool.
 *
 * Sends messages to visible sessions, starts embedded runs, and optionally announces replies.
 */
import crypto from "node:crypto";
import { isRequesterParentOfBackgroundAcpSession } from "@openclaw/acp-core/session-interaction-mode";
import { finiteSecondsToTimerSafeMilliseconds } from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { Type } from "typebox";
import { tryResolveLegacyCompatibilityAgentId } from "../../config/legacy.default-agent-owner.js";
import { resolvePersistedSessionStoreOwnerForKey } from "../../config/sessions/session-store-owner.js";
import { parseSessionThreadInfo } from "../../config/sessions/thread-info.js";
import { runWithoutOwnedSessionTranscriptWrites } from "../../config/sessions/transcript-write-context.js";
import type { AgentRouteBinding } from "../../config/types.agents.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { shouldResumeParentSubagent } from "../../gateway/session-subagent-resume.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { withSystemEventOwner } from "../../infra/system-event-ownership.js";
import { enqueueSystemEventEntry } from "../../infra/system-events.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  logSessionOwnershipLookupFailure,
  lookupFailedDenialMessage,
  lookupFailedOperationMessage,
  sessionOwnershipLookupFailure,
} from "../../plugin-sdk/session-visibility-internal.js";
import { runWithGatewayDetachedWorkContinuation } from "../../process/gateway-work-admission.js";
import { normalizeRouteBindingChannelId } from "../../routing/binding-scope.js";
import { resolveAgentRoute } from "../../routing/resolve-route.js";
import {
  buildAgentMainSessionKey,
  classifySessionKeyShape,
  isUnscopedSessionKeySentinel,
  normalizeAccountId,
  normalizeAgentId,
  normalizeAgentIdStrict,
  toAgentStoreSessionKey,
} from "../../routing/session-key.js";
import { annotateInterSessionPromptText } from "../../sessions/input-provenance.js";
import { deriveSessionChatTypeFromKey } from "../../sessions/session-chat-type-shared.js";
import {
  isCronRunSessionKey,
  parseAgentSessionKey,
  parseSessionDeliveryRoute,
} from "../../sessions/session-key-utils.js";
import { SESSION_LABEL_MAX_LENGTH } from "../../sessions/session-label.js";
import { recordSessionParticipantBestEffort } from "../../sessions/session-participant-recording.js";
import { registerSessionStateWatch } from "../../sessions/session-state-events.js";
import { stripFormattedReasoningMessage } from "../../shared/text/formatted-reasoning-message.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../utils/message-channel.js";
import { listAgentIds, resolveSessionAgentId } from "../agent-scope.js";
import { resolveNestedAgentLaneForSession } from "../lanes.js";
import { runOutsidePreparedModelRuntimePluginGenerationScope } from "../prepared-model-runtime-generation-scope.js";
import {
  type AgentWaitResult,
  isTerminalAgentWaitTimeout,
  waitForAgentRunReply,
} from "../run-wait.js";
import { isSubagentSessionFromEntry } from "../subagents/spawn/subagent-depth-policy.js";
import {
  describeSessionsSendTool,
  SESSIONS_SEND_TOOL_DISPLAY_SUMMARY,
} from "../tool-description-presets.js";
import { ToolInputError } from "../tool-input-error.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readNonNegativeIntegerParam, readToolStringParam } from "./common.js";
import {
  callAgentToolGatewayRequest,
  callInProcessGatewayToolWithCreation,
  hasInProcessGatewayToolContext,
  runWithGatewayToolContinuationContext,
  type AgentToolGatewayRequestCaller,
} from "./in-process-gateway.js";
import { runWithScopedSessionAccess } from "./scoped-session-access.js";
import {
  createSessionVisibilityRowChecker,
  formatSessionToolAccessDenial,
  isExpectedSessionLookupMiss,
  recordSessionToolActionFact,
  resolveDisplaySessionKey,
  resolveSessionReference,
  resolveSessionToolAccess,
  resolveSessionToolContext,
  resolveVisibleSessionReference,
} from "./sessions-helpers.js";
import { buildAgentToAgentMessageContext } from "./sessions-send-helpers.js";
import { captureSessionsSendResumeCaller, resumeSessionsSendTask } from "./sessions-send-resume.js";
import { runSessionsSendA2AFlow } from "./sessions-send-tool.a2a.js";
import { startSessionsSendAgentRun } from "./sessions-send-tool.delivery.js";
import { readSessionSendTarget } from "./sessions-send-tool.target.js";

const SessionsSendToolSchema = Type.Object({
  sessionKey: Type.Optional(Type.String()),
  label: Type.Optional(Type.String({ minLength: 1, maxLength: SESSION_LABEL_MAX_LENGTH })),
  agentId: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
  message: Type.String(),
  timeoutSeconds: Type.Optional(Type.Integer({ minimum: 0 })),
  watch: Type.Optional(Type.Boolean()),
  mode: Type.Optional(
    Type.Union([
      Type.Literal("notify"),
      Type.Literal("steer"),
      Type.Literal("followup"),
      Type.Literal("resume"),
    ]),
  ),
});

const log = createSubsystemLogger("agents/sessions-send");

const SessionsSendDeliverySchema = Type.Object(
  {
    status: Type.Union([Type.Literal("pending"), Type.Literal("skipped")]),
    mode: Type.Literal("announce"),
  },
  { additionalProperties: false },
);

const SessionsSendOutputSchema = Type.Union([
  Type.Object(
    {
      status: Type.Literal("accepted"),
      mode: Type.Literal("resume"),
      runId: Type.String(),
      taskRunId: Type.String(),
      sessionKey: Type.String(),
      completion: Type.Literal("task"),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      status: Type.Literal("queued"),
      sessionKey: Type.String(),
      notificationId: Type.String(),
      durability: Type.Literal("process"),
      runStarted: Type.Literal(false),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      runId: Type.String(),
      status: Type.Union([Type.Literal("error"), Type.Literal("forbidden")]),
      error: Type.String(),
      sessionKey: Type.Optional(Type.String()),
      sentBeforeError: Type.Optional(Type.Literal(true)),
      watched: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      runId: Type.String(),
      status: Type.Literal("accepted"),
      sessionKey: Type.String(),
      targetDisposition: Type.Union([Type.Literal("queued"), Type.Literal("steered")]),
      delivery: SessionsSendDeliverySchema,
      watched: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      runId: Type.String(),
      status: Type.Literal("timeout"),
      error: Type.String(),
      sentBeforeError: Type.Literal(true),
      sessionKey: Type.String(),
      delivery: Type.Optional(SessionsSendDeliverySchema),
      watched: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      runId: Type.String(),
      status: Type.Literal("no_reply"),
      sessionKey: Type.String(),
      message: Type.String(),
      watched: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      runId: Type.String(),
      status: Type.Literal("ok"),
      sessionKey: Type.String(),
      delivery: SessionsSendDeliverySchema,
      reply: Type.String(),
      watched: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: false },
  ),
]);

type GatewayCaller = AgentToolGatewayRequestCaller;
const SESSIONS_SEND_MESSAGE_ALIASES = ["SendMessage", "content", "text"] as const;
const NO_REPLY_MESSAGE = "No visible reply or pending announcement. Continue or retry if needed.";

function normalizeSessionsSendArguments(args: unknown): Record<string, unknown> {
  const params =
    args && typeof args === "object" && !Array.isArray(args)
      ? { ...(args as Record<string, unknown>) }
      : {};

  if (typeof params.message !== "string" || !params.message.trim()) {
    for (const alias of SESSIONS_SEND_MESSAGE_ALIASES) {
      const value = readToolStringParam(params, alias, { trim: false });
      if (value?.trim()) {
        params.message = stripFormattedReasoningMessage(value);
        break;
      }
    }
  }

  for (const alias of SESSIONS_SEND_MESSAGE_ALIASES) {
    delete params[alias];
  }
  return params;
}

function resolveConfiguredAgentMainSessionKey(params: {
  cfg: OpenClawConfig;
  agentId: string;
  mainKey: string;
}): string | undefined {
  const agentId = normalizeAgentId(params.agentId);
  if (!listAgentIds(params.cfg).includes(agentId)) {
    return undefined;
  }
  return toAgentStoreSessionKey({
    agentId,
    requestKey: "main",
    mainKey: params.mainKey,
  });
}

function isConfiguredAgentMainSessionKey(params: {
  cfg: OpenClawConfig;
  agentId?: string;
  sessionKey: string;
  mainKey: string;
}): boolean {
  if (isUnscopedSessionKeySentinel(params.sessionKey)) {
    return false;
  }
  if (params.sessionKey === params.mainKey) {
    return true;
  }
  const agentId = params.agentId ?? parseAgentSessionKey(params.sessionKey)?.agentId;
  return agentId
    ? params.sessionKey ===
        resolveConfiguredAgentMainSessionKey({
          cfg: params.cfg,
          agentId,
          mainKey: params.mainKey,
        })
    : false;
}

async function createConfiguredAgentMainSession(params: {
  cfg: OpenClawConfig;
  callGateway: GatewayCaller;
  agentId?: string;
  sessionKey: string;
  requesterSessionKey?: string;
  useTrustedInProcessCreation: boolean;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const targetAgentId =
    params.agentId ?? resolveSessionAgentId({ config: params.cfg, sessionKey: params.sessionKey });
  try {
    const createParams = {
      key: params.sessionKey,
      agentId: targetAgentId,
    };
    if (
      params.useTrustedInProcessCreation &&
      params.requesterSessionKey &&
      hasInProcessGatewayToolContext()
    ) {
      // sessions.create serializes keyed creation and adopts an existing row,
      // so concurrent first sends can safely race after the missing resolution.
      await callInProcessGatewayToolWithCreation("sessions.create", createParams, {
        via: "internal",
        actor: { type: "agent", id: params.requesterSessionKey },
      });
    } else {
      await params.callGateway({
        method: "sessions.create",
        params: createParams,
        timeoutMs: 10_000,
      });
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: formatErrorMessage(err) };
  }
}

function isPendingErrorAgentWaitTimeout(result: AgentWaitResult): boolean {
  return (
    result.pendingError === true && typeof result.error === "string" && result.error.trim() !== ""
  );
}

export function createSessionsSendTool(opts?: {
  agentId?: string;
  agentSessionKey?: string;
  agentChannel?: string;
  sandboxed?: boolean;
  config?: OpenClawConfig;
  callGateway?: GatewayCaller;
  /** Backend-selected owner for the target key; never sourced from model arguments. */
  targetAgentId?: string;
  /** Backend-derived target incarnation; never sourced from model arguments. */
  expectedTargetSessionId?: string;
  /** Live source and target constraints retained by a backend-owned send. */
  assertCurrent?: () => void;
  /** Backend-owned downstream operation id; never sourced from model arguments. */
  idempotencyKey?: string;
  signal?: AbortSignal;
}): AnyAgentTool {
  return {
    label: "Session Send",
    name: "sessions_send",
    displaySummary: SESSIONS_SEND_TOOL_DISPLAY_SUMMARY,
    description: describeSessionsSendTool(),
    parameters: SessionsSendToolSchema,
    outputSchema: SessionsSendOutputSchema,
    prepareArguments: normalizeSessionsSendArguments,
    execute: async (_toolCallId, args) => {
      const promptedAt = Date.now();
      const params = normalizeSessionsSendArguments(args);
      const gatewayCall = opts?.callGateway ?? callAgentToolGatewayRequest;
      const message = readToolStringParam(params, "message", { required: true, trim: false });
      if (!message.trim()) {
        throw new ToolInputError("message required");
      }
      const mode = readToolStringParam(params, "mode");
      if (
        mode !== undefined &&
        mode !== "notify" &&
        mode !== "steer" &&
        mode !== "followup" &&
        mode !== "resume"
      ) {
        throw new ToolInputError("mode must be notify, steer, followup, or resume");
      }
      const resumeCaller =
        mode === undefined || mode === "resume" ? captureSessionsSendResumeCaller() : undefined;
      if (mode === "resume" && !resumeCaller) {
        return jsonResult({
          runId: crypto.randomUUID(),
          status: "forbidden",
          error: "Task resume requires an admitted parent tool caller.",
        });
      }
      if (
        mode === "resume" &&
        (params.watch === true || (readNonNegativeIntegerParam(params, "timeoutSeconds") ?? 0) > 0)
      ) {
        throw new ToolInputError(
          "mode=resume returns admission only; omit watch and timeoutSeconds or set timeoutSeconds=0. The task owner delivers completion.",
        );
      }
      const timeoutSeconds =
        mode === "steer" || mode === "resume"
          ? 0
          : (readNonNegativeIntegerParam(params, "timeoutSeconds") ?? 30);
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
      let requesterAgentId: string;
      try {
        requesterAgentId = resolveSessionAgentId({
          config: cfg,
          sessionKey: effectiveRequesterKey,
          agentId: opts?.agentId,
        });
      } catch (err) {
        return jsonResult({
          runId: crypto.randomUUID(),
          status: "forbidden",
          error: formatErrorMessage(err),
        });
      }

      const sessionKeyParam = readToolStringParam(params, "sessionKey");
      const labelParam = normalizeOptionalString(readToolStringParam(params, "label"));
      const labelAgentIdInput = readToolStringParam(params, "agentId");
      const normalizedLabelAgentId =
        labelAgentIdInput === undefined ? null : normalizeAgentIdStrict(labelAgentIdInput);
      if (normalizedLabelAgentId && !normalizedLabelAgentId.ok) {
        return jsonResult({
          runId: crypto.randomUUID(),
          status: "error",
          error: `Agent "${labelAgentIdInput}" not found. Run openclaw agents list to see configured agents.`,
        });
      }
      const explicitTargetAgentId = normalizedLabelAgentId?.value;

      let sessionKey = sessionKeyParam;
      let resolvedTargetAgentId: string | undefined;
      let resolvedLabelKey: string | undefined;
      if (!sessionKey && !labelParam && explicitTargetAgentId) {
        const agentMainKey = resolveConfiguredAgentMainSessionKey({
          cfg,
          agentId: explicitTargetAgentId,
          mainKey,
        });
        if (!agentMainKey) {
          return jsonResult({
            runId: crypto.randomUUID(),
            status: "error",
            error: `Agent "${labelAgentIdInput}" not found. Run openclaw agents list to see configured agents.`,
          });
        }
        sessionKey = agentMainKey;
      }
      if (!sessionKey && labelParam) {
        const requestedAgentId = explicitTargetAgentId;

        if (restrictToSpawned && requestedAgentId && requestedAgentId !== requesterAgentId) {
          return jsonResult({
            runId: crypto.randomUUID(),
            status: "forbidden",
            error: "Sandboxed sessions_send label lookup is limited to this agent",
          });
        }

        if (requesterAgentId && requestedAgentId && requestedAgentId !== requesterAgentId) {
          if (!a2aPolicy.enabled) {
            return jsonResult({
              runId: crypto.randomUUID(),
              status: "forbidden",
              error:
                "Agent-to-agent messaging is disabled. Set tools.agentToAgent.enabled=true to allow cross-agent sends.",
            });
          }
          if (!a2aPolicy.isAllowed(requesterAgentId, requestedAgentId)) {
            return jsonResult({
              runId: crypto.randomUUID(),
              status: "forbidden",
              error: "Agent-to-agent messaging denied by tools.agentToAgent.allow.",
            });
          }
        }

        const resolveParams: Record<string, unknown> = {
          label: labelParam,
          ...(requestedAgentId ? { agentId: requestedAgentId } : {}),
          ...(restrictToSpawned ? { spawnedBy: effectiveRequesterKey } : {}),
        };
        let resolvedKey;
        try {
          const resolved = await gatewayCall<{ agentId?: string; key: string }>({
            method: "sessions.resolve",
            params: resolveParams,
            timeoutMs: 10_000,
          });
          resolvedKey = normalizeOptionalString(resolved?.key) ?? "";
          resolvedTargetAgentId = normalizeOptionalString(resolved?.agentId);
        } catch (err) {
          if (isExpectedSessionLookupMiss(err)) {
            resolvedKey = "";
          } else {
            const failure = sessionOwnershipLookupFailure(err);
            logSessionOwnershipLookupFailure({
              requesterSessionKey: effectiveRequesterKey,
              failure,
            });
            return jsonResult({
              runId: crypto.randomUUID(),
              status: restrictToSpawned ? "forbidden" : "error",
              error: restrictToSpawned
                ? lookupFailedDenialMessage("send", failure.kind)
                : lookupFailedOperationMessage("send", failure.kind),
            });
          }
        }

        if (!resolvedKey) {
          if (restrictToSpawned) {
            return jsonResult({
              runId: crypto.randomUUID(),
              status: "forbidden",
              error: "Session not visible from this sandboxed agent session.",
            });
          }
          return jsonResult({
            runId: crypto.randomUUID(),
            status: "error",
            error: `No session found with label: ${labelParam}`,
          });
        }
        sessionKey = resolvedKey;
        resolvedLabelKey = resolvedKey;
      }

      if (!sessionKey) {
        return jsonResult({
          runId: crypto.randomUUID(),
          status: "error",
          error: "Either sessionKey or label is required",
        });
      }
      const allowMissingKey = isConfiguredAgentMainSessionKey({
        cfg,
        sessionKey,
        mainKey,
      });
      const resolvedSession = resolvedLabelKey
        ? {
            ok: true as const,
            ...(resolvedTargetAgentId ? { agentId: resolvedTargetAgentId } : {}),
            key: resolvedLabelKey,
            displayKey: resolveDisplaySessionKey({ key: resolvedLabelKey, alias, mainKey }),
            resolvedViaSessionId: false,
            requesterOwned: restrictToSpawned,
          }
        : await resolveSessionReference({
            action: "send",
            sessionKey,
            keyAgentId: opts?.targetAgentId ?? requesterAgentId,
            agentId: opts?.targetAgentId,
            alias,
            mainKey,
            requesterInternalKey: effectiveRequesterKey,
            restrictToSpawned,
            callGateway: gatewayCall,
          });
      if (!resolvedSession.ok) {
        return jsonResult({
          runId: crypto.randomUUID(),
          status: resolvedSession.status,
          error: resolvedSession.error,
        });
      }
      const resolutionAccess = createSessionVisibilityRowChecker({
        action: "send",
        defaultAgentId:
          resolvedSession.agentId ??
          resolveSessionAgentId({ config: cfg, sessionKey: resolvedSession.key }),
        requesterAgentId,
        requesterSessionKey: effectiveRequesterKey,
        mainSessionKey,
        visibility: sessionVisibility,
        a2aPolicy,
      }).check({ key: resolvedSession.key });
      const visibleSession = await resolveVisibleSessionReference({
        action: "send",
        resolvedSession,
        requesterSessionKey: effectiveRequesterKey,
        requesterAgentId,
        restrictToSpawned,
        visibilitySessionKey: sessionKey,
        allowMissingKey,
        concealResolutionError: resolutionAccess.allowed ? undefined : resolutionAccess.error,
        callGateway: gatewayCall,
      });
      const unresolvedDisplayKey = sessionKey;
      if (!visibleSession.ok) {
        return jsonResult({
          runId: crypto.randomUUID(),
          status: visibleSession.status,
          error: visibleSession.error,
          sessionKey: unresolvedDisplayKey,
        });
      }
      // Exact-incarnation callers need the canonical key for follow-up sends.
      const resolvedKey = visibleSession.key;
      const displayKey = opts?.expectedTargetSessionId ? resolvedKey : visibleSession.displayKey;
      const resolvedKeyAgentId = parseAgentSessionKey(resolvedKey)?.agentId;
      const isLiteralLegacyKeyInput =
        !labelParam && sessionKeyParam !== undefined && !resolvedSession.resolvedViaSessionId;
      const isLiteralUnscopedTarget =
        isLiteralLegacyKeyInput && classifySessionKeyShape(resolvedKey) === "legacy_or_alias";
      const persistedTargetOwner = isLiteralUnscopedTarget
        ? resolvePersistedSessionStoreOwnerForKey(cfg, resolvedKey)
        : { kind: "none" as const };
      const compatibilityTargetAgentId =
        isLiteralUnscopedTarget && persistedTargetOwner.kind === "none"
          ? tryResolveLegacyCompatibilityAgentId(cfg)
          : undefined;
      const isLiteralUnscopedMainTarget =
        isLiteralUnscopedTarget &&
        (isUnscopedSessionKeySentinel(sessionKeyParam.trim()) ||
          sessionKeyParam.trim().toLowerCase() === mainKey);
      if (persistedTargetOwner.kind === "retired") {
        return jsonResult({
          runId: crypto.randomUUID(),
          status: "forbidden",
          error: "Session ownership could not be verified because its fixed-store owner retired.",
          sessionKey: unresolvedDisplayKey,
        });
      }
      const resolvedTargetOwner =
        visibleSession.agentId ??
        resolvedTargetAgentId ??
        (labelParam ? explicitTargetAgentId : undefined);
      if (
        persistedTargetOwner.kind === "configured" &&
        resolvedTargetOwner &&
        normalizeAgentId(resolvedTargetOwner) !== persistedTargetOwner.agentId
      ) {
        return jsonResult({
          runId: crypto.randomUUID(),
          status: "forbidden",
          error: `Session belongs to agent "${persistedTargetOwner.agentId}", not "${normalizeAgentId(resolvedTargetOwner)}".`,
          sessionKey: unresolvedDisplayKey,
        });
      }
      const targetAgentId =
        (persistedTargetOwner.kind === "configured" ? persistedTargetOwner.agentId : undefined) ??
        resolvedTargetOwner ??
        resolvedKeyAgentId ??
        (isLiteralUnscopedMainTarget ? requesterAgentId : undefined) ??
        compatibilityTargetAgentId;
      if (!targetAgentId) {
        return jsonResult({
          runId: crypto.randomUUID(),
          status: "forbidden",
          error:
            "Session ownership could not be verified. Upgrade the gateway or use an agent-prefixed session key.",
          sessionKey: unresolvedDisplayKey,
        });
      }
      const mayUseRequesterForLiteralSentinel =
        isLiteralUnscopedMainTarget && normalizeAgentId(targetAgentId) === requesterAgentId;
      const rawRequesterSessionKey = opts?.agentSessionKey ? effectiveRequesterKey : undefined;
      const requesterSession = await readSessionSendTarget(
        cfg,
        effectiveRequesterKey,
        requesterAgentId,
      );
      const requesterIsSubagent = isSubagentSessionFromEntry(
        requesterSession.canonicalKey,
        requesterSession.entry,
        requesterSession.acp,
      );
      const parsedRequesterSessionKey = parseAgentSessionKey(rawRequesterSessionKey);
      const requesterSessionKey = rawRequesterSessionKey;
      let replyRequesterSessionKey = rawRequesterSessionKey;
      // Only unthreaded DMs need reply-address normalization. Resolving other
      // requesters as direct peers can reject valid channel-only bindings.
      if (
        rawRequesterSessionKey &&
        parsedRequesterSessionKey &&
        rawRequesterSessionKey !== resolvedKey &&
        !parsedRequesterSessionKey.rest.startsWith("cron:") &&
        !parsedRequesterSessionKey.rest.startsWith("hook:") &&
        !requesterIsSubagent &&
        deriveSessionChatTypeFromKey(rawRequesterSessionKey) === "direct" &&
        !parseSessionThreadInfo(rawRequesterSessionKey).threadId
      ) {
        const requesterRouteBindings = cfg.bindings?.filter(
          (binding): binding is AgentRouteBinding => binding.type !== "acp",
        );
        const requesterDeliveryRoute = requesterRouteBindings?.length
          ? parseSessionDeliveryRoute(rawRequesterSessionKey)
          : null;
        const bareRequesterPeerId = parsedRequesterSessionKey?.rest.startsWith("direct:")
          ? parsedRequesterSessionKey.rest.slice("direct:".length)
          : parsedRequesterSessionKey?.rest.startsWith("dm:")
            ? parsedRequesterSessionKey.rest.slice("dm:".length)
            : undefined;
        const requesterRouteChannel = requesterDeliveryRoute?.channel ?? opts?.agentChannel;
        const requesterRoutePeerId = requesterDeliveryRoute?.peerId ?? bareRequesterPeerId;
        const requesterRoute =
          requesterRouteBindings?.length && requesterRouteChannel && requesterRoutePeerId
            ? resolveAgentRoute({
                cfg,
                channel: requesterRouteChannel,
                accountId: requesterDeliveryRoute?.accountId,
                peer: { kind: "direct", id: requesterRoutePeerId },
              })
            : undefined;
        // Any configured route can transfer this peer to another agent. A key
        // without enough route facts must never be reassigned to guessed ownership.
        const hasUnresolvedRequesterRoute = Boolean(
          requesterRouteBindings?.length &&
          (!requesterRoute || requesterRoute.agentId !== parsedRequesterSessionKey?.agentId),
        );
        // Session keys can discard account, peer casing, team, guild, and roles.
        // Preserve the authenticated caller whenever any possible binding would
        // choose another agent or an isolated DM scope using those missing facts.
        const hasUnsafeRequesterDmBinding = Boolean(
          requesterRouteBindings?.some((binding) => {
            const effectiveDmScope = binding.session?.dmScope ?? cfg.session?.dmScope ?? "main";
            const isForeignAgent =
              normalizeAgentId(binding.agentId) !== parsedRequesterSessionKey?.agentId;
            if (!isForeignAgent && effectiveDmScope === "main") {
              return false;
            }
            if (
              requesterRouteChannel &&
              normalizeRouteBindingChannelId(binding.match.channel) !==
                normalizeRouteBindingChannelId(requesterRouteChannel)
            ) {
              return false;
            }
            const bindingAccountId = binding.match.accountId?.trim();
            if (
              requesterDeliveryRoute?.accountId &&
              bindingAccountId !== "*" &&
              normalizeAccountId(bindingAccountId) !==
                normalizeAccountId(requesterDeliveryRoute.accountId)
            ) {
              return false;
            }
            const peer = binding.match.peer;
            if (peer) {
              const peerId = peer.id.trim();
              if (
                peer.kind !== "direct" ||
                (peerId !== "*" &&
                  peerId.toLowerCase() !== requesterRoutePeerId?.trim().toLowerCase())
              ) {
                return false;
              }
            }
            return true;
          }),
        );
        const requesterDmScope =
          requesterRoute && requesterRoute.agentId === parsedRequesterSessionKey?.agentId
            ? (requesterRoute.dmScope ?? cfg.session?.dmScope ?? "main")
            : (cfg.session?.dmScope ?? "main");
        // Normalize only the reply address after exact-key visibility checks;
        // global/binding-isolated DMs keep their authenticated identity.
        if (
          requesterDmScope === "main" &&
          !hasUnresolvedRequesterRoute &&
          !hasUnsafeRequesterDmBinding
        ) {
          replyRequesterSessionKey = buildAgentMainSessionKey({
            agentId: parsedRequesterSessionKey.agentId,
            mainKey,
          });
        }
      }
      const timeoutMs =
        finiteSecondsToTimerSafeMilliseconds(timeoutSeconds, {
          floorSeconds: true,
        }) ?? 0;
      const announceTimeoutMs = timeoutSeconds === 0 ? 30_000 : timeoutMs;
      const idempotencyKey = opts?.idempotencyKey ?? crypto.randomUUID();
      let runId: string = idempotencyKey;
      // Fire-and-forget self-send remains a channel-delivery path. A synchronous
      // self-send would wait behind its own active session lane until timeout.
      if (
        timeoutSeconds !== 0 &&
        requesterSessionKey === resolvedKey &&
        targetAgentId === requesterAgentId
      ) {
        return jsonResult({
          runId,
          status: "error",
          error: "sessions_send cannot target the calling session; use your own reply instead",
          sessionKey: unresolvedDisplayKey,
        });
      }
      if (parseSessionThreadInfo(resolvedKey).threadId) {
        return jsonResult({
          runId: crypto.randomUUID(),
          status: "error",
          error:
            "sessions_send cannot target a thread session for inter-agent coordination. Use the parent channel session key instead.",
          sessionKey: unresolvedDisplayKey,
        });
      }
      const authorizationTargetKey = mayUseRequesterForLiteralSentinel
        ? effectiveRequesterKey
        : targetAgentId && !parseAgentSessionKey(resolvedKey)
          ? `agent:${targetAgentId}:${resolvedKey}`
          : resolvedKey;
      const access = await resolveSessionToolAccess({
        action: "send",
        requesterAgentId,
        requesterSessionKey: effectiveRequesterKey,
        mainSessionKey,
        targetAgentId,
        targetSessionKey: resolvedKey,
        authorizationTargetSessionKey: authorizationTargetKey,
        requesterOwned: visibleSession.requesterOwned,
        visibility: sessionVisibility,
        a2aPolicy,
        callGateway: gatewayCall,
      });
      if (!access.allowed) {
        return jsonResult({
          runId: crypto.randomUUID(),
          status: access.status,
          error: formatSessionToolAccessDenial(access, {
            action: "send",
            targetSessionKey: unresolvedDisplayKey,
          }),
          sessionKey: unresolvedDisplayKey,
        });
      }
      const expectedSessionId = opts?.expectedTargetSessionId ?? access.expectedSessionId;
      if (mode === "notify" && expectedSessionId) {
        return jsonResult({
          runId,
          status: "forbidden",
          sessionKey: displayKey,
          error:
            "Notifications cannot outlive an exact-session access grant. Use steer or followup.",
        });
      }

      return await runWithScopedSessionAccess({
        cfg,
        agentId: targetAgentId,
        expectedSessionId,
        ...(opts?.signal ? { signal: opts.signal } : {}),
        targetSessionKey: resolvedKey,
        run: async () => {
          if (visibleSession.missing) {
            if (mode === "steer" || mode === "notify" || mode === "resume") {
              return jsonResult({
                runId,
                status: "error",
                error:
                  "Cannot notify, steer, or resume a missing session. Use mode=followup to start a new turn.",
                sessionKey: displayKey,
              });
            }
            const createdSession = await createConfiguredAgentMainSession({
              cfg,
              callGateway: gatewayCall,
              ...(targetAgentId ? { agentId: targetAgentId } : {}),
              sessionKey: resolvedKey,
              requesterSessionKey,
              useTrustedInProcessCreation: opts?.callGateway === undefined,
            });
            if (!createdSession.ok) {
              return jsonResult({
                runId: crypto.randomUUID(),
                status: "error",
                error: createdSession.error,
                sessionKey: displayKey,
              });
            }
          }

          const requesterChannel = opts?.agentChannel;
          const isIsolatedCronRequester = isCronRunSessionKey(requesterSessionKey);
          const targetSession = await readSessionSendTarget(cfg, resolvedKey, targetAgentId);
          const targetSessionEntry = targetSession.entry;
          const targetAcpMeta = targetSession.acp;
          const targetIsSubagent = isSubagentSessionFromEntry(
            targetSession.canonicalKey,
            targetSessionEntry,
            targetAcpMeta,
          );
          // Watch registration follows successful dispatch: a failed send must not leave
          // a hidden watch, and cron run-scoped sends can fall back to the durable parent
          // session, which is the key that receives future state changes.
          const watchRequested = params.watch === true;
          const registerWatchIfRequested = (targetSessionKey: string) => {
            const watched =
              watchRequested &&
              !expectedSessionId &&
              replyRequesterSessionKey &&
              replyRequesterSessionKey !== targetSessionKey
                ? registerSessionStateWatch({
                    watcherSessionKey: replyRequesterSessionKey,
                    targetSessionKey,
                    targetAgentId,
                  })
                : false;
            return watchRequested ? { watched } : {};
          };
          const agentMessageContext =
            requesterIsSubagent || targetIsSubagent
              ? undefined
              : buildAgentToAgentMessageContext({
                  requesterSessionKey: replyRequesterSessionKey,
                  requesterChannel,
                  targetSessionKey: displayKey,
                });
          const inputProvenance = {
            kind: "inter_session" as const,
            sourceSessionKey: replyRequesterSessionKey,
            sourceChannel: requesterChannel,
            sourceTool: "sessions_send",
            ...(requesterIsSubagent ? { sourceRole: "subagent" as const } : {}),
          };
          if (mode === "notify") {
            const event = enqueueSystemEventEntry(
              annotateInterSessionPromptText(message, inputProvenance),
              withSystemEventOwner(
                { sessionKey: resolvedKey, contextKey: `session-notify:${idempotencyKey}` },
                targetAgentId,
              ),
            );
            if (!event?.id) {
              return jsonResult({
                runId,
                status: "error",
                sessionKey: displayKey,
                error: "Notification was not queued.",
              });
            }
            return jsonResult({
              status: "queued",
              sessionKey: displayKey,
              notificationId: event.id,
              durability: "process",
              runStarted: false,
            });
          }
          const sendParams = {
            message: annotateInterSessionPromptText(message, inputProvenance),
            agentId: targetAgentId,
            sessionKey: resolvedKey,
            idempotencyKey,
            deliver: false,
            sourceReplyDeliveryMode: "message_tool_only" as const,
            channel: INTERNAL_MESSAGE_CHANNEL,
            lane: resolveNestedAgentLaneForSession(resolvedKey),
            extraSystemPrompt: agentMessageContext,
            inputProvenance,
          };
          if (
            mode === "resume" ||
            (mode === undefined &&
              resumeCaller &&
              !targetAcpMeta &&
              shouldResumeParentSubagent({
                cfg,
                caller: resumeCaller,
                childSessionKey: resolvedKey,
              }))
          ) {
            if (!resumeCaller) {
              throw new ToolInputError("Task resume requires an admitted parent tool caller.");
            }
            return await resumeSessionsSendTask({
              cfg,
              caller: resumeCaller,
              targetAgentId,
              sessionKey: resolvedKey,
              displayKey,
              runId,
              expectedSessionId,
              sendParams,
              callGateway: gatewayCall,
            });
          }
          // ACP background tasks already report to their parent through task completion.
          const targetSessionEntryWithAcp = targetSessionEntry
            ? { ...targetSessionEntry, acp: targetAcpMeta }
            : targetSessionEntry;
          const skipTaskReplyFlow = isRequesterParentOfBackgroundAcpSession(
            targetSessionEntryWithAcp,
            effectiveRequesterKey,
          );
          // Child reports, registered tasks, and exact-incarnation grants own their completion.
          const replyMode =
            requesterIsSubagent || skipTaskReplyFlow || expectedSessionId
              ? undefined
              : targetIsSubagent && !isIsolatedCronRequester
                ? "one-way"
                : "peer";

          const start = await startSessionsSendAgentRun({
            cfg,
            callGateway: gatewayCall,
            runId,
            mode,
            sendParams,
            sessionKey: mode ? resolvedKey : displayKey,
            sessionStoreTarget: targetSession,
            assertCurrent: opts?.assertCurrent,
            deliveryTimeoutMs: announceTimeoutMs,
            ...(timeoutSeconds === 0
              ? {
                  allowActiveRunQueueDelivery: true,
                  // An exact-incarnation grant authorizes only this target. Never
                  // reroute a worker-owned send to a durable Cron parent outside
                  // the scoped lifecycle admission or replace its stable key.
                  allowActiveRunQueueFallback: !expectedSessionId,
                  expectedSessionId,
                }
              : {}),
          });
          if (!start.ok) {
            return start.result;
          }
          const acceptedTargetSessionKey = start.a2aSessionKey ?? resolvedKey;
          // Steering keeps its active owner; an inline child reply is already delivered.
          const delayedDelivery = {
            status:
              replyMode !== undefined && start.targetDisposition === "queued"
                ? "pending"
                : "skipped",
            mode: "announce",
          } as const;
          const delivery =
            timeoutSeconds > 0 && targetIsSubagent
              ? ({ status: "skipped", mode: "announce" } as const)
              : delayedDelivery;
          recordSessionToolActionFact({
            operation: "send",
            fact: "committed",
            targetAgentId,
            targetSessionKey: acceptedTargetSessionKey,
          });
          try {
            const acceptedTarget = start.a2aSessionKey
              ? await readSessionSendTarget(cfg, acceptedTargetSessionKey, targetAgentId)
              : targetSession;
            if (start.a2aSessionKey && !acceptedTarget.entry) {
              throw new Error("Accepted Cron parent has no stored session entry.");
            }
            recordSessionParticipantBestEffort({
              identity: { type: "agent", id: requesterAgentId },
              promptedAt,
              agentId: acceptedTarget.agentId,
              sessionKey: acceptedTarget.canonicalKey,
              storePath: acceptedTarget.storePath,
              onError: (error) => log.warn("failed to record session participant", { error }),
            });
          } catch (error) {
            log.warn("failed to record session participant", { error });
          }
          runId = start.runId;
          const watchField = registerWatchIfRequested(acceptedTargetSessionKey);
          const startReplyFlow = ({
            reply,
            notifyRequesterOnWaitFailure = false,
          }: {
            reply?: Awaited<ReturnType<typeof waitForAgentRunReply>>;
            notifyRequesterOnWaitFailure?: boolean;
          }) => {
            if ((reply ? delivery : delayedDelivery).status === "skipped") {
              return;
            }
            // Detached turns must not retain the caller's resource or runtime generation scope.
            void runWithGatewayToolContinuationContext(() =>
              runWithGatewayDetachedWorkContinuation(
                () =>
                  runOutsidePreparedModelRuntimePluginGenerationScope(() =>
                    runWithoutOwnedSessionTranscriptWrites(() =>
                      runSessionsSendA2AFlow({
                        callGateway: gatewayCall,
                        targetSessionKey: acceptedTargetSessionKey,
                        targetAgentId,
                        displayKey: start.a2aSessionKey ?? displayKey,
                        message,
                        announceTimeoutMs,
                        // Isolated Cron jobs retain target announcements without requester turns.
                        maxPingPongTurns: isIsolatedCronRequester ? 0 : 5,
                        replyMode,
                        requesterSessionKey: replyRequesterSessionKey,
                        requesterAgentId,
                        requesterChannel,
                        roundOneReply: reply?.replyText,
                        sourceReplyDelivered: reply?.sourceReplyDelivered,
                        waitRunId: reply ? undefined : runId,
                        notifyRequesterOnWaitFailure:
                          notifyRequesterOnWaitFailure && !isIsolatedCronRequester,
                      }),
                    ),
                  ),
                "session:a2a-send",
              ),
            ).catch((err: unknown) => {
              log.warn("sessions_send announce flow admission failed", {
                runId,
                error: formatErrorMessage(err),
              });
            });
          };
          if (timeoutSeconds === 0) {
            startReplyFlow({ notifyRequesterOnWaitFailure: true });
            return jsonResult({
              runId,
              status: "accepted",
              sessionKey: displayKey,
              targetDisposition: start.targetDisposition,
              delivery,
              ...watchField,
            });
          }

          const result = await waitForAgentRunReply({
            runId,
            timeoutMs,
            callGateway: gatewayCall,
          });

          if (result.status === "timeout") {
            if (isPendingErrorAgentWaitTimeout(result)) {
              startReplyFlow({ notifyRequesterOnWaitFailure: targetIsSubagent });
              return jsonResult({
                runId,
                status: "timeout",
                error: result.error,
                sentBeforeError: true,
                sessionKey: displayKey,
                delivery: delayedDelivery,
                ...watchField,
              });
            }
            if (!isTerminalAgentWaitTimeout(result)) {
              startReplyFlow({ notifyRequesterOnWaitFailure: true });
              return jsonResult({
                runId,
                status: "accepted",
                sessionKey: displayKey,
                targetDisposition: start.targetDisposition,
                delivery: delayedDelivery,
                ...watchField,
              });
            }
            return jsonResult({
              runId,
              status: "timeout",
              error: result.error ?? "agent run timed out",
              sentBeforeError: true,
              sessionKey: displayKey,
              ...watchField,
            });
          }
          if (result.status === "error") {
            return jsonResult({
              runId,
              status: "error",
              error: result.error ?? "agent error",
              sentBeforeError: true,
              sessionKey: displayKey,
              ...watchField,
            });
          }
          const reply = result.replyText;
          const response = reply
            ? { status: "ok" as const, delivery, reply }
            : {
                status: "no_reply" as const,
                message: result.sourceReplyDelivered
                  ? "The target delivered its final reply directly to its source conversation. Do not resend."
                  : NO_REPLY_MESSAGE,
              };
          if (reply) {
            startReplyFlow({ reply: result });
          }
          return jsonResult({ runId, sessionKey: displayKey, ...response, ...watchField });
        },
      });
    },
  };
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
