import { Type } from "@sinclair/typebox";
import { loadConfig } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { GatewayMessageChannel } from "../../utils/message-channel.js";
import { ACP_SPAWN_MODES, spawnAcpDirect } from "../acp-spawn.js";
import { optionalStringEnum } from "../schema/typebox.js";
import {
  buildSessionsSpawnFailureBudgetError,
  buildSessionsSpawnFailureBudgetKey,
  logSessionsSpawnFailureBudgetHit,
  peekSessionsSpawnFailureBudget,
  recordSessionsSpawnFailureBudget,
} from "../sessions-spawn-failure-guard.js";
import type { SpawnedToolContext } from "../spawned-context.js";
import { spawnSubagentDirect } from "../subagent-spawn.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam, ToolInputError } from "./common.js";
import { resolveInternalSessionKey, resolveMainSessionAlias } from "./sessions-helpers.js";

const SESSIONS_SPAWN_RUNTIMES = ["subagent", "acp"] as const;
const SESSIONS_SPAWN_SANDBOX_MODES = ["inherit", "require"] as const;
const SESSIONS_SPAWN_STREAM_TARGETS = ["parent"] as const;
const UNSUPPORTED_SESSIONS_SPAWN_PARAM_KEYS = [
  "target",
  "transport",
  "channel",
  "to",
  "threadId",
  "thread_id",
  "replyTo",
  "reply_to",
] as const;

const SessionsSpawnToolSchema = Type.Object({
  task: Type.Optional(Type.String()),
  label: Type.Optional(Type.String()),
  runtime: optionalStringEnum(SESSIONS_SPAWN_RUNTIMES),
  agentId: Type.Optional(Type.String()),
  teamId: Type.Optional(Type.String()),
  capability: Type.Optional(Type.String()),
  role: Type.Optional(Type.String()),
  resumeSessionId: Type.Optional(
    Type.String({
      description:
        'Resume an existing agent session by its ID (e.g. a Codex session UUID from ~/.codex/sessions/). Requires runtime="acp". The agent replays conversation history via session/load instead of starting fresh.',
    }),
  ),
  model: Type.Optional(Type.String()),
  thinking: Type.Optional(Type.String()),
  cwd: Type.Optional(Type.String()),
  runTimeoutSeconds: Type.Optional(Type.Number({ minimum: 0 })),
  // Back-compat: older callers used timeoutSeconds for this tool.
  timeoutSeconds: Type.Optional(Type.Number({ minimum: 0 })),
  thread: Type.Optional(Type.Boolean()),
  mode: Type.Optional(Type.String()),
  cleanup: optionalStringEnum(["delete", "keep"] as const),
  sandbox: optionalStringEnum(SESSIONS_SPAWN_SANDBOX_MODES),
  streamTo: optionalStringEnum(SESSIONS_SPAWN_STREAM_TARGETS),

  // Inline attachments (snapshot-by-value).
  // NOTE: Attachment contents are redacted from transcript persistence by sanitizeToolCallInputs.
  attachments: Type.Optional(
    Type.Array(
      Type.Object({
        name: Type.String(),
        content: Type.String(),
        encoding: Type.Optional(optionalStringEnum(["utf8", "base64"] as const)),
        mimeType: Type.Optional(Type.String()),
      }),
      { maxItems: 50 },
    ),
  ),
  attachAs: Type.Optional(
    Type.Object({
      // Where the spawned agent should look for attachments.
      // Kept as a hint; implementation materializes into the child workspace.
      mountPath: Type.Optional(Type.String()),
    }),
  ),
});

