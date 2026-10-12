import { randomUUID } from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import {
  buildAgentRunTerminalOutcomeFromLifecycleEvent,
  classifyAgentRunTerminalOutcome,
} from "../agents/agent-run-terminal-outcome.js";
import { resolveAgentRunCwd } from "../agents/agent-scope-config.js";
import { resolveSessionAgentId } from "../agents/agent-scope.js";
import type { RunEmbeddedAgentParams } from "../agents/embedded-agent-runner/run/params.js";
import type { EmbeddedAgentRunMeta } from "../agents/embedded-agent-runner/types.js";
import { resolveIngressWorkspaceOverrideForSessionRun } from "../agents/spawned-context.js";
import { getReplyPayloadMetadata } from "../auto-reply/reply-payload.js";
import type { ReplyToolAuthorityOverlay } from "../auto-reply/reply/reply-run-registry.contracts.js";
import { resolveLoadedSessionThreadInfo } from "../channels/plugins/session-thread-info-loaded.js";
import { buildSpawnAuthorityReceipt } from "../config/sessions/session-entry-lineage.js";
import {
  buildSessionCreationStamp,
  inheritSessionCreationPolicy,
} from "../config/sessions/session-entry-provenance.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { RuntimeLogger, PluginRuntimeCore } from "../plugins/runtime/types-core.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { isModelSelectionLocked, ModelSelectionLockedError } from "../sessions/model-overrides.js";
import { deliveryContextFromSession } from "../utils/delivery-context.read.js";
import {
  hasDeliveryTargetFields,
  normalizeDeliveryContext,
  normalizeSessionDeliveryState,
  type DeliveryContext,
} from "../utils/delivery-context.shared.js";
import {
  buildRealtimeVoiceAgentConsultPrompt,
  collectRealtimeVoiceAgentConsultVisibleText,
  type RealtimeVoiceAgentConsultTranscriptEntry,
} from "./agent-consult-tool.js";

export type RealtimeVoiceAgentConsultRuntime = PluginRuntimeCore["agent"];

export type RealtimeVoiceAgentConsultResult = { text: string; yielded?: true };

const REALTIME_VOICE_YIELD_ACK_MAX_CHARS = 500;
const REALTIME_VOICE_YIELD_ACK_FALLBACK =
  "I started that work and will share the result when it is ready.";

/**
 * Sender-auth contract revision for official realtime voice plugins.
 *
 * Revision 1 forwards ingress-authenticated `senderId` and `senderIsOwner` unchanged. Ingress
 * owns authentication; consumers that require this handoff must fail closed on other revisions.
 */
export const REALTIME_VOICE_AGENT_CONSULT_SENDER_AUTH_VERSION = 1;

type RealtimeVoiceAgentConsultContextMode = "isolated" | "fork";

type RealtimeVoiceAgentConsultRunRegistration = {
  abortSignal?: AbortSignal;
  cleanup?: () => void;
  cleanupBeforeRun?: () => void;
};

/**
 * Fails closed when a realtime consult would cross a model-selection lock.
 */
export function assertRealtimeVoiceAgentConsultModelSelectionUnlocked(params: {
  cfg: OpenClawConfig;
  agentRuntime: RealtimeVoiceAgentConsultRuntime;
  agentId: string;
  sessionKey: string;
  spawnedBy?: string | null;
  storePath?: string;
}): void {
  const candidates = new Map<string, { agentId: string; sessionKey: string; storePath: string }>();
  const remember = (sessionKey: string, fallbackAgentId: string, storePath?: string) => {
    const candidateAgentId = parseAgentSessionKey(sessionKey)?.agentId ?? fallbackAgentId;
    const candidateStorePath =
      storePath ??
      params.agentRuntime.session.resolveStorePath(params.cfg.session?.store, {
        agentId: candidateAgentId,
      });
    candidates.set(`${candidateStorePath}\u0000${sessionKey}`, {
      agentId: candidateAgentId,
      sessionKey,
      storePath: candidateStorePath,
    });
  };

  remember(params.sessionKey, params.agentId, params.storePath);
  const requesterSessionKey = params.spawnedBy?.trim();
  const requesterAgentId = parseAgentSessionKey(requesterSessionKey)?.agentId;
  const targetAgentId = parseAgentSessionKey(params.sessionKey)?.agentId ?? params.agentId;
  if (requesterSessionKey && (!requesterAgentId || requesterAgentId === targetAgentId)) {
    const requesterAgent = requesterAgentId ?? params.agentId;
    remember(requesterSessionKey, requesterAgent);
    const { baseSessionKey } = resolveLoadedSessionThreadInfo(requesterSessionKey);
    if (baseSessionKey && baseSessionKey !== requesterSessionKey) {
      remember(baseSessionKey, requesterAgent);
    }
  }

  for (const { agentId, sessionKey, storePath } of candidates.values()) {
    const entry = params.agentRuntime.session.getSessionEntry({
      agentId,
      storePath,
      sessionKey,
      readConsistency: "latest",
    });
    // Realtime consults select a configured provider/model and may run fast-context first.
    // Until they preserve native bindings, a locked transcript must never cross runtimes.
    if (isModelSelectionLocked(entry)) {
      throw new ModelSelectionLockedError();
    }
  }
}

