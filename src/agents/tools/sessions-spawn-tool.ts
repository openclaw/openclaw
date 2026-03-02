import { Type } from "@sinclair/typebox";
import type { GatewayMessageChannel } from "../../utils/message-channel.js";
import { ACP_SPAWN_MODES, spawnAcpDirect } from "../acp-spawn.js";
import { optionalStringEnum } from "../schema/typebox.js";
import { SUBAGENT_SPAWN_MODES, spawnSubagentDirect } from "../subagent-spawn.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam, ToolInputError } from "./common.js";

const SESSIONS_SPAWN_RUNTIMES = ["subagent", "acp"] as const;
const SESSIONS_SPAWN_SANDBOX_MODES = ["inherit", "require"] as const;
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
  task: Type.String(),
  label: Type.Optional(Type.String()),
  runtime: optionalStringEnum(SESSIONS_SPAWN_RUNTIMES),
  agentId: Type.Optional(Type.String()),
  model: Type.Optional(Type.String()),
  thinking: Type.Optional(Type.String()),
  cwd: Type.Optional(Type.String()),
  runTimeoutSeconds: Type.Optional(Type.Number({ minimum: 0 })),
  // Back-compat: older callers used timeoutSeconds for this tool.
  timeoutSeconds: Type.Optional(Type.Number({ minimum: 0 })),
  thread: Type.Optional(Type.Boolean()),
  mode: optionalStringEnum(SUBAGENT_SPAWN_MODES),
  cleanup: optionalStringEnum(["delete", "keep"] as const),
  sandbox: optionalStringEnum(SESSIONS_SPAWN_SANDBOX_MODES),

  // Inline attachments (snapshot-by-value).
  // NOTE: Attachment contents are redacted from transcript persistence by sanitizeToolCallInputs.
  attachments: Type.Optional(
    Type.Array(
      Type.Object({
        name: Type.String(),
        content: Type.String({ maxLength: 6_700_000 }),
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
      'Spawn an isolated session (runtime="subagent" or runtime="acp"). mode="run" is one-shot and mode="session" is persistent/thread-bound.',
    parameters: SessionsSpawnToolSchema,
    execute: async (_toolCallId, args) => {
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
      const modelOverride = readStringParam(params, "model");
      const thinkingOverrideRaw = readStringParam(params, "thinking");
      const cwd = readStringParam(params, "cwd");
      const mode = params.mode === "run" || params.mode === "session" ? params.mode : undefined;
      const cleanup =
        params.cleanup === "keep" || params.cleanup === "delete" ? params.cleanup : "keep";
      const sandbox = params.sandbox === "require" ? "require" : "inherit";
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
            cwd,
            mode: mode && ACP_SPAWN_MODES.includes(mode) ? mode : undefined,
            thread,
          },
          {
            agentSessionKey: opts?.agentSessionKey,
            agentChannel: opts?.agentChannel,
            agentAccountId: opts?.agentAccountId,
            agentTo: opts?.agentTo,
            agentThreadId: opts?.agentThreadId,
          },
        );
        return jsonResult(result);
      }

      const result = await spawnSubagentDirect(
        {
          task,
          label: label || undefined,
          agentId: requestedAgentId,
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
