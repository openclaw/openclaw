import { randomUUID } from "node:crypto";
import type { RunEmbeddedAgentParams } from "../agents/embedded-agent-runner/run/params.js";
import {
  forkSessionFromParent,
  resolveParentForkDecision,
} from "../auto-reply/reply/session-fork.js";
import { parseSessionThreadInfoFast } from "../config/sessions/thread-info.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { RuntimeLogger, PluginRuntimeCore } from "../plugins/runtime/types-core.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import {
  deliveryContextFromSession,
  normalizeDeliveryContext,
  type DeliveryContext,
} from "../utils/delivery-context.shared.js";
import {
  buildRealtimeVoiceAgentConsultPrompt,
  collectRealtimeVoiceAgentConsultVisibleText,
  type RealtimeVoiceAgentConsultTranscriptEntry,
} from "./agent-consult-tool.js";

export type RealtimeVoiceAgentConsultRuntime = PluginRuntimeCore["agent"];
export type RealtimeVoiceAgentConsultResult = { text: string };
export type RealtimeVoiceAgentConsultContextMode = "isolated" | "fork";
export {
  resolveRealtimeVoiceAgentConsultTools,
  resolveRealtimeVoiceAgentConsultToolsAllow,
} from "./agent-consult-tool.js";

type RealtimeVoiceAgentConsultDeps = {
  randomUUID: typeof randomUUID;
  resolveParentForkDecision: typeof resolveParentForkDecision;
  forkSessionFromParent: typeof forkSessionFromParent;
};

const defaultRealtimeVoiceAgentConsultDeps: RealtimeVoiceAgentConsultDeps = {
  randomUUID,
  resolveParentForkDecision,
  forkSessionFromParent,
};

let realtimeVoiceAgentConsultDeps = defaultRealtimeVoiceAgentConsultDeps;

export function setRealtimeVoiceAgentConsultDepsForTest(
  deps: Partial<RealtimeVoiceAgentConsultDeps> | null,
): void {
  realtimeVoiceAgentConsultDeps = deps
    ? { ...defaultRealtimeVoiceAgentConsultDeps, ...deps }
    : defaultRealtimeVoiceAgentConsultDeps;
}

function resolveRealtimeVoiceAgentSandboxSessionKey(agentId: string, sessionKey: string): string {
  const trimmed = sessionKey.trim();
  if (trimmed.toLowerCase().startsWith("agent:")) {
    return trimmed;
  }
  return `agent:${agentId}:${trimmed}`;
}

function hasRoutableDeliveryContext(
  context: DeliveryContext | undefined,
): context is DeliveryContext & { channel: string; to: string } {
  return Boolean(context?.channel && context?.to);
}

function resolveDeliverySessionFields(context?: DeliveryContext): Partial<SessionEntry> {
  const normalized = normalizeDeliveryContext(context);
  if (!normalized?.channel || !normalized.to) {
    return {};
  }
  return {
    deliveryContext: normalized,
    lastChannel: normalized.channel,
    lastTo: normalized.to,
    lastAccountId: normalized.accountId,
    lastThreadId: normalized.threadId,
  };
}

function resolveRealtimeVoiceAgentDeliveryContext(params: {
  agentRuntime: RealtimeVoiceAgentConsultRuntime;
  agentId: string;
  cfg: OpenClawConfig;
  sessionKey: string;
  spawnedBy?: string | null;
}): DeliveryContext | undefined {
  const requesterSessionKey = params.spawnedBy?.trim();
  try {
    const candidates: string[] = [];
    if (requesterSessionKey) {
      const { baseSessionKey } = parseSessionThreadInfoFast(requesterSessionKey);
      candidates.push(
        ...[requesterSessionKey, baseSessionKey].filter((key): key is string => Boolean(key)),
      );
    }
    candidates.push(params.sessionKey);
    for (const key of candidates) {
      const parsed = parseAgentSessionKey(key);
      const entry = params.agentRuntime.session.getSessionEntry({
        agentId: parsed?.agentId ?? params.agentId,
        config: params.cfg,
        sessionKey: key,
      });
      const context = deliveryContextFromSession(entry);
      if (hasRoutableDeliveryContext(context)) {
        return context;
      }
    }
  } catch {
    // Best-effort routing enrichment only; consults should still work without it.
  }
  return undefined;
}