function resolveRealtimeVoiceAgentSandboxSessionKey(agentId: string, sessionKey: string): string {
  // Embedded agent runs expect agent-scoped sandbox keys; keep already-scoped keys intact so
  // callers can deliberately share a sandbox with an existing agent session.
  const trimmed = sessionKey.trim();
  if (trimmed.toLowerCase().startsWith("agent:")) {
    return trimmed;
  }
  return `agent:${agentId}:${trimmed}`;
}

function resolveDeliverySessionFields(context?: DeliveryContext): Partial<SessionEntry> {
  const normalized = normalizeDeliveryContext(context);
  if (!normalized?.channel || !normalized.to) {
    return {};
  }
  return {
    delivery: normalizeSessionDeliveryState({ context: normalized }),
  };
}

async function resolveRealtimeVoiceAgentDeliveryContext(params: {
  cfg: OpenClawConfig;
  agentRuntime: RealtimeVoiceAgentConsultRuntime;
  agentId: string;
  storePath: string;
  sessionKey: string;
  sessionEntry: SessionEntry | undefined;
  spawnedBy?: string | null;
}): Promise<DeliveryContext | undefined> {
  const requesterSessionKey = params.spawnedBy?.trim();
  try {
    // Prefer the live requester session, then its base thread, then the voice consult session.
    // This preserves channel/account/thread routing when a voice bridge delegates back to agent.
    const candidates: Array<{ sessionKey: string; storePath?: string }> = [];
    if (requesterSessionKey) {
      const { baseSessionKey } = resolveLoadedSessionThreadInfo(requesterSessionKey);
      for (const key of [requesterSessionKey, baseSessionKey]) {
        if (key) {
          candidates.push({ sessionKey: key });
        }
      }
    }
    candidates.push({ sessionKey: params.sessionKey, storePath: params.storePath });
    const visited = new Set<string>();
    for (const candidate of candidates) {
      const agentId = parseAgentSessionKey(candidate.sessionKey)?.agentId ?? params.agentId;
      const storePath =
        candidate.storePath ??
        params.agentRuntime.session.resolveStorePath(params.cfg.session?.store, { agentId });
      const identity = `${storePath}\u0000${candidate.sessionKey}`;
      if (visited.has(identity)) {
        continue;
      }
      visited.add(identity);
      const entry =
        storePath === params.storePath && candidate.sessionKey === params.sessionKey
          ? params.sessionEntry
          : await params.agentRuntime.session.getSessionEntryAsync({
              agentId,
              storePath,
              sessionKey: candidate.sessionKey,
            });
      const context = deliveryContextFromSession(entry);
      if (hasDeliveryTargetFields(context)) {
        return context;
      }
    }
  } catch {
    // Best-effort routing enrichment only; consults should still work without it.
  }
  return undefined;
}

