import crypto from "node:crypto";
import type { OpenClawConfig } from "../../config/config.js";
import type { TemplateContext } from "../templating.js";
import type { VerboseLevel } from "../thinking.js";
import type { GetReplyOptions } from "../types.js";
import type { FollowupRun } from "./queue.js";
import { resolveAgentModelFallbacksOverride } from "../../agents/agent-scope.js";
import { runWithModelFallback } from "../../agents/model-fallback.js";
import { isCliProvider } from "../../agents/model-selection.js";
import { runEmbeddedPiAgent } from "../../agents/pi-embedded.js";
import { resolveSandboxConfigForAgent, resolveSandboxRuntimeStatus } from "../../agents/sandbox.js";
import {
  resolveAgentIdFromSessionKey,
  type SessionEntry,
  updateSessionStoreEntry,
} from "../../config/sessions.js";
import { logVerbose } from "../../globals.js";
import { registerAgentRunContext } from "../../infra/agent-events.js";
import { memLog } from "../../memory/memory-log.js";
import { buildThreadingToolContext, resolveEnforceFinalTag } from "./agent-runner-utils.js";
import {
  resolveMemoryFlushContextWindowTokens,
  resolveMemoryFlushSettings,
  shouldRunMemoryFlush,
} from "./memory-flush.js";
import { incrementCompactionCount } from "./session-updates.js";

export async function runMemoryFlushIfNeeded(params: {
  cfg: OpenClawConfig;
  followupRun: FollowupRun;
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

  const shouldFlushMemory =
    memoryFlushSettings &&
    memoryFlushWritable &&
    !params.isHeartbeat &&
    !isCliProvider(params.followupRun.run.provider, params.cfg) &&
    shouldRunMemoryFlush({
      entry:
        params.sessionEntry ??
        (params.sessionKey ? params.sessionStore?.[params.sessionKey] : undefined),
      contextWindowTokens: resolveMemoryFlushContextWindowTokens({
        modelId: params.followupRun.run.model ?? params.defaultModel,
        agentCfgContextTokens: params.agentCfgContextTokens,
      }),
      reserveTokensFloor: memoryFlushSettings.reserveTokensFloor,
      softThresholdTokens: memoryFlushSettings.softThresholdTokens,
    });

  memLog.trace("runMemoryFlushIfNeeded: decision", {
    shouldFlush: shouldFlushMemory,
    writable: memoryFlushWritable,
    isHeartbeat: params.isHeartbeat,
    sessionKey: params.sessionKey,
    totalTokens: params.sessionEntry?.totalTokens,
    compactionCount: params.sessionEntry?.compactionCount,
  });

  if (!shouldFlushMemory) {
    return params.sessionEntry;
  }

  memLog.summary("memory flush: starting", {
    sessionKey: params.sessionKey,
    totalTokens: params.sessionEntry?.totalTokens,
  });
  const flushStart = Date.now();
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
  // Track tool calls during the flush for metrics
  const toolCounts = new Map<string, number>();
  const toolErrors = new Map<string, number>();
  const writtenPaths: string[] = [];
  let flushMetrics: {
    memoriesWritten: number;
    memoryPaths: string[];
    totalToolCalls: number;
    totalToolErrors: number;
    agentDurationMs?: number;
    stopReason?: string;
    tokenUsage?: Record<string, unknown>;
    payloadCount: number;
  } | null = null;
  const flushSystemPrompt = [
    params.followupRun.run.extraSystemPrompt,
    memoryFlushSettings.systemPrompt,
  ]
    .filter(Boolean)
    .join("\n\n");
  try {
    const flushResult = await runWithModelFallback({
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
            if (evt.stream === "tool" && evt.data) {
              const toolName = String(evt.data.name ?? "unknown");
              const phase = String(evt.data.phase ?? "");
              if (phase === "start") {
                toolCounts.set(toolName, (toolCounts.get(toolName) ?? 0) + 1);
                // Track file paths written to (memory file captures)
                if (toolName === "write") {
                  const args = evt.data.args as Record<string, unknown> | undefined;
                  const filePath = typeof args?.path === "string" ? args.path : undefined;
                  if (filePath) {
                    writtenPaths.push(filePath);
                  }
                }
              }
              if (phase === "result" && evt.data.isError) {
                toolErrors.set(toolName, (toolErrors.get(toolName) ?? 0) + 1);
              }
            }
          },
        });
      },
    });
    // Extract metrics from the flush agent run
    const flushMeta = flushResult.result.meta;
    const flushPayloads = flushResult.result.payloads ?? [];
    const memoryFilesWritten = writtenPaths.filter(
      (p) => p.includes("/memory/") || p.includes("/memory\\") || p.endsWith(".md"),
    );
    const totalToolCalls = Array.from(toolCounts.values()).reduce((a, b) => a + b, 0);
    const totalToolErrors = Array.from(toolErrors.values()).reduce((a, b) => a + b, 0);

    memLog.trace("memory flush: agent run completed", {
      sessionKey: params.sessionKey,
      durationMs: flushMeta.durationMs,
      stopReason: flushMeta.stopReason,
      aborted: flushMeta.aborted,
      payloadCount: flushPayloads.length,
      errorPayloads: flushPayloads.filter((p) => p.isError).length,
      totalToolCalls,
      totalToolErrors,
      toolCallBreakdown: Object.fromEntries(toolCounts),
      toolErrorBreakdown: totalToolErrors > 0 ? Object.fromEntries(toolErrors) : undefined,
      memoriesWritten: memoryFilesWritten.length,
      memoryPaths: memoryFilesWritten,
      allWrittenPaths: writtenPaths,
      usage: flushMeta.agentMeta?.usage,
      pendingToolCalls: flushMeta.pendingToolCalls?.map((tc) => tc.name),
      provider: flushResult.provider,
      model: flushResult.model,
      fallbackAttempts: flushResult.attempts?.length ?? 0,
    });

    flushMetrics = {
      memoriesWritten: memoryFilesWritten.length,
      memoryPaths: memoryFilesWritten,
      totalToolCalls,
      totalToolErrors,
      agentDurationMs: flushMeta.durationMs,
      stopReason: flushMeta.stopReason,
      tokenUsage: flushMeta.agentMeta?.usage ? { ...flushMeta.agentMeta.usage } : undefined,
      payloadCount: flushPayloads.length,
    };

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
    const msg = String(err);
    logVerbose(`memory flush run failed: ${msg}`);
    memLog.error("memory flush: failed", {
      error: msg,
      sessionKey: params.sessionKey,
      elapsedMs: Date.now() - flushStart,
    });
  }

  const elapsedMs = Date.now() - flushStart;
  const memoriesWritten = flushMetrics?.memoriesWritten ?? 0;
  const summaryParts = [
    `memory flush: completed in ${elapsedMs}ms`,
    `memories_written=${memoriesWritten}`,
    `tool_calls=${flushMetrics?.totalToolCalls ?? 0}`,
  ];
  if (flushMetrics?.totalToolErrors) {
    summaryParts.push(`tool_errors=${flushMetrics.totalToolErrors}`);
  }
  if (memoryCompactionCompleted) {
    summaryParts.push("compaction=yes");
  }
  memLog.summary(summaryParts.join(" | "), {
    sessionKey: params.sessionKey,
    compactionCompleted: memoryCompactionCompleted,
    elapsedMs,
    ...(flushMetrics ?? {}),
  });

  return activeSessionEntry;
}
