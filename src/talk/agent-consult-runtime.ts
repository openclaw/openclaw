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
import type { ReplyToolAuthorityOverlay } from "../sessions/session-controller.contracts.js";
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
import { resolveDueVoiceSessionReset } from "./voice-session-reset.js";

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

/**
 * Voice turns honor the configured session reset like typed turns: a stale session rolls over
 * in place (same session id, reset boundary in its transcript) instead of replaying old context.
 */
async function rollOverStaleConsultSession(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  storePath: string;
  cwd: string;
  entry: SessionEntry | undefined;
  logger: Pick<RuntimeLogger, "warn">;
  abortSignal?: AbortSignal;
}): Promise<void> {
  const { agentId, sessionKey, storePath, entry } = params;
  const reason = await resolveDueVoiceSessionReset(params);
  if (!reason || !entry) {
    return;
  }
  const [
    { resetSessionEntryLifecycle },
    { createSessionWorkStartChangedError, resolveSessionWorkStartError },
    { normalizeStoreSessionKey },
    { clearRotatedSessionMetadata },
    { clearCommittedSessionResetRuntimeState },
  ] = await Promise.all([
    import("../config/sessions/session-accessor.lifecycle.js"),
    import("../config/sessions/lifecycle.js"),
    import("../config/sessions/store-entry.js"),
    import("../agents/session-reset-metadata.js"),
    import("../auto-reply/reply/session-reset-cleanup.js"),
  ]);
  const now = Date.now();
  await resetSessionEntryLifecycle({
    agentId,
    storePath,
    target: { canonicalKey: normalizeStoreSessionKey(sessionKey), storeKeys: [sessionKey] },
    // A consult cancelled while preparing must not reset the session it never runs in.
    commitGuard: () => params.abortSignal?.throwIfAborted(),
    resetBoundary: {
      context: "preserve-tail",
      reason,
      cwd: params.cwd,
    },
    buildNextEntry: ({ currentEntry }) => {
      if (
        !currentEntry ||
        currentEntry.sessionId !== entry.sessionId ||
        currentEntry.lifecycleRevision !== entry.lifecycleRevision ||
        resolveSessionWorkStartError(sessionKey, currentEntry)
      ) {
        throw createSessionWorkStartChangedError(sessionKey);
      }
      return {
        ...clearRotatedSessionMetadata(currentEntry),
        lifecycleRevision: randomUUID(),
        agentHarnessId: undefined,
        sessionStartedAt: now,
        lastInteractionAt: now,
        updatedAt: now,
      };
    },
  });
  clearCommittedSessionResetRuntimeState({
    previousSessionEntry: entry,
    agentId,
    sessionKey,
    storePath,
    // Voice callers reserve their controller input before this runs; it must survive its own reset.
    preserveControllerInputs: true,
    onError: (error) =>
      params.logger.warn(`[talk] failed to clear session reset runtime state: ${String(error)}`),
  });
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
  const [{ beginSessionEffect }, { resolveSessionWorkStartError }] = await Promise.all([
    import("../sessions/session-controller.lifecycle.js"),
    import("../config/sessions/lifecycle.js"),
  ]);
  params.abortSignal?.throwIfAborted();
  const agentId =
    params.agentId ?? resolveSessionAgentId({ config: params.cfg, sessionKey: params.sessionKey });
  const storePath =
    params.storePath ??
    params.agentRuntime.session.resolveStorePath(params.cfg.session?.store, { agentId });
  const initialSessionEntry = await params.agentRuntime.session.getSessionEntryAsync({
    agentId,
    storePath,
    sessionKey: params.sessionKey,
    readConsistency: "latest",
  });
  const resolvedDeliveryContext =
    (await (async () => {
      const { cfg, agentRuntime, sessionKey, spawnedBy } = params;
      const requesterSessionKey = spawnedBy?.trim();
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
        candidates.push({ sessionKey, storePath });
        const visited = new Set<string>();
        for (const candidate of candidates) {
          const candidateAgentId = parseAgentSessionKey(candidate.sessionKey)?.agentId ?? agentId;
          const candidateStorePath =
            candidate.storePath ??
            agentRuntime.session.resolveStorePath(cfg.session?.store, {
              agentId: candidateAgentId,
            });
          const identity = `${candidateStorePath}\u0000${candidate.sessionKey}`;
          if (visited.has(identity)) {
            continue;
          }
          visited.add(identity);
          const entry =
            candidateStorePath === storePath && candidate.sessionKey === sessionKey
              ? initialSessionEntry
              : await agentRuntime.session.getSessionEntryAsync({
                  agentId: candidateAgentId,
                  storePath: candidateStorePath,
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
    })()) ?? deliveryContextFromSession(initialSessionEntry);
  const agentDir = params.agentRuntime.resolveAgentDir(params.cfg, agentId);
  const workspaceDir =
    resolveIngressWorkspaceOverrideForSessionRun({
      spawnedBy: initialSessionEntry?.spawnedBy,
      workspaceDir: initialSessionEntry?.spawnedWorkspaceDir,
      cwd: initialSessionEntry?.spawnedCwd,
    }) ?? params.agentRuntime.resolveAgentWorkspaceDir(params.cfg, agentId);
  const cwd =
    normalizeOptionalString(initialSessionEntry?.spawnedCwd) ??
    resolveAgentRunCwd(params.cfg, agentId);
  const modelLockParams = {
    cfg: params.cfg,
    agentRuntime: params.agentRuntime,
    agentId,
    sessionKey: params.sessionKey,
    spawnedBy: params.spawnedBy,
    storePath,
  };
  assertRealtimeVoiceAgentConsultModelSelectionUnlocked(modelLockParams);
  // Reset before admission: rollover cleanup interrupts work bound to the old incarnation.
  await rollOverStaleConsultSession({
    cfg: params.cfg,
    agentId,
    sessionKey: params.sessionKey,
    storePath,
    cwd: cwd ?? workspaceDir,
    entry: initialSessionEntry,
    logger: params.logger,
    abortSignal: params.abortSignal,
  });
  params.abortSignal?.throwIfAborted();
  const lifecycleAbortController = new AbortController();
  const lifecycleInterruption = new Error(
    "Realtime voice agent consult interrupted by a session lifecycle change.",
  );
  const sessionWorkAdmission = await beginSessionEffect({
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
      const sessionEntry = await (async () => {
        const { cfg, sessionKey, spawnedBy, senderIsOwner, contextMode, agentRuntime, logger } =
          params;
        const now = Date.now();
        const deliveryFields = resolveDeliverySessionFields(resolvedDeliveryContext);
        const requesterSessionKey = spawnedBy?.trim();
        const requesterAgentId = parseAgentSessionKey(requesterSessionKey)?.agentId;
        const requesterEntry = requesterSessionKey
          ? await agentRuntime.session.getSessionEntryAsync({
              agentId: requesterAgentId ?? agentId,
              storePath: agentRuntime.session.resolveStorePath(cfg.session?.store, {
                agentId: requesterAgentId ?? agentId,
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
              ...buildSpawnAuthorityReceipt(requesterEntry, senderIsOwner),
            }
          : {};
        const shouldFork =
          contextMode === "fork" &&
          requesterSessionKey &&
          (!requesterAgentId || requesterAgentId === agentId);
        let forkDecisionWarning: string | undefined;

        let patched: SessionEntry | null = null;
        if (shouldFork) {
          const { forkSessionEntryFromParent } =
            await import("../auto-reply/reply/session-fork.js");
          const forked = await forkSessionEntryFromParent({
            storePath,
            parentSessionKey: requesterSessionKey,
            agentId,
            config: cfg,
            sessionKey,
            fallbackEntry: {
              ...creationStamp,
              sessionId: "",
              updatedAt: now,
            },
            entryPatch: {
              skipExisting: true,
              skipped: { ...deliveryFields, updatedAt: now, lastInteractionAt: now },
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

        patched ??= await agentRuntime.session.prepareSessionEntryPatch({
          agentId,
          storePath,
          sessionKey,
          fallbackEntry: {
            ...creationStamp,
            sessionId: "",
            updatedAt: now,
          },
          authority: {
            kind: "host",
            assertCurrent: () => {
              lifecycleAbortController.signal.throwIfAborted();
              if (!sessionWorkAdmission.isActive()) {
                throw lifecycleInterruption;
              }
            },
          },
          prepare: (entry) => {
            if (entry.sessionId?.trim()) {
              // A spoken request is user interaction for idle reset, whichever voice surface sent it.
              return { ...deliveryFields, updatedAt: now, lastInteractionAt: now };
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
          logger.warn(`[talk] ${forkDecisionWarning}`);
        }
        if (patched?.sessionId?.trim()) {
          return patched;
        }
        throw new Error("realtime voice agent consult session could not be initialized");
      })();
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
        spawnedBy: sessionEntry.spawnedBy,
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
        prompt: buildRealtimeVoiceAgentConsultPrompt(params),
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
