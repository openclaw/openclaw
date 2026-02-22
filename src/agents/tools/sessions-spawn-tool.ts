import { Type } from "@sinclair/typebox";
import crypto from "node:crypto";
import path from "node:path";
import type { GatewayMessageChannel } from "../../utils/message-channel.js";
import type { ClaudeCodePermissionMode } from "../claude-code/types.js";
import type { AnyAgentTool } from "./common.js";
import { formatThinkingLevels, normalizeThinkLevel } from "../../auto-reply/thinking.js";
import { loadConfig } from "../../config/config.js";
import { callGateway } from "../../gateway/call.js";
import { emitAgentEvent } from "../../infra/agent-events.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  isSubagentSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../../routing/session-key.js";
import { normalizeDeliveryContext } from "../../utils/delivery-context.js";
import { resolveAgentConfig } from "../agent-scope.js";
import { gatherProjectStatus } from "../claude-code/project-status.js";
import { spawnClaudeCode, respondToPermission } from "../claude-code/runner.js";
import { selectSession } from "../claude-code/session-selection.js";
import { resolveSession } from "../claude-code/sessions.js";
import { AGENT_LANE_SUBAGENT } from "../lanes.js";
import { optionalStringEnum } from "../schema/typebox.js";
import { buildSubagentSystemPrompt } from "../subagent-announce.js";
import { markSubagentAnnounced, registerSubagentRun } from "../subagent-registry.js";
import { jsonResult, readStringParam } from "./common.js";
import {
  resolveDisplaySessionKey,
  resolveInternalSessionKey,
  resolveMainSessionAlias,
} from "./sessions-helpers.js";

const log = createSubsystemLogger("agents/sessions-spawn");

const SessionsSpawnToolSchema = Type.Object({
  task: Type.String(),
  label: Type.Optional(Type.String()),
  agentId: Type.Optional(Type.String()),
  model: Type.Optional(Type.String()),
  thinking: Type.Optional(Type.String()),
  runTimeoutSeconds: Type.Optional(Type.Number({ minimum: 0 })),
  // Back-compat alias. Prefer runTimeoutSeconds.
  timeoutSeconds: Type.Optional(Type.Number({ minimum: 0 })),
  cleanup: optionalStringEnum(["delete", "keep"] as const),
  /** Spawn mode: "default" for standard subagent, "claude-code" for CLI spawn. */
  mode: Type.Optional(Type.String()),
  /** Repository alias or absolute path (required for mode "claude-code"). */
  repo: Type.Optional(Type.String()),
  /** Permission mode for claude-code spawn. */
  permissionMode: Type.Optional(Type.String()),
  /** Start a fresh session instead of resuming (for claude-code mode). */
  freshSession: Type.Optional(Type.Boolean()),
  /** Keep the CC CLI process alive after the first result for follow-up messages (claude-code mode). */
  persistent: Type.Optional(Type.Boolean()),
});

function splitModelRef(ref?: string) {
  if (!ref) {
    return { provider: undefined, model: undefined };
  }
  const trimmed = ref.trim();
  if (!trimmed) {
    return { provider: undefined, model: undefined };
  }
  const [provider, model] = trimmed.split("/", 2);
  if (model) {
    return { provider, model };
  }
  return { provider: undefined, model: trimmed };
}

function normalizeModelSelection(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || undefined;
  }
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const primary = (value as { primary?: unknown }).primary;
  if (typeof primary === "string" && primary.trim()) {
    return primary.trim();
  }
  return undefined;
}

