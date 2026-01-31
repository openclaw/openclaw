import crypto from "node:crypto";
import fs from "node:fs";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { estimateMessagesTokens } from "../../agents/compaction.js";
import { resolveAgentModelFallbacksOverride } from "../../agents/agent-scope.js";
import { runWithModelFallback } from "../../agents/model-fallback.js";
import { isCliProvider } from "../../agents/model-selection.js";
import { runEmbeddedPiAgent } from "../../agents/pi-embedded.js";
import { derivePromptTokens, normalizeUsage, type UsageLike } from "../../agents/usage.js";
import { resolveSandboxConfigForAgent, resolveSandboxRuntimeStatus } from "../../agents/sandbox.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  resolveAgentIdFromSessionKey,
  resolveSessionFilePath,
  type SessionEntry,
  updateSessionStoreEntry,
} from "../../config/sessions.js";
import { logVerbose } from "../../globals.js";
import { registerAgentRunContext } from "../../infra/agent-events.js";
import type { TemplateContext } from "../templating.js";
import type { VerboseLevel } from "../thinking.js";
import type { GetReplyOptions } from "../types.js";
import { buildThreadingToolContext, resolveEnforceFinalTag } from "./agent-runner-utils.js";
import {
  resolveMemoryFlushContextWindowTokens,
  resolveMemoryFlushSettings,
  shouldRunMemoryFlush,
} from "./memory-flush.js";
import type { FollowupRun } from "./queue.js";
import { incrementCompactionCount } from "./session-updates.js";

export function estimatePromptTokensForMemoryFlush(prompt?: string): number | undefined {
  const trimmed = prompt?.trim();
  if (!trimmed) {
    return undefined;
  }
  const message: AgentMessage = { role: "user", content: trimmed, timestamp: Date.now() };
  const tokens = estimateMessagesTokens([message]);
  if (!Number.isFinite(tokens) || tokens <= 0) {
    return undefined;
  }
  return Math.ceil(tokens);
}

const isPositiveNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;

export function resolveEffectivePromptTokens(params: {
  baseTotalTokens?: number;
  transcriptTotalTokens?: number;
  promptTokenEstimate?: number;
}): number {
  const lastPromptTokens = Math.max(params.baseTotalTokens ?? 0, params.transcriptTotalTokens ?? 0);
  if (params.promptTokenEstimate) {
    return lastPromptTokens + params.promptTokenEstimate;
  }
  return lastPromptTokens;
}

export async function readPromptTokensFromSessionLog(
  sessionId?: string,
  sessionEntry?: SessionEntry,
  sessionKey?: string,
): Promise<number | undefined> {
  if (!sessionId) {
    return undefined;
  }
  const agentId = sessionEntry?.sessionFile ? undefined : resolveAgentIdFromSessionKey(sessionKey);
  const logPath = resolveSessionFilePath(
    sessionId,
    sessionEntry,
    agentId ? { agentId } : undefined,
  );

  try {
    const lines = (await fs.promises.readFile(logPath, "utf-8")).split(/\n+/);
    // Use the latest usage entry to mirror how totalTokens is stored in session updates.
    let lastTotalTokens: number | undefined;
    let sawUsage = false;
    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      try {
        const parsed = JSON.parse(line) as {
          message?: { usage?: UsageLike };
          usage?: UsageLike;
        };
        const usageRaw = parsed.message?.usage ?? parsed.usage;
        const usage = normalizeUsage(usageRaw);
        if (usage) {
          sawUsage = true;
          const promptTokens = derivePromptTokens(usage) ?? usage.input ?? 0;
          const outputTokens = usage.output ?? 0;
          const entryTotal = usage.total ?? promptTokens + outputTokens;
          if (Number.isFinite(entryTotal) && entryTotal > 0) {
            lastTotalTokens = entryTotal;
          }
        }
      } catch {
        // ignore bad lines
      }
    }
    if (!sawUsage) {
      return undefined;
    }
    return lastTotalTokens && lastTotalTokens > 0 ? lastTotalTokens : undefined;
  } catch {
    return undefined;
  }
}