/** Prepare caller-side session and routing facts for a voice consultation. */
async function prepareRealtimeVoiceAgentExecutionContext(params: {
  cfg: OpenClawConfig;
  agentRuntime: RealtimeVoiceAgentConsultRuntime;
  agentId?: string;
  sessionKey: string;
  storePath?: string;
  spawnedBy?: string | null;
  senderId?: string | null;
  senderIsOwner?: boolean;
  toolsAllow?: string[];
  messageProvider: string;
}) {
  const agentId =
    params.agentId ?? resolveSessionAgentId({ config: params.cfg, sessionKey: params.sessionKey });
  const storePath =
    params.storePath ??
    params.agentRuntime.session.resolveStorePath(params.cfg.session?.store, { agentId });
  const sessionEntry = await params.agentRuntime.session.getSessionEntryAsync({
    agentId,
    storePath,
    sessionKey: params.sessionKey,
    readConsistency: "latest",
  });
  const deliveryContext =
    (await resolveRealtimeVoiceAgentDeliveryContext({
      ...params,
      agentId,
      storePath,
      sessionEntry,
    })) ?? deliveryContextFromSession(sessionEntry);
  return {
    agentId,
    storePath,
    sessionEntry,
    deliveryContext,
    toolAuthorityOverlay: buildRealtimeVoiceAgentToolAuthorityOverlay({
      ...params,
      sessionEntry,
      deliveryContext,
    }),
    agentDir: params.agentRuntime.resolveAgentDir(params.cfg, agentId),
    workspaceDir:
      resolveIngressWorkspaceOverrideForSessionRun({
        spawnedBy: sessionEntry?.spawnedBy,
        workspaceDir: sessionEntry?.spawnedWorkspaceDir,
        cwd: sessionEntry?.spawnedCwd,
      }) ?? params.agentRuntime.resolveAgentWorkspaceDir(params.cfg, agentId),
    cwd:
      normalizeOptionalString(sessionEntry?.spawnedCwd) ?? resolveAgentRunCwd(params.cfg, agentId),
  };
}

export function buildRealtimeVoiceAgentToolAuthorityOverlay(params: {
  sessionEntry?: SessionEntry;
  deliveryContext?: DeliveryContext;
  messageProvider: string;
  spawnedBy?: string | null;
  senderId?: string | null;
  senderIsOwner?: boolean;
  toolsAllow?: string[];
}): ReplyToolAuthorityOverlay {
  return {
    permissionMode: params.sessionEntry?.permissionMode,
    toolOverrides: params.sessionEntry?.toolOverrides,
    messageProvider: params.deliveryContext?.channel ?? params.messageProvider,
    agentAccountId: params.deliveryContext?.accountId,
    spawnedBy: params.spawnedBy ?? undefined,
    senderId: params.senderId ?? undefined,
    senderIsOwner: params.senderIsOwner === true,
    toolsAllow: params.toolsAllow,
    disableTools: false,
    traceAuthorized: false,
  };
}

async function resolveRealtimeVoiceAgentConsultSessionEntry(params: {
  agentId: string;
  cfg: OpenClawConfig;
  sessionKey: string;
  spawnedBy?: string | null;
  senderIsOwner?: boolean;
  contextMode?: RealtimeVoiceAgentConsultContextMode;
  deliveryContext?: DeliveryContext;
  storePath: string;
  agentRuntime: RealtimeVoiceAgentConsultRuntime;
  logger: Pick<RuntimeLogger, "warn">;
  assertCurrent: () => void;
}): Promise<SessionEntry> {
  const now = Date.now();
  const deliveryFields = resolveDeliverySessionFields(params.deliveryContext);
  const requesterSessionKey = params.spawnedBy?.trim();
  const requesterAgentId = parseAgentSessionKey(requesterSessionKey)?.agentId;
  const requesterEntry = requesterSessionKey
    ? await params.agentRuntime.session.getSessionEntryAsync({
        agentId: requesterAgentId ?? params.agentId,
        storePath: params.agentRuntime.session.resolveStorePath(params.cfg.session?.store, {
          agentId: requesterAgentId ?? params.agentId,
        }),
        sessionKey: requesterSessionKey,
        readConsistency: "latest",
      })
    : undefined;
  const creationStamp = buildSessionCreationStamp({
    via: "talk",
    ...inheritSessionCreationPolicy(
      requesterEntry,
      requesterSessionKey ? { type: "agent", id: requesterSessionKey } : undefined,
    ),
  });
  // A consult child records the same lineage receipt as a native spawn: the requester's
  // exact incarnation and the caller's ingress-authenticated owner bit.
  const spawnLineage = requesterSessionKey
    ? {
        spawnedBy: requesterSessionKey,
        ...buildSpawnAuthorityReceipt(requesterEntry, params.senderIsOwner),
      }
    : {};
  const shouldFork =
    params.contextMode === "fork" &&
    requesterSessionKey &&
    (!requesterAgentId || requesterAgentId === params.agentId);
  let forkDecisionWarning: string | undefined;

  let patched: SessionEntry | null = null;
  if (shouldFork) {
    const { forkSessionEntryFromParent } = await import("../auto-reply/reply/session-fork.js");
    const forked = await forkSessionEntryFromParent({
      storePath: params.storePath,
      parentSessionKey: requesterSessionKey,
      agentId: params.agentId,
      config: params.cfg,
      sessionKey: params.sessionKey,
      fallbackEntry: {
        ...creationStamp,
        sessionId: "",
        updatedAt: now,
      },
      entryPatch: {
        skipExisting: true,
        skipped: { ...deliveryFields, updatedAt: now },
        forked: { ...deliveryFields, ...spawnLineage, updatedAt: now },
      },
    });
    if (forked.status === "forked" || forked.status === "skipped") {
      if (forked.status === "skipped" && forked.decision?.status === "skip") {
        forkDecisionWarning = forked.decision.message;
      }
      if (forked.sessionEntry.sessionId?.trim()) {
        patched = forked.sessionEntry;
      }
    }
  }

  patched ??= await params.agentRuntime.session.prepareSessionEntryPatch({
    agentId: params.agentId,
    storePath: params.storePath,
    sessionKey: params.sessionKey,
    fallbackEntry: {
      ...creationStamp,
      sessionId: "",
      updatedAt: now,
    },
    authority: { kind: "host", assertCurrent: params.assertCurrent },
    prepare: (entry) => {
      if (entry.sessionId?.trim()) {
        return { ...deliveryFields, updatedAt: now };
      }
      return {
        ...deliveryFields,
        sessionId: randomUUID(),
        ...spawnLineage,
        updatedAt: now,
      };
    },
  });
  if (forkDecisionWarning) {
    params.logger.warn(`[talk] ${forkDecisionWarning}`);
  }
  if (patched?.sessionId?.trim()) {
    return patched;
  }
  throw new Error("realtime voice agent consult session could not be initialized");
}