export function createSessionsSpawnTool(opts?: {
  agentSessionKey?: string;
  agentChannel?: GatewayMessageChannel;
  agentAccountId?: string;
  agentTo?: string;
  agentThreadId?: string | number;
  agentGroupId?: string | null;
  agentGroupChannel?: string | null;
  agentGroupSpace?: string | null;
  sandboxed?: boolean;
  /** Explicit agent ID override for cron/hook sessions where session key parsing may not work. */
  requesterAgentIdOverride?: string;
}): AnyAgentTool {
  return {
    label: "Sessions",
    name: "sessions_spawn",
    description:
      "Spawn a background sub-agent run in an isolated session and announce the result back to the requester chat.",
    parameters: SessionsSpawnToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const task = readStringParam(params, "task", { required: true });
      const label = typeof params.label === "string" ? params.label.trim() : "";
      const requestedAgentId = readStringParam(params, "agentId");
      const modelOverride = readStringParam(params, "model");
      const thinkingOverrideRaw = readStringParam(params, "thinking");
      const cleanup =
        params.cleanup === "keep" || params.cleanup === "delete" ? params.cleanup : "keep";
      const requesterOrigin = normalizeDeliveryContext({
        channel: opts?.agentChannel,
        accountId: opts?.agentAccountId,
        to: opts?.agentTo,
        threadId: opts?.agentThreadId,
      });
      const runTimeoutSeconds = (() => {
        const explicit =
          typeof params.runTimeoutSeconds === "number" && Number.isFinite(params.runTimeoutSeconds)
            ? Math.max(0, Math.floor(params.runTimeoutSeconds))
            : undefined;
        if (explicit !== undefined) {
          return explicit;
        }
        const legacy =
          typeof params.timeoutSeconds === "number" && Number.isFinite(params.timeoutSeconds)
            ? Math.max(0, Math.floor(params.timeoutSeconds))
            : undefined;
        return legacy ?? 0;
      })();
      let modelWarning: string | undefined;
      let modelApplied = false;

      const cfg = loadConfig();

      // ---------------------------------------------------------------
      // Claude Code spawn mode — bypasses the standard subagent flow.
      // ---------------------------------------------------------------
      const spawnMode = readStringParam(params, "mode");
      if (spawnMode === "claude-code") {
        const ccDefaults = cfg.agents?.defaults?.subagents?.claudeCode;
        if (!ccDefaults?.enabled) {
          return jsonResult({
            status: "error",
            error:
              "Claude Code spawn mode is not enabled. Set agents.defaults.subagents.claudeCode.enabled = true in openclaw.json",
          });
        }

        // Resolve per-agent Claude Code overrides and merge with defaults
        const requesterAgentIdRaw = normalizeAgentId(
          opts?.requesterAgentIdOverride ??
            parseAgentSessionKey(opts?.agentSessionKey ?? "")?.agentId,
        );
        const agentEntry = cfg.agents?.list?.find((a) => a.id === requesterAgentIdRaw);
        const ccAgent = agentEntry?.subagents?.claudeCode;
        // Merge: per-agent overrides win over defaults (shallow per-field)
        const ccConfig = {
          ...ccDefaults,
          ...Object.fromEntries(Object.entries(ccAgent ?? {}).filter(([, v]) => v !== undefined)),
          // Deep-merge repos: agent repos override/extend default repos
          repos: { ...ccDefaults.repos, ...ccAgent?.repos },
        };

        // Resolve repo path — aliases are checked in repos map first
        const repoParam = readStringParam(params, "repo") ?? ccConfig.defaultRepo ?? undefined;
        let repoPath: string | undefined;
        if (repoParam) {
          // Try alias first, then treat as absolute path
          repoPath = ccConfig.repos?.[repoParam] ?? repoParam;
        }
        if (!repoPath) {
          return jsonResult({
            status: "error",
            error:
              "No repo specified and no defaultRepo configured. Provide a repo alias or absolute path.",
          });
        }
        repoPath = path.resolve(repoPath);

        // Resolve permission mode
        const permissionModeParam = readStringParam(params, "permissionMode");
        const permissionMode: ClaudeCodePermissionMode =
          ccConfig.dangerouslySkipPermissions === true
            ? "bypassPermissions"
            : ((permissionModeParam as ClaudeCodePermissionMode) ??
              ccConfig.permissionMode ??
              "bypassPermissions");

        // Resolve other options
        const freshSession = params.freshSession === true;
        const persistentMode = params.persistent === true;
        const sessionLabel = label || undefined;
        const ccModel = modelOverride ?? ccConfig.model ?? undefined;
        const ccTimeout =
          runTimeoutSeconds > 0 ? runTimeoutSeconds : (ccConfig.timeoutSeconds ?? 600);
        const ccBudget = ccConfig.maxBudgetUsd;

        const requesterAgentId = requesterAgentIdRaw;

        // Intelligent session selection: score all candidate sessions using
        // branch match, recency, task relevance, health, and context capacity.
        // Falls back to legacy --continue strategy if selection fails.
        let sessionToResume: string | undefined;
        let shouldContinue = false;
        if (!freshSession) {
          try {
            const projectStatus = await gatherProjectStatus(repoPath, requesterAgentId);
            const selection = await selectSession(
              task,
              repoPath,
              requesterAgentId,
              projectStatus,
              sessionLabel,
              ccBudget,
              ccConfig.sessionSelection,
            );
            log.info(`Session selection: ${selection.action} — ${selection.reason}`);

            if (selection.action === "resume" && selection.sessionId) {
              sessionToResume = selection.sessionId;
            } else if (selection.action === "queue") {
              return jsonResult({
                status: "queued",
                reason: selection.reason,
              });
            }
            // action === "fresh" → sessionToResume stays undefined, shouldContinue stays false
          } catch (err) {
            // Fallback to legacy behavior if selection fails
            log.warn(
              `Session selection failed, using legacy strategy: ${err instanceof Error ? err.message : String(err)}`,
            );
            if (sessionLabel) {
              sessionToResume = resolveSession(requesterAgentId, repoPath, sessionLabel);
              if (!sessionToResume) {
                shouldContinue = true;
              }
            } else {
              shouldContinue = true;
            }
          }
        }

        // Fire-and-forget: spawn asynchronously and announce result back.
        const spawnId = crypto.randomUUID();
        const repoLabel = repoParam || path.basename(repoPath);
        const taskLabel = label || task;

        // --- Session tracking: create a virtual session so this spawn
        // appears in sessions_list and is tracked by the subagent registry.
        const childSessionKey = `agent:${requesterAgentId}:subagent:${spawnId}`;
        const { mainKey, alias } = resolveMainSessionAlias(cfg);
        const requesterSessionKey = opts?.agentSessionKey;
        const requesterInternalKey = requesterSessionKey
          ? resolveInternalSessionKey({ key: requesterSessionKey, alias, mainKey })
          : alias;
        const requesterDisplayKey = resolveDisplaySessionKey({
          key: requesterInternalKey,
          alias,
          mainKey,
        });

        // Create the session entry in the store via sessions.patch so it
        // shows up in sessions_list.  Best-effort — don't block spawn.
        void callGateway({
          method: "sessions.patch",
          params: {
            key: childSessionKey,
            label: (label || `cc: ${task.slice(0, 40)}`).slice(0, 60),
            spawnedBy: requesterInternalKey,
          },
          timeoutMs: 10_000,
        }).catch(() => {
          // Best-effort — session will still be tracked in-memory by the registry.
        });

        // Register in the subagent registry for lifecycle tracking.
        registerSubagentRun({
          runId: spawnId,
          childSessionKey,
          requesterSessionKey: requesterInternalKey,
          requesterOrigin,
          requesterDisplayKey,
          task,
          cleanup,
          label: label || undefined,
          // Persistent mode: use 0 to disable the wait timeout (relies on CC's
          // own 30-min idle timeout instead of the subagent registry timeout).
          runTimeoutSeconds: persistentMode ? 0 : ccTimeout,
        });

        // Emit lifecycle "start" so agent.wait listeners and the registry
        // know the run is active.
        const startedAt = Date.now();
        emitAgentEvent({
          runId: spawnId,
          stream: "lifecycle",
          sessionKey: childSessionKey,
          data: { phase: "start", startedAt },
        });

        void (async () => {
          try {
            const result = await spawnClaudeCode({
              task,
              repo: repoPath,
              model: ccModel ?? undefined,
              timeoutSeconds: ccTimeout,
              maxBudgetUsd: ccBudget,
              permissionMode,
              resume: sessionToResume,
              continueSession: shouldContinue,
              agentId: requesterAgentId,
              label: sessionLabel,
              binaryPath: ccConfig.binaryPath ?? undefined,
              mcpBridge: ccConfig.mcpBridge,
              progressRelay: ccConfig.progressRelay,
              persistent: persistentMode,
              onPermissionRequest: (request) => {
                log.info(`auto-approved permission: ${request.toolName} — ${request.description}`);
                respondToPermission(repoPath, request.requestId, true);
              },
              onProgress: (event) => {
                // Relay progress summaries to the user's chat channel.
                if (event.kind === "progress_summary") {
                  const reqSessionKey = opts?.agentSessionKey ?? "main";
                  const progressOrigin = normalizeDeliveryContext({
                    channel: opts?.agentChannel,
                    accountId: opts?.agentAccountId,
                    to: opts?.agentTo,
                    threadId: opts?.agentThreadId,
                  });
                  void callGateway({
                    method: "agent",
                    params: {
                      sessionKey: reqSessionKey,
                      message: `${event.summary}\n\nRelay this progress update to the user verbatim. Keep it brief.`,
                      deliver: true,
                      channel: progressOrigin?.channel,
                      accountId: progressOrigin?.accountId,
                      to: progressOrigin?.to,
                      threadId:
                        progressOrigin?.threadId != null
                          ? String(progressOrigin.threadId)
                          : undefined,
                      idempotencyKey: crypto.randomUUID(),
                    },
                    expectFinal: true,
                    timeoutMs: 30_000,
                  }).catch(() => {
                    // Best-effort — ignore relay failures.
                  });
                }
              },
            });

            // Mark the registry entry as announced BEFORE emitting the
            // lifecycle end event, so the registry's listener doesn't
            // trigger a duplicate announce (it would read an empty transcript
            // since Claude Code runs as a subprocess, not a gateway session).
            const endedAt = Date.now();
            const outcome = result.success
              ? { status: "ok" as const }
              : result.errors.some((e) => e.includes("Timed out"))
                ? { status: "timeout" as const }
                : { status: "error" as const, error: result.errors.join(", ") || undefined };
            markSubagentAnnounced(spawnId, outcome, { endedAt, cleanup });

            // Announce result back to requester via gateway.
            const statusText = result.success ? "completed successfully" : "finished with errors";
            const costText = result.totalCostUsd > 0 ? ` ($${result.totalCostUsd.toFixed(2)})` : "";
            const turnsText = result.numTurns > 0 ? `, ${result.numTurns} turns` : "";
            const durationSec = Math.round(result.durationMs / 1000);
            const errorText =
              result.errors.length > 0 ? `\nErrors: ${result.errors.join(", ")}` : "";
            const denialText =
              result.permissionDenials.length > 0
                ? `\nPermission denials: ${result.permissionDenials.join(", ")}`
                : "";

            const announceMessage = [
              `A Claude Code task on [${repoLabel}] "${taskLabel}" just ${statusText}.`,
              "",
              "Result:",
              result.result || "(no output)",
              "",
              `Stats: ${durationSec}s${costText}${turnsText}`,
              `Session: ${result.sessionId} (resumable)`,
              errorText,
              denialText,
              "",
              "Summarize this naturally for the user. Keep it brief.",
            ].join("\n");

            const reqSessionKey = opts?.agentSessionKey ?? "main";
            await callGateway({
              method: "agent",
              params: {
                sessionKey: reqSessionKey,
                message: announceMessage,
                deliver: true,
                channel: requesterOrigin?.channel,
                accountId: requesterOrigin?.accountId,
                to: requesterOrigin?.to,
                threadId:
                  requesterOrigin?.threadId != null ? String(requesterOrigin.threadId) : undefined,
                idempotencyKey: crypto.randomUUID(),
              },
              expectFinal: true,
              timeoutMs: 60_000,
            });

            // Emit lifecycle "end" so agent.wait resolves for any external
            // listeners that didn't go through the registry.
            emitAgentEvent({
              runId: spawnId,
              stream: "lifecycle",
              sessionKey: childSessionKey,
              data: { phase: "end", startedAt, endedAt },
            });

            // Clean up the virtual session if configured.
            if (cleanup === "delete") {
              void callGateway({
                method: "sessions.delete",
                params: { key: childSessionKey, deleteTranscript: true },
                timeoutMs: 10_000,
              }).catch(() => {});
            }
          } catch (err) {
            const endedAt = Date.now();
            const errorMsg =
              err instanceof Error ? err.message : typeof err === "string" ? err : "unknown error";

            // Mark announced before emitting lifecycle error.
            markSubagentAnnounced(
              spawnId,
              { status: "error", error: errorMsg },
              { endedAt, cleanup },
            );

            // Announce failure back to requester.
            try {
              const reqSessionKey = opts?.agentSessionKey ?? "main";
              await callGateway({
                method: "agent",
                params: {
                  sessionKey: reqSessionKey,
                  message: `Claude Code task on [${repoLabel}] failed: ${errorMsg}\n\nInform the user about this failure.`,
                  deliver: true,
                  channel: requesterOrigin?.channel,
                  accountId: requesterOrigin?.accountId,
                  to: requesterOrigin?.to,
                  threadId:
                    requesterOrigin?.threadId != null
                      ? String(requesterOrigin.threadId)
                      : undefined,
                  idempotencyKey: crypto.randomUUID(),
                },
                expectFinal: true,
                timeoutMs: 60_000,
              });
            } catch {
              // Best-effort — ignore announce failure.
            }

            // Emit lifecycle "error" so agent.wait resolves.
            emitAgentEvent({
              runId: spawnId,
              stream: "lifecycle",
              sessionKey: childSessionKey,
              data: { phase: "error", startedAt, endedAt, error: errorMsg },
            });

            // Clean up the virtual session on error too.
            if (cleanup === "delete") {
              void callGateway({
                method: "sessions.delete",
                params: { key: childSessionKey, deleteTranscript: true },
                timeoutMs: 10_000,
              }).catch(() => {});
            }
          }
        })();

        return jsonResult({
          status: "accepted",
          mode: "claude-code",
          childSessionKey,
          runId: spawnId,
          repo: repoPath,
          model: ccModel,
          permissionMode,
          timeoutSeconds: ccTimeout,
          persistent: persistentMode || undefined,
        });
      }

      const { mainKey, alias } = resolveMainSessionAlias(cfg);
      const requesterSessionKey = opts?.agentSessionKey;
      if (typeof requesterSessionKey === "string" && isSubagentSessionKey(requesterSessionKey)) {
        return jsonResult({
          status: "forbidden",
          error: "sessions_spawn is not allowed from sub-agent sessions",
        });
      }
      const requesterInternalKey = requesterSessionKey
        ? resolveInternalSessionKey({
            key: requesterSessionKey,
            alias,
            mainKey,
          })
        : alias;
      const requesterDisplayKey = resolveDisplaySessionKey({
        key: requesterInternalKey,
        alias,
        mainKey,
      });

      const requesterAgentId = normalizeAgentId(
        opts?.requesterAgentIdOverride ?? parseAgentSessionKey(requesterInternalKey)?.agentId,
      );
      const targetAgentId = requestedAgentId
        ? normalizeAgentId(requestedAgentId)
        : requesterAgentId;
      if (targetAgentId !== requesterAgentId) {
        const allowAgents = resolveAgentConfig(cfg, requesterAgentId)?.subagents?.allowAgents ?? [];
        const allowAny = allowAgents.some((value) => value.trim() === "*");
        const normalizedTargetId = targetAgentId.toLowerCase();
        const allowSet = new Set(
          allowAgents
            .filter((value) => value.trim() && value.trim() !== "*")
            .map((value) => normalizeAgentId(value).toLowerCase()),
        );
        if (!allowAny && !allowSet.has(normalizedTargetId)) {
          const allowedText = allowAny
            ? "*"
            : allowSet.size > 0
              ? Array.from(allowSet).join(", ")
              : "none";
          return jsonResult({
            status: "forbidden",
            error: `agentId is not allowed for sessions_spawn (allowed: ${allowedText})`,
          });
        }
      }
      const childSessionKey = `agent:${targetAgentId}:subagent:${crypto.randomUUID()}`;
      const spawnedByKey = requesterInternalKey;
      const targetAgentConfig = resolveAgentConfig(cfg, targetAgentId);
      const resolvedModel =
        normalizeModelSelection(modelOverride) ??
        normalizeModelSelection(targetAgentConfig?.subagents?.model) ??
        normalizeModelSelection(cfg.agents?.defaults?.subagents?.model);

      const resolvedThinkingDefaultRaw =
        readStringParam(targetAgentConfig?.subagents ?? {}, "thinking") ??
        readStringParam(cfg.agents?.defaults?.subagents ?? {}, "thinking");

      let thinkingOverride: string | undefined;
      const thinkingCandidateRaw = thinkingOverrideRaw || resolvedThinkingDefaultRaw;
      if (thinkingCandidateRaw) {
        const normalized = normalizeThinkLevel(thinkingCandidateRaw);
        if (!normalized) {
          const { provider, model } = splitModelRef(resolvedModel);
          const hint = formatThinkingLevels(provider, model);
          return jsonResult({
            status: "error",
            error: `Invalid thinking level "${thinkingCandidateRaw}". Use one of: ${hint}.`,
          });
        }
        thinkingOverride = normalized;
      }
      if (resolvedModel) {
        try {
          await callGateway({
            method: "sessions.patch",
            params: { key: childSessionKey, model: resolvedModel },
            timeoutMs: 10_000,
          });
          modelApplied = true;
        } catch (err) {
          const messageText =
            err instanceof Error ? err.message : typeof err === "string" ? err : "error";
          const recoverable =
            messageText.includes("invalid model") || messageText.includes("model not allowed");
          if (!recoverable) {
            return jsonResult({
              status: "error",
              error: messageText,
              childSessionKey,
            });
          }
          modelWarning = messageText;
        }
      }
      if (thinkingOverride !== undefined) {
        try {
          await callGateway({
            method: "sessions.patch",
            params: {
              key: childSessionKey,
              thinkingLevel: thinkingOverride === "off" ? null : thinkingOverride,
            },
            timeoutMs: 10_000,
          });
        } catch (err) {
          const messageText =
            err instanceof Error ? err.message : typeof err === "string" ? err : "error";
          return jsonResult({
            status: "error",
            error: messageText,
            childSessionKey,
          });
        }
      }
      const childSystemPrompt = buildSubagentSystemPrompt({
        requesterSessionKey,
        requesterOrigin,
        childSessionKey,
        label: label || undefined,
        task,
      });

      const childIdem = crypto.randomUUID();
      let childRunId: string = childIdem;
      try {
        const response = await callGateway<{ runId: string }>({
          method: "agent",
          params: {
            message: task,
            sessionKey: childSessionKey,
            channel: requesterOrigin?.channel,
            to: requesterOrigin?.to ?? undefined,
            accountId: requesterOrigin?.accountId ?? undefined,
            threadId:
              requesterOrigin?.threadId != null ? String(requesterOrigin.threadId) : undefined,
            idempotencyKey: childIdem,
            deliver: false,
            lane: AGENT_LANE_SUBAGENT,
            extraSystemPrompt: childSystemPrompt,
            thinking: thinkingOverride,
            timeout: runTimeoutSeconds > 0 ? runTimeoutSeconds : undefined,
            label: label || undefined,
            spawnedBy: spawnedByKey,
            groupId: opts?.agentGroupId ?? undefined,
            groupChannel: opts?.agentGroupChannel ?? undefined,
            groupSpace: opts?.agentGroupSpace ?? undefined,
          },
          timeoutMs: 10_000,
        });
        if (typeof response?.runId === "string" && response.runId) {
          childRunId = response.runId;
        }
      } catch (err) {
        const messageText =
          err instanceof Error ? err.message : typeof err === "string" ? err : "error";
        return jsonResult({
          status: "error",
          error: messageText,
          childSessionKey,
          runId: childRunId,
        });
      }

      registerSubagentRun({
        runId: childRunId,
        childSessionKey,
        requesterSessionKey: requesterInternalKey,
        requesterOrigin,
        requesterDisplayKey,
        task,
        cleanup,
        label: label || undefined,
        runTimeoutSeconds,
      });

      return jsonResult({
        status: "accepted",
        childSessionKey,
        runId: childRunId,
        modelApplied: resolvedModel ? modelApplied : undefined,
        warning: modelWarning,
      });
    },
  };
}