async function resolveRealtimeVoiceAgentConsultSessionEntry(params: {
  agentId: string;
  cfg: OpenClawConfig;
  sessionKey: string;
  spawnedBy?: string | null;
  contextMode?: RealtimeVoiceAgentConsultContextMode;
  deliveryContext?: DeliveryContext;
  agentRuntime: RealtimeVoiceAgentConsultRuntime;
  logger: Pick<RuntimeLogger, "warn">;
}): Promise<SessionEntry> {
  const now = Date.now();
  const deliveryFields = resolveDeliverySessionFields(params.deliveryContext);
  const requesterSessionKey = params.spawnedBy?.trim();
  const requesterAgentId = parseAgentSessionKey(requesterSessionKey)?.agentId;
  const parentAgentId = requesterAgentId ?? params.agentId;
  const shouldFork = params.contextMode === "fork" && requesterSessionKey;
  let forkDecisionWarning: string | undefined;

  const patched = await params.agentRuntime.session.patchSessionEntry({
    agentId: params.agentId,
    config: params.cfg,
    sessionKey: params.sessionKey,
    fallbackEntry: {
      sessionId: "",
      updatedAt: now,
    },
    update: async (entry) => {
      if (entry.sessionId?.trim()) {
        return { ...deliveryFields, updatedAt: now };
      }
      if (shouldFork) {
        const parentEntry = params.agentRuntime.session.getSessionEntry({
          agentId: parentAgentId,
          config: params.cfg,
          sessionKey: requesterSessionKey,
        });
        if (parentEntry?.sessionId?.trim()) {
          const decision = await realtimeVoiceAgentConsultDeps.resolveParentForkDecision({
            parentEntry,
            agentId: parentAgentId,
            config: params.cfg,
          });
          if (decision.status === "fork") {
            const fork = await realtimeVoiceAgentConsultDeps.forkSessionFromParent({
              parentEntry,
              agentId: parentAgentId,
              config: params.cfg,
            });
            if (fork) {
              return {
                ...deliveryFields,
                sessionId: fork.sessionId,
                // Current fork storage is file-backed; persist the artifact on
                // the entry so the run target resolver reuses the forked branch.
                sessionFile: fork.sessionFile,
                spawnedBy: requesterSessionKey,
                forkedFromParent: true,
                updatedAt: now,
              };
            }
          } else {
            forkDecisionWarning = decision.message;
          }
        }
      }
      return {
        ...deliveryFields,
        sessionId: realtimeVoiceAgentConsultDeps.randomUUID(),
        ...(requesterSessionKey ? { spawnedBy: requesterSessionKey } : {}),
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

export async function consultRealtimeVoiceAgent(params: {
  cfg: OpenClawConfig;
  agentRuntime: RealtimeVoiceAgentConsultRuntime;
  logger: Pick<RuntimeLogger, "warn">;
  sessionKey: string;
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
  contextMode?: RealtimeVoiceAgentConsultContextMode;
  provider?: RunEmbeddedAgentParams["provider"];
  model?: RunEmbeddedAgentParams["model"];
  thinkLevel?: RunEmbeddedAgentParams["thinkLevel"];
  fastMode?: RunEmbeddedAgentParams["fastMode"];
  timeoutMs?: number;
  toolsAllow?: string[];
  extraSystemPrompt?: string;
  fallbackText?: string;
}): Promise<RealtimeVoiceAgentConsultResult> {
  const agentId = params.agentId ?? "main";
  const agentDir = params.agentRuntime.resolveAgentDir(params.cfg, agentId);
  const workspaceDir = params.agentRuntime.resolveAgentWorkspaceDir(params.cfg, agentId);
  await params.agentRuntime.ensureAgentWorkspace({ dir: workspaceDir });

  const resolvedDeliveryContext = resolveRealtimeVoiceAgentDeliveryContext({
    agentRuntime: params.agentRuntime,
    agentId,
    cfg: params.cfg,
    sessionKey: params.sessionKey,
    spawnedBy: params.spawnedBy,
  });
  const sessionEntry = await resolveRealtimeVoiceAgentConsultSessionEntry({
    agentId,
    cfg: params.cfg,
    sessionKey: params.sessionKey,
    spawnedBy: params.spawnedBy,
    contextMode: params.contextMode,
    deliveryContext: resolvedDeliveryContext,
    agentRuntime: params.agentRuntime,
    logger: params.logger,
  });
  const consultDeliveryContext =
    resolvedDeliveryContext ?? deliveryContextFromSession(sessionEntry);
  const sessionId = sessionEntry.sessionId;
  const requesterAgentId = parseAgentSessionKey(params.spawnedBy?.trim())?.agentId;
  const crossAgentForkSessionFile =
    sessionEntry.forkedFromParent && requesterAgentId && requesterAgentId !== agentId
      ? sessionEntry.sessionFile?.trim()
      : undefined;

  const result = await params.agentRuntime.runEmbeddedAgent({
    sessionId,
    sessionKey: params.sessionKey,
    // Cross-agent forks are file-backed active artifacts in the requester store.
    // Passing the artifact keeps the consult run on the forked branch until
    // consult forking moves to a storage-neutral parent/child target contract.
    ...(crossAgentForkSessionFile ? { sessionFile: crossAgentForkSessionFile } : {}),
    sandboxSessionKey: resolveRealtimeVoiceAgentSandboxSessionKey(agentId, params.sessionKey),
    agentId,
    spawnedBy: params.spawnedBy,
    messageProvider: consultDeliveryContext?.channel ?? params.messageProvider,
    agentAccountId: consultDeliveryContext?.accountId,
    messageTo: consultDeliveryContext?.to,
    messageThreadId: consultDeliveryContext?.threadId,
    currentChannelId: consultDeliveryContext?.to,
    currentThreadTs:
      consultDeliveryContext?.threadId != null
        ? String(consultDeliveryContext.threadId)
        : undefined,
    workspaceDir,
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
    toolsAllow: params.toolsAllow,
    timeoutMs: params.timeoutMs ?? params.agentRuntime.resolveAgentTimeoutMs({ cfg: params.cfg }),
    runId: `${params.runIdPrefix}:${Date.now()}`,
    lane: params.lane,
    extraSystemPrompt:
      params.extraSystemPrompt ??
      "You are the configured OpenClaw agent receiving delegated requests from a live voice bridge. Act on behalf of the user, use available tools when appropriate, and return a brief speakable result.",
    agentDir,
  });

  const text = collectRealtimeVoiceAgentConsultVisibleText(result.payloads ?? []);
  if (!text) {
    const reason = result.meta?.aborted ? "agent run aborted" : "agent returned no speakable text";
    params.logger.warn(`[talk] agent consult produced no answer: ${reason}`);
    return { text: params.fallbackText ?? "I need a moment to verify that before answering." };
  }
  return { text };
}