export async function runMemoryFlushIfNeeded(params: {
  cfg: OpenClawConfig;
  followupRun: FollowupRun;
  promptForEstimate?: string;
  sessionCtx: TemplateContext;
  opts?: GetReplyOptions;
  defaultModel: string;
  agentCfgContextTokens?: number;
  resolvedVerboseLevel: VerboseLevel;
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  storePath?: string;
  isHeartbeat: boolean;
}): Promise<SessionEntry | undefined> {
  const memoryFlushSettings = resolveMemoryFlushSettings(params.cfg);
  if (!memoryFlushSettings) {
    return params.sessionEntry;
  }

  const memoryFlushWritable = (() => {
    if (!params.sessionKey) {
      return true;
    }
    const runtime = resolveSandboxRuntimeStatus({
      cfg: params.cfg,
      sessionKey: params.sessionKey,
    });
    if (!runtime.sandboxed) {
      return true;
    }
    const sandboxCfg = resolveSandboxConfigForAgent(params.cfg, runtime.agentId);
    return sandboxCfg.workspaceAccess === "rw";
  })();

  const isCli = isCliProvider(params.followupRun.run.provider, params.cfg);
  const entry =
    params.sessionEntry ??
    (params.sessionKey ? params.sessionStore?.[params.sessionKey] : undefined);
  const contextWindowTokens = resolveMemoryFlushContextWindowTokens({
    modelId: params.followupRun.run.model ?? params.defaultModel,
    agentCfgContextTokens: params.agentCfgContextTokens,
  });

  const promptTokenEstimate = estimatePromptTokensForMemoryFlush(
    params.promptForEstimate ?? params.followupRun.prompt,
  );
  const baseTotalTokens = entry?.totalTokens;
  const shouldReadTranscript = !isPositiveNumber(baseTotalTokens);
  const transcriptTotalTokens = shouldReadTranscript
    ? await readPromptTokensFromSessionLog(
        params.followupRun.run.sessionId,
        entry,
        params.sessionKey ?? params.followupRun.run.sessionKey,
      )
    : undefined;
  const effectivePromptTokens = resolveEffectivePromptTokens({
    baseTotalTokens,
    transcriptTotalTokens,
    promptTokenEstimate,
  });
  const effectiveEntry =
    entry && typeof effectivePromptTokens === "number" && effectivePromptTokens > 0
      ? { ...entry, totalTokens: effectivePromptTokens }
      : entry;

  // Diagnostic logging to understand why memory flush may not trigger
  const totalTokens = effectiveEntry?.totalTokens;
  const threshold =
    contextWindowTokens -
    memoryFlushSettings.reserveTokensFloor -
    memoryFlushSettings.softThresholdTokens;
  logVerbose(
    `memoryFlush check: sessionKey=${params.sessionKey} totalTokens=${totalTokens ?? "undefined"} ` +
      `contextWindow=${contextWindowTokens} threshold=${threshold} ` +
      `isHeartbeat=${params.isHeartbeat} isCli=${isCli} memoryFlushWritable=${memoryFlushWritable} ` +
      `compactionCount=${effectiveEntry?.compactionCount ?? 0} memoryFlushCompactionCount=${effectiveEntry?.memoryFlushCompactionCount ?? "undefined"} ` +
      `promptTokensEst=${promptTokenEstimate ?? "undefined"} transcriptTotalTokens=${transcriptTotalTokens ?? "undefined"}`,
  );

  const shouldFlushMemory =
    memoryFlushSettings &&
    memoryFlushWritable &&
    !params.isHeartbeat &&
    !isCli &&
    shouldRunMemoryFlush({
      entry: effectiveEntry,
      contextWindowTokens,
      reserveTokensFloor: memoryFlushSettings.reserveTokensFloor,
      softThresholdTokens: memoryFlushSettings.softThresholdTokens,
    });

  if (!shouldFlushMemory) {
    return params.sessionEntry;
  }

  logVerbose(
    `memoryFlush triggered: sessionKey=${params.sessionKey} totalTokens=${totalTokens} threshold=${threshold}`,
  );

  let activeSessionEntry = params.sessionEntry;
  const activeSessionStore = params.sessionStore;
  const flushRunId = crypto.randomUUID();
  if (params.sessionKey) {
    registerAgentRunContext(flushRunId, {
      sessionKey: params.sessionKey,
      verboseLevel: params.resolvedVerboseLevel,
    });
  }
  let memoryCompactionCompleted = false;
  const flushSystemPrompt = [
    params.followupRun.run.extraSystemPrompt,
    memoryFlushSettings.systemPrompt,
  ]
    .filter(Boolean)
    .join("\n\n");
  try {
    await runWithModelFallback({
      cfg: params.followupRun.run.config,
      provider: params.followupRun.run.provider,
      model: params.followupRun.run.model,
      agentDir: params.followupRun.run.agentDir,
      fallbacksOverride: resolveAgentModelFallbacksOverride(
        params.followupRun.run.config,
        resolveAgentIdFromSessionKey(params.followupRun.run.sessionKey),
      ),
      run: (provider, model) => {
        const authProfileId =
          provider === params.followupRun.run.provider
            ? params.followupRun.run.authProfileId
            : undefined;
        return runEmbeddedPiAgent({
          sessionId: params.followupRun.run.sessionId,
          sessionKey: params.sessionKey,
          messageProvider: params.sessionCtx.Provider?.trim().toLowerCase() || undefined,
          agentAccountId: params.sessionCtx.AccountId,
          messageTo: params.sessionCtx.OriginatingTo ?? params.sessionCtx.To,
          messageThreadId: params.sessionCtx.MessageThreadId ?? undefined,
          // Provider threading context for tool auto-injection
          ...buildThreadingToolContext({
            sessionCtx: params.sessionCtx,
            config: params.followupRun.run.config,
            hasRepliedRef: params.opts?.hasRepliedRef,
          }),
          senderId: params.sessionCtx.SenderId?.trim() || undefined,
          senderName: params.sessionCtx.SenderName?.trim() || undefined,
          senderUsername: params.sessionCtx.SenderUsername?.trim() || undefined,
          senderE164: params.sessionCtx.SenderE164?.trim() || undefined,
          sessionFile: params.followupRun.run.sessionFile,
          workspaceDir: params.followupRun.run.workspaceDir,
          agentDir: params.followupRun.run.agentDir,
          config: params.followupRun.run.config,
          skillsSnapshot: params.followupRun.run.skillsSnapshot,
          prompt: memoryFlushSettings.prompt,
          extraSystemPrompt: flushSystemPrompt,
          ownerNumbers: params.followupRun.run.ownerNumbers,
          enforceFinalTag: resolveEnforceFinalTag(params.followupRun.run, provider),
          provider,
          model,
          authProfileId,
          authProfileIdSource: authProfileId
            ? params.followupRun.run.authProfileIdSource
            : undefined,
          thinkLevel: params.followupRun.run.thinkLevel,
          verboseLevel: params.followupRun.run.verboseLevel,
          reasoningLevel: params.followupRun.run.reasoningLevel,
          execOverrides: params.followupRun.run.execOverrides,
          bashElevated: params.followupRun.run.bashElevated,
          timeoutMs: params.followupRun.run.timeoutMs,
          runId: flushRunId,
          onAgentEvent: (evt) => {
            if (evt.stream === "compaction") {
              const phase = typeof evt.data.phase === "string" ? evt.data.phase : "";
              const willRetry = Boolean(evt.data.willRetry);
              if (phase === "end" && !willRetry) {
                memoryCompactionCompleted = true;
              }
            }
          },
        });
      },
    });
    let memoryFlushCompactionCount =
      activeSessionEntry?.compactionCount ??
      (params.sessionKey ? activeSessionStore?.[params.sessionKey]?.compactionCount : 0) ??
      0;
    if (memoryCompactionCompleted) {
      const nextCount = await incrementCompactionCount({
        sessionEntry: activeSessionEntry,
        sessionStore: activeSessionStore,
        sessionKey: params.sessionKey,
        storePath: params.storePath,
      });
      if (typeof nextCount === "number") {
        memoryFlushCompactionCount = nextCount;
      }
    }
    if (params.storePath && params.sessionKey) {
      try {
        const updatedEntry = await updateSessionStoreEntry({
          storePath: params.storePath,
          sessionKey: params.sessionKey,
          update: async () => ({
            memoryFlushAt: Date.now(),
            memoryFlushCompactionCount,
          }),
        });
        if (updatedEntry) {
          activeSessionEntry = updatedEntry;
        }
      } catch (err) {
        logVerbose(`failed to persist memory flush metadata: ${String(err)}`);
      }
    }
  } catch (err) {
    logVerbose(`memory flush run failed: ${String(err)}`);
  }

  return activeSessionEntry;
}
