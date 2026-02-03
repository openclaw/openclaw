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
import { createInternalHookEvent, triggerInternalHook } from "../../hooks/internal-hooks.js";
import { registerAgentRunContext } from "../../infra/agent-events.js";
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
}): Promise<{ entry: SessionEntry | undefined; hookMessages: string[] }> {
  const memoryFlushSettings = resolveMemoryFlushSettings(params.cfg);
  if (!memoryFlushSettings) {
    return { entry: params.sessionEntry, hookMessages: [] };
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

  const entryForFlush =
    params.sessionEntry ??
    (params.sessionKey ? params.sessionStore?.[params.sessionKey] : undefined);

  const shouldFlushMemory =
    memoryFlushSettings &&
    memoryFlushWritable &&
    !params.isHeartbeat &&
    !isCliProvider(params.followupRun.run.provider, params.cfg) &&
    shouldRunMemoryFlush({
      entry: entryForFlush,
      contextWindowTokens: resolveMemoryFlushContextWindowTokens({
        modelId: params.followupRun.run.model ?? params.defaultModel,
        agentCfgContextTokens: params.agentCfgContextTokens,
      }),
      reserveTokensFloor: memoryFlushSettings.reserveTokensFloor,
      softThresholdTokens: memoryFlushSettings.softThresholdTokens,
    });

  if (!shouldFlushMemory) {
    return { entry: params.sessionEntry, hookMessages: [] };
  }

  // Lifecycle hook: Memory Flush Start
  // Emit whenever a flush runs, regardless of whether we can persist metadata
  let flushHookMessages: string[] = [];
  if (params.sessionKey) {
    // Report the same totalTokens that triggered shouldRunMemoryFlush decision.
    // This is the last persisted token count; should always be valid when flush fires.
    const contextTokensUsed = entryForFlush?.totalTokens ?? 0;
    const hookEvent = createInternalHookEvent("agent", "flush", params.sessionKey, {
      sessionId: params.followupRun.run.sessionId,
      contextTokensUsed,
      reason: "context_limit",
    });
    await triggerInternalHook(hookEvent);
    flushHookMessages = hookEvent.messages;
  }

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

  return { entry: activeSessionEntry, hookMessages: flushHookMessages };
}
