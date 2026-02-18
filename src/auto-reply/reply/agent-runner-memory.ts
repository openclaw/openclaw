import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
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
import {
  buildEmbeddedContextFromTemplate,
  buildTemplateSenderContext,
  resolveRunAuthProfile,
} from "./agent-runner-utils.js";
import { resolveEnforceFinalTag } from "./agent-runner-utils.js";
import {
  resolveMemoryFlushContextWindowTokens,
  resolveMemoryFlushPromptForRun,
  resolveMemoryFlushSettings,
  shouldRunMemoryFlush,
} from "./memory-flush.js";
import { routeReply } from "./route-reply.js";
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

  if (!shouldFlushMemory) {
    return params.sessionEntry;
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
        const authProfile = resolveRunAuthProfile(params.followupRun.run, provider);
        const embeddedContext = buildEmbeddedContextFromTemplate({
          run: params.followupRun.run,
          sessionCtx: params.sessionCtx,
          hasRepliedRef: params.opts?.hasRepliedRef,
        });
        const senderContext = buildTemplateSenderContext(params.sessionCtx);
        return runEmbeddedPiAgent({
          ...embeddedContext,
          ...senderContext,
          sessionFile: params.followupRun.run.sessionFile,
          workspaceDir: params.followupRun.run.workspaceDir,
          agentDir: params.followupRun.run.agentDir,
          config: params.followupRun.run.config,
          skillsSnapshot: params.followupRun.run.skillsSnapshot,
          prompt: resolveMemoryFlushPromptForRun({
            prompt: memoryFlushSettings.prompt,
            cfg: params.cfg,
          }),
          extraSystemPrompt: flushSystemPrompt,
          ownerNumbers: params.followupRun.run.ownerNumbers,
          enforceFinalTag: resolveEnforceFinalTag(params.followupRun.run, provider),
          provider,
          model,
          ...authProfile,
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
              if (phase === "end") {
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
            // Set verification gate — blocks future messages until user confirms
            // context has been restored after the memory flush.
            compactionPendingVerification: true,
          }),
        });
        if (updatedEntry) {
          activeSessionEntry = updatedEntry;
        }
      } catch (err) {
        logVerbose(`failed to persist memory flush metadata: ${String(err)}`);
      }

      // Proactive DM handoff — send formatted summary to DM channel immediately
      // after setting the gate, so the user is notified without having to message
      // first. This fires in code regardless of prompt compliance.
      const compactionCfg = params.cfg?.agents?.defaults?.compaction;
      const dmChannelId = compactionCfg?.dmChannelId;
      const dmProvider = compactionCfg?.dmChannelProvider ?? "discord";
      const workspaceDir = params.followupRun.run.workspaceDir;
      if (dmChannelId && workspaceDir) {
        try {
          let summary = "";
          try {
            const raw = await fs.readFile(
              path.join(workspaceDir, ".context-transfer.json"),
              "utf-8",
            );
            const data = JSON.parse(raw);
            const lines: string[] = [];
            const nextActions = Array.isArray(data.nextActions) ? data.nextActions.slice(0, 3) : [];
            if (nextActions.length > 0) {
              lines.push("**Where we were:**");
              for (const item of nextActions) {
                if (item && typeof item === "object") {
                  const p = typeof item.priority === "number" ? `${item.priority}.` : "•";
                  const action =
                    typeof item.action === "string" ? item.action : JSON.stringify(item);
                  const ctx = typeof item.context === "string" ? ` — ${item.context}` : "";
                  lines.push(`${p} ${action}${ctx}`);
                }
              }
            }
            const tasks = Array.isArray(data.activeTasks) ? data.activeTasks : [];
            if (tasks.length > 0) {
              lines.push("\n**Active tasks:**");
              for (const t of tasks) {
                if (t && typeof t === "object") {
                  const desc =
                    typeof t.description === "string" ? t.description : JSON.stringify(t);
                  const status = typeof t.status === "string" ? ` [${t.status}]` : "";
                  lines.push(`• ${desc}${status}`);
                }
              }
            }
            const decisions = Array.isArray(data.pendingDecisions) ? data.pendingDecisions : [];
            if (decisions.length > 0) {
              lines.push("\n**Pending decisions:**");
              for (const d of decisions) {
                lines.push(`• ${typeof d === "string" ? d : JSON.stringify(d)}`);
              }
            }
            if (lines.length > 0) {
              summary = "\n\n" + lines.join("\n");
            }
          } catch {
            // .context-transfer.json may not exist — that's fine
          }
          const dmText = `⏸️ **Context compacted — pausing for your direction.**${summary || ""}\n\nI'm not doing anything until you tell me what to do next. Reply here to direct me.`;
          await routeReply({
            payload: { text: dmText },
            channel: dmProvider as Parameters<typeof routeReply>[0]["channel"],
            to: dmChannelId,
            sessionKey: params.sessionKey ?? "",
            cfg: params.cfg,
          });
        } catch (err) {
          logVerbose(`failed to send post-compaction DM handoff: ${String(err)}`);
        }
      }
    }
  } catch (err) {
    logVerbose(`memory flush run failed: ${String(err)}`);
  }

  return activeSessionEntry;
}