function assertRealtimeVoiceConsultNotInterrupted(
  abortSignal: AbortSignal,
  meta?: EmbeddedAgentRunMeta,
): void {
  const outcome = buildAgentRunTerminalOutcomeFromLifecycleEvent({
    phase: "end",
    data: meta,
    abortSignal,
  });
  const classification = classifyAgentRunTerminalOutcome(outcome);
  // Preserve the run owner's interruption before projecting partial or empty text
  // into speech. A timeout must remain a failure, not a silent cancellation.
  if (classification === "cancellation") {
    throw new DOMException("Realtime voice agent consult cancelled", "AbortError");
  }
  if (classification === "timeout") {
    throw new DOMException("Realtime voice agent consult timed out", "TimeoutError");
  }
}

export async function consultRealtimeVoiceAgent(params: {
  cfg: OpenClawConfig;
  agentRuntime: RealtimeVoiceAgentConsultRuntime;
  logger: Pick<RuntimeLogger, "warn">;
  sessionKey: string;
  /** Prepared concrete store; omitted callers retain their configured store selection. */
  storePath?: string;
  messageProvider: string;
  lane: string;
  runIdPrefix: string;
  args: unknown;
  transcript: RealtimeVoiceAgentConsultTranscriptEntry[];
  surface: string;
  userLabel: string;
  assistantLabel?: string;
  questionSourceLabel?: string;
  agentId?: string;
  spawnedBy?: string | null;
  /** Sender identity established by the caller's ingress authorization boundary. */
  senderId?: string | null;
  /** Trusted owner bit established by the caller's ingress authorization boundary. */
  senderIsOwner?: boolean;
  contextMode?: RealtimeVoiceAgentConsultContextMode;
  provider?: RunEmbeddedAgentParams["provider"];
  model?: RunEmbeddedAgentParams["model"];
  thinkLevel?: RunEmbeddedAgentParams["thinkLevel"];
  fastMode?: RunEmbeddedAgentParams["fastMode"];
  timeoutMs?: number;
  toolsAllow?: string[];
  toolBindings?: RunEmbeddedAgentParams["toolBindings"];
  extraSystemPrompt?: string;
  fallbackText?: string;
  abortSignal?: AbortSignal;
  /** Gateway ingress adapts authenticated policy; channel bridges keep their own authority. */
  prepareToolContext?: (
    sessionEntry: SessionEntry,
  ) => Partial<
    Pick<
      RunEmbeddedAgentParams,
      | "permissionMode"
      | "toolOverrides"
      | "senderIsOwner"
      | "senderId"
      | "messageProvider"
      | "agentAccountId"
      | "approvalReviewerDeviceId"
      | "clientCaps"
      | "execOverrides"
      | "bashElevated"
      | "currentChannelId"
      | "currentThreadTs"
    >
  >;
  onRunStarted?: (params: {
    runId: string;
    sessionId: string;
    timeoutMs: number;
  }) =>
    | RealtimeVoiceAgentConsultRunRegistration
    | void
    | Promise<RealtimeVoiceAgentConsultRunRegistration | void>;
}): Promise<RealtimeVoiceAgentConsultResult> {
  params.abortSignal?.throwIfAborted();
  const [{ beginSessionWorkAdmission }, { resolveSessionWorkStartError }] = await Promise.all([
    import("../sessions/session-lifecycle-admission.js"),
    import("../config/sessions/lifecycle.js"),
  ]);
  params.abortSignal?.throwIfAborted();
  const {
    agentId,
    agentDir,
    workspaceDir,
    cwd,
    storePath,
    sessionEntry: initialSessionEntry,
    deliveryContext: resolvedDeliveryContext,
  } = await prepareRealtimeVoiceAgentExecutionContext(params);
  const modelLockParams = {
    cfg: params.cfg,
    agentRuntime: params.agentRuntime,
    agentId,
    sessionKey: params.sessionKey,
    spawnedBy: params.spawnedBy,
    storePath,
  };
  assertRealtimeVoiceAgentConsultModelSelectionUnlocked(modelLockParams);
  const lifecycleAbortController = new AbortController();
  const lifecycleInterruption = new Error(
    "Realtime voice agent consult interrupted by a session lifecycle change.",
  );
  const sessionWorkAdmission = await beginSessionWorkAdmission({
    agentId,
    scope: storePath,
    identities: [params.sessionKey, initialSessionEntry?.sessionId],
    onInterrupt: () => lifecycleAbortController.abort(lifecycleInterruption),
    assertAllowed: () => {
      const currentEntry = params.agentRuntime.session.getSessionEntry({
        agentId,
        storePath,
        sessionKey: params.sessionKey,
        readConsistency: "latest",
      });
      const changed = initialSessionEntry
        ? !currentEntry || currentEntry.sessionId !== initialSessionEntry.sessionId
        : Boolean(currentEntry);
      if (changed) {
        throw new Error(`Session "${params.sessionKey}" changed while starting work. Retry.`);
      }
      const archivedSessionError = resolveSessionWorkStartError(params.sessionKey, currentEntry);
      if (archivedSessionError) {
        throw new Error(archivedSessionError);
      }
      assertRealtimeVoiceAgentConsultModelSelectionUnlocked(modelLockParams);
    },
  });
  const abortFromCaller = () => lifecycleAbortController.abort(params.abortSignal?.reason);
  if (params.abortSignal?.aborted) {
    abortFromCaller();
  } else {
    params.abortSignal?.addEventListener("abort", abortFromCaller, { once: true });
  }

  try {
    return await sessionWorkAdmission.run(async () => {
      await params.agentRuntime.ensureAgentWorkspace({
        dir: workspaceDir,
        guard: {
          assertHost: () => {
            lifecycleAbortController.signal.throwIfAborted();
            if (!sessionWorkAdmission.isActive()) {
              throw lifecycleInterruption;
            }
          },
        },
      });

      // The consult session stores normal session metadata so subsequent voice turns can keep
      // routing and, in fork mode, recover useful conversation context from the requester.
      const sessionEntry = await resolveRealtimeVoiceAgentConsultSessionEntry({
        agentId,
        cfg: params.cfg,
        sessionKey: params.sessionKey,
        spawnedBy: params.spawnedBy,
        senderIsOwner: params.senderIsOwner,
        contextMode: params.contextMode,
        deliveryContext: resolvedDeliveryContext,
        storePath,
        agentRuntime: params.agentRuntime,
        logger: params.logger,
        assertCurrent: () => {
          lifecycleAbortController.signal.throwIfAborted();
          if (!sessionWorkAdmission.isActive()) {
            throw lifecycleInterruption;
          }
        },
      });
      const consultDeliveryContext =
        resolvedDeliveryContext ?? deliveryContextFromSession(sessionEntry);
      const toolAuthorityOverlay = buildRealtimeVoiceAgentToolAuthorityOverlay({
        ...params,
        sessionEntry,
        deliveryContext: consultDeliveryContext,
      });
      const sessionId = sessionEntry.sessionId;
      assertRealtimeVoiceAgentConsultModelSelectionUnlocked(modelLockParams);

      const runId = `${params.runIdPrefix}-${randomUUID()}`;
      const timeoutMs =
        params.timeoutMs ?? params.agentRuntime.resolveAgentTimeoutMs({ cfg: params.cfg });
      const runRegistration = await params.onRunStarted?.({ runId, sessionId, timeoutMs });
      const abortSignal = runRegistration?.abortSignal
        ? AbortSignal.any([lifecycleAbortController.signal, runRegistration.abortSignal])
        : lifecycleAbortController.signal;
      try {
        abortSignal.throwIfAborted();
        assertRealtimeVoiceAgentConsultModelSelectionUnlocked(modelLockParams);
      } catch (error) {
        runRegistration?.cleanupBeforeRun?.();
        runRegistration?.cleanup?.();
        throw error;
      }

      // Voice consults suppress verbose/reasoning output because the bridge needs a short,
      // speakable answer, not agent-run diagnostics or hidden reasoning artifacts.
      const runPromise = params.agentRuntime.runEmbeddedAgent({
        sessionId,
        sessionKey: params.sessionKey,
        sessionTarget: {
          agentId,
          sessionId,
          sessionKey: params.sessionKey,
          storePath,
        },
        sandboxSessionKey: resolveRealtimeVoiceAgentSandboxSessionKey(agentId, params.sessionKey),
        agentId,
        ...toolAuthorityOverlay,
        // ASR voice ingress has no trace/client-tool or privileged handoff capability.
        messageProvider: toolAuthorityOverlay.messageProvider,
        messageTo: consultDeliveryContext?.to,
        messageThreadId: consultDeliveryContext?.threadId,
        currentChannelId: consultDeliveryContext?.to,
        currentThreadTs:
          consultDeliveryContext?.threadId != null
            ? String(consultDeliveryContext.threadId)
            : undefined,
        workspaceDir,
        cwd,
        config: params.cfg,
        prompt: buildRealtimeVoiceAgentConsultPrompt({
          args: params.args,
          transcript: params.transcript,
          surface: params.surface,
          userLabel: params.userLabel,
          assistantLabel: params.assistantLabel,
          questionSourceLabel: params.questionSourceLabel,
        }),
        provider: params.provider,
        model: params.model,
        thinkLevel: params.thinkLevel ?? "high",
        fastMode: params.fastMode,
        verboseLevel: "off",
        reasoningLevel: "off",
        toolResultFormat: "plain",
        execSession: sessionEntry,
        sessionRoot: normalizeOptionalString(sessionEntry.sessionRoot),
        toolsAllow: params.toolsAllow,
        toolBindings: params.toolBindings,
        timeoutMs,
        runId,
        lane: params.lane,
        extraSystemPrompt:
          params.extraSystemPrompt ??
          "You are the configured OpenClaw agent receiving delegated requests from a live voice bridge. Act on behalf of the user, use available tools when appropriate, and return a brief speakable result.",
        agentDir,
        ...params.prepareToolContext?.(sessionEntry),
        abortSignal,
      });
      const result = await runPromise
        .catch((error: unknown) => {
          assertRealtimeVoiceConsultNotInterrupted(abortSignal);
          throw error;
        })
        .finally(() => runRegistration?.cleanup?.());
      assertRealtimeVoiceConsultNotInterrupted(abortSignal, result.meta);

      if (result.meta?.yielded === true) {
        const acknowledgment =
          typeof result.meta.yieldAcknowledgment === "string"
            ? truncateUtf16Safe(
                result.meta.yieldAcknowledgment.replaceAll(/\s+/g, " ").trim(),
                REALTIME_VOICE_YIELD_ACK_MAX_CHARS,
              )
            : "";
        return {
          text: acknowledgment || REALTIME_VOICE_YIELD_ACK_FALLBACK,
          yielded: true,
        };
      }
      // Earlier input answers remain in history; this completion speaks for the current input.
      const currentInputPayloads = (result.payloads ?? []).filter(
        (payload) => getReplyPayloadMetadata(payload)?.precedingInputAnswer !== true,
      );
      const text = collectRealtimeVoiceAgentConsultVisibleText(currentInputPayloads);
      if (!text) {
        params.logger.warn(
          "[talk] agent consult produced no answer: agent returned no speakable text",
        );
        return { text: params.fallbackText ?? "I need a moment to verify that before answering." };
      }
      return { text };
    });
  } finally {
    params.abortSignal?.removeEventListener("abort", abortFromCaller);
    sessionWorkAdmission.release();
  }
}