export function createSessionsSpawnTool(
  opts?: {
    cfgOverride?: OpenClawConfig;
    agentSessionKey?: string;
    agentChannel?: GatewayMessageChannel;
    agentAccountId?: string;
    agentTo?: string;
    agentThreadId?: string | number;
    sandboxed?: boolean;
    /** Explicit agent ID override for cron/hook sessions where session key parsing may not work. */
    requesterAgentIdOverride?: string;
  } & SpawnedToolContext,
): AnyAgentTool {
  return {
    label: "Sessions",
    name: "sessions_spawn",
    description:
      'Spawn an isolated session (runtime="subagent" or runtime="acp"). mode="run" is one-shot and mode="session" is persistent/thread-bound. Subagents inherit the parent workspace directory automatically.',
    parameters: SessionsSpawnToolSchema,
    execute: async (_toolCallId, args) => {
      const cfg = opts?.cfgOverride ?? loadConfig();
      const { mainKey, alias } = resolveMainSessionAlias(cfg);
      const requesterInternalKey = opts?.agentSessionKey
        ? resolveInternalSessionKey({
            key: opts.agentSessionKey,
            alias,
            mainKey,
          })
        : alias;
      const failureBudgetKey = buildSessionsSpawnFailureBudgetKey({ requesterInternalKey });
      const budgetHit = peekSessionsSpawnFailureBudget({ budgetKey: failureBudgetKey });
      if (budgetHit) {
        logSessionsSpawnFailureBudgetHit({
          requesterInternalKey,
          retryAfterMs: budgetHit.retryAfterMs,
          blockStrikeCount: budgetHit.blockStrikeCount,
          recentFailureCount: budgetHit.recentFailureCount,
        });
        return jsonResult({
          status: "forbidden",
          error: buildSessionsSpawnFailureBudgetError({
            retryAfterMs: budgetHit.retryAfterMs,
          }),
        });
      }

      try {
        const params = args as Record<string, unknown>;
        const unsupportedParam = UNSUPPORTED_SESSIONS_SPAWN_PARAM_KEYS.find((key) =>
          Object.hasOwn(params, key),
        );
        if (unsupportedParam) {
          throw new ToolInputError(
            `sessions_spawn does not support "${unsupportedParam}". Use "message" or "sessions_send" for channel delivery.`,
          );
        }

        const task = readStringParam(params, "task", { required: true });
        const label = typeof params.label === "string" ? params.label.trim() : "";
        const runtime = params.runtime === "acp" ? "acp" : "subagent";
        const requestedAgentId = readStringParam(params, "agentId");
        const requestedTeamId = readStringParam(params, "teamId");
        const requestedCapability = readStringParam(params, "capability");
        const requestedRole = readStringParam(params, "role");
        const resumeSessionId = readStringParam(params, "resumeSessionId");
        const modelOverride = readStringParam(params, "model");
        const thinkingOverrideRaw = readStringParam(params, "thinking");
        const cwd = readStringParam(params, "cwd");
        const modeRaw = readStringParam(params, "mode");
        if (modeRaw && modeRaw !== "run" && modeRaw !== "session") {
          throw new ToolInputError(`mode must be "run" or "session"; got "${modeRaw}"`);
        }
        const mode = modeRaw === "run" || modeRaw === "session" ? modeRaw : undefined;
        const cleanup =
          params.cleanup === "keep" || params.cleanup === "delete" ? params.cleanup : "keep";
        const sandbox = params.sandbox === "require" ? "require" : "inherit";
        const streamTo = params.streamTo === "parent" ? "parent" : undefined;
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
        const thread = params.thread === true;
        const attachments = Array.isArray(params.attachments)
          ? (params.attachments as Array<{
              name: string;
              content: string;
              encoding?: "utf8" | "base64";
              mimeType?: string;
            }>)
          : undefined;

        if (requestedAgentId && (requestedTeamId || requestedCapability || requestedRole)) {
          return jsonResult({
            status: "error",
            error: "agentId cannot be combined with teamId, capability, or role",
          });
        }

        if ((requestedCapability || requestedRole) && !requestedTeamId) {
          return jsonResult({
            status: "error",
            error: "capability/role requires teamId",
          });
        }

        if (
          requestedCapability &&
          requestedRole &&
          requestedCapability.toLowerCase() !== requestedRole.toLowerCase()
        ) {
          return jsonResult({
            status: "error",
            error: "capability and role must match when both are provided",
          });
        }

        if (streamTo && runtime !== "acp") {
          return jsonResult({
            status: "error",
            error: `streamTo is only supported for runtime=acp; got runtime=${runtime}`,
          });
        }

        if (resumeSessionId && runtime !== "acp") {
          return jsonResult({
            status: "error",
            error: `resumeSessionId is only supported for runtime=acp; got runtime=${runtime}`,
          });
        }

        if (runtime === "acp") {
          if (Array.isArray(attachments) && attachments.length > 0) {
            return jsonResult({
              status: "error",
              error:
                "attachments are currently unsupported for runtime=acp; use runtime=subagent or remove attachments",
            });
          }
          const result = await spawnAcpDirect(
            {
              task,
              label: label || undefined,
              agentId: requestedAgentId,
              teamId: requestedTeamId,
              capability: requestedCapability,
              role: requestedRole,
              resumeSessionId,
              cwd,
              mode: mode && ACP_SPAWN_MODES.includes(mode) ? mode : undefined,
              thread,
              sandbox,
              streamTo,
            },
            {
              cfg,
              agentSessionKey: opts?.agentSessionKey,
              agentChannel: opts?.agentChannel,
              agentAccountId: opts?.agentAccountId,
              agentTo: opts?.agentTo,
              agentThreadId: opts?.agentThreadId,
              sandboxed: opts?.sandboxed,
            },
          );
          return jsonResult(result);
        }

        const result = await spawnSubagentDirect(
          {
            task,
            label: label || undefined,
            agentId: requestedAgentId,
            teamId: requestedTeamId,
            capability: requestedCapability,
            role: requestedRole,
            model: modelOverride,
            thinking: thinkingOverrideRaw,
            runTimeoutSeconds,
            thread,
            mode,
            cleanup,
            sandbox,
            expectsCompletionMessage: true,
            attachments,
            attachMountPath:
              params.attachAs && typeof params.attachAs === "object"
                ? readStringParam(params.attachAs as Record<string, unknown>, "mountPath")
                : undefined,
          },
          {
            cfg,
            agentSessionKey: opts?.agentSessionKey,
            agentChannel: opts?.agentChannel,
            agentAccountId: opts?.agentAccountId,
            agentTo: opts?.agentTo,
            agentThreadId: opts?.agentThreadId,
            agentGroupId: opts?.agentGroupId,
            agentGroupChannel: opts?.agentGroupChannel,
            agentGroupSpace: opts?.agentGroupSpace,
            requesterAgentIdOverride: opts?.requesterAgentIdOverride,
            workspaceDir: opts?.workspaceDir,
          },
        );

        return jsonResult(result);
      } catch (error) {
        if (error instanceof ToolInputError) {
          const budgetState = recordSessionsSpawnFailureBudget({ budgetKey: failureBudgetKey });
          if (budgetState.retryAfterMs && budgetState.retryAfterMs > 0) {
            return jsonResult({
              status: "forbidden",
              error: buildSessionsSpawnFailureBudgetError({
                retryAfterMs: budgetState.retryAfterMs,
              }),
            });
          }
          return jsonResult({
            status: "error",
            error: error.message,
          });
        }
        throw error;
      }
    },
  };
}
