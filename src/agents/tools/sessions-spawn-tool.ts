import crypto from "node:crypto";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import { loadConfig } from "../../config/config.js";
import { callGateway } from "../../gateway/call.js";
import { normalizeAgentId, parseAgentSessionKey } from "../../routing/session-key.js";
import { normalizeDeliveryContext } from "../../utils/delivery-context.js";
import type { GatewayMessageChannel } from "../../utils/message-channel.js";
import { spawnClaudeCode } from "../claude-code/runner.js";
import type { ClaudeCodePermissionMode } from "../claude-code/types.js";
import { optionalStringEnum } from "../schema/typebox.js";
import { spawnSubagentDirect } from "../subagent-spawn.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";

const SessionsSpawnToolSchema = Type.Object({
  task: Type.String(),
  label: Type.Optional(Type.String()),
  agentId: Type.Optional(Type.String()),
  model: Type.Optional(Type.String()),
  thinking: Type.Optional(Type.String()),
  runTimeoutSeconds: Type.Optional(Type.Number({ minimum: 0 })),
  // Back-compat: older callers used timeoutSeconds for this tool.
  timeoutSeconds: Type.Optional(Type.Number({ minimum: 0 })),
  cleanup: optionalStringEnum(["delete", "keep"] as const),
  // Claude Code spawn mode params
  mode: Type.Optional(Type.String()),
  repo: Type.Optional(Type.String()),
  permissionMode: Type.Optional(Type.String()),
  freshSession: Type.Optional(Type.Boolean()),
});

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
      // Back-compat: older callers used timeoutSeconds for this tool.
      const timeoutSecondsCandidate =
        typeof params.runTimeoutSeconds === "number"
          ? params.runTimeoutSeconds
          : typeof params.timeoutSeconds === "number"
            ? params.timeoutSeconds
            : undefined;
      const runTimeoutSeconds =
        typeof timeoutSecondsCandidate === "number" && Number.isFinite(timeoutSecondsCandidate)
          ? Math.max(0, Math.floor(timeoutSecondsCandidate))
          : undefined;

      const cfg = loadConfig();

      // ---------------------------------------------------------------
      // Claude Code spawn mode — bypasses the standard subagent flow.
      // ---------------------------------------------------------------
      const spawnMode = readStringParam(params, "mode");
      if (spawnMode === "claude-code") {
        const ccConfig = cfg.agents?.defaults?.subagents?.claudeCode;
        if (!ccConfig?.enabled) {
          return jsonResult({
            status: "error",
            error:
              "Claude Code spawn mode is not enabled. Set agents.defaults.subagents.claudeCode.enabled = true in openclaw.json",
          });
        }

        const repoParam = readStringParam(params, "repo");
        let repoPath: string | undefined;
        if (repoParam) {
          repoPath = ccConfig.repos?.[repoParam] ?? repoParam;
        } else {
          repoPath = ccConfig.defaultRepo ?? undefined;
        }
        if (!repoPath) {
          return jsonResult({
            status: "error",
            error:
              "No repo specified and no defaultRepo configured. Provide a repo alias or absolute path.",
          });
        }
        repoPath = path.resolve(repoPath);

        const permissionModeParam = readStringParam(params, "permissionMode");
        const permissionMode: ClaudeCodePermissionMode =
          (permissionModeParam as ClaudeCodePermissionMode) ??
          ccConfig.permissionMode ??
          "bypassPermissions";

        const ccModel = modelOverride ?? ccConfig.model ?? undefined;
        const ccTimeout =
          (runTimeoutSeconds ?? 0) > 0 ? runTimeoutSeconds! : (ccConfig.timeoutSeconds ?? 600);
        const ccBudget = ccConfig.maxBudgetUsd;

        const requesterAgentId = normalizeAgentId(
          opts?.requesterAgentIdOverride ??
            parseAgentSessionKey(opts?.agentSessionKey ?? "")?.agentId,
        );

        const spawnId = crypto.randomUUID();
        const repoLabel = repoParam || path.basename(repoPath);
        const taskLabel = label || task;

        void (async () => {
          try {
            const result = await spawnClaudeCode({
              task,
              repo: repoPath,
              model: ccModel ?? undefined,
              timeoutSeconds: ccTimeout,
              maxBudgetUsd: ccBudget,
              permissionMode,
              agentId: requesterAgentId,
              binaryPath: ccConfig.binaryPath ?? undefined,
              mcpBridge: ccConfig.mcpBridge,
              progressRelay: ccConfig.progressRelay,
              onProgress: (event) => {
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
                  }).catch(() => {});
                }
              },
            });

            const requesterOriginForAnnounce = normalizeDeliveryContext({
              channel: opts?.agentChannel,
              accountId: opts?.agentAccountId,
              to: opts?.agentTo,
              threadId: opts?.agentThreadId,
            });

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
                channel: requesterOriginForAnnounce?.channel,
                accountId: requesterOriginForAnnounce?.accountId,
                to: requesterOriginForAnnounce?.to,
                threadId:
                  requesterOriginForAnnounce?.threadId != null
                    ? String(requesterOriginForAnnounce.threadId)
                    : undefined,
                idempotencyKey: crypto.randomUUID(),
              },
              expectFinal: true,
              timeoutMs: 60_000,
            });
          } catch (err) {
            const errorMsg =
              err instanceof Error ? err.message : typeof err === "string" ? err : "unknown error";
            try {
              const reqSessionKey = opts?.agentSessionKey ?? "main";
              const requesterOriginForAnnounce = normalizeDeliveryContext({
                channel: opts?.agentChannel,
                accountId: opts?.agentAccountId,
                to: opts?.agentTo,
                threadId: opts?.agentThreadId,
              });
              await callGateway({
                method: "agent",
                params: {
                  sessionKey: reqSessionKey,
                  message: `Claude Code task on [${repoLabel}] failed: ${errorMsg}\n\nInform the user about this failure.`,
                  deliver: true,
                  channel: requesterOriginForAnnounce?.channel,
                  accountId: requesterOriginForAnnounce?.accountId,
                  to: requesterOriginForAnnounce?.to,
                  threadId:
                    requesterOriginForAnnounce?.threadId != null
                      ? String(requesterOriginForAnnounce.threadId)
                      : undefined,
                  idempotencyKey: crypto.randomUUID(),
                },
                expectFinal: true,
                timeoutMs: 60_000,
              });
            } catch {
              // Best-effort
            }
          }
        })();

        return jsonResult({
          status: "accepted",
          mode: "claude-code",
          repo: repoPath,
          spawnId,
          model: ccModel,
          permissionMode,
          timeoutSeconds: ccTimeout,
        });
      }

      // Standard subagent spawn path
      const result = await spawnSubagentDirect(
        {
          task,
          label: label || undefined,
          agentId: requestedAgentId,
          model: modelOverride,
          thinking: thinkingOverrideRaw,
          runTimeoutSeconds,
          cleanup,
          expectsCompletionMessage: true,
        },
        {
          agentSessionKey: opts?.agentSessionKey,
          agentChannel: opts?.agentChannel,
          agentAccountId: opts?.agentAccountId,
          agentTo: opts?.agentTo,
          agentThreadId: opts?.agentThreadId,
          agentGroupId: opts?.agentGroupId,
          agentGroupChannel: opts?.agentGroupChannel,
          agentGroupSpace: opts?.agentGroupSpace,
          requesterAgentIdOverride: opts?.requesterAgentIdOverride,
        },
      );

      return jsonResult(result);
    },
  };
}
