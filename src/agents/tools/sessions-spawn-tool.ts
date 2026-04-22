import { Type } from "@sinclair/typebox";
import { loadConfig } from "../../config/config.js";
import { callGateway } from "../../gateway/call.js";
import { getAgentRunContext, trackOpenSubagentForParent } from "../../infra/agent-events.js";
import { normalizeDeliveryContext } from "../../utils/delivery-context.shared.js";
import type { GatewayMessageChannel } from "../../utils/message-channel.js";
import { MAX_CONCURRENT_SUBAGENTS_IN_PLAN_MODE } from "../plan-mode/index.js";
import { optionalStringEnum } from "../schema/typebox.js";
import type { SpawnedToolContext } from "../spawned-context.js";
import { registerSubagentRun } from "../subagent-registry.js";
import { SUBAGENT_SPAWN_MODES, spawnSubagentDirect } from "../subagent-spawn.js";
import {
  describeSessionsSpawnTool,
  SESSIONS_SPAWN_TOOL_DISPLAY_SUMMARY,
} from "../tool-description-presets.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam, ToolInputError } from "./common.js";
import {
  resolveDisplaySessionKey,
  resolveInternalSessionKey,
  resolveMainSessionAlias,
} from "./sessions-helpers.js";

const SESSIONS_SPAWN_RUNTIMES = ["subagent", "acp"] as const;
const SESSIONS_SPAWN_SANDBOX_MODES = ["inherit", "require"] as const;
// Keep the schema local to avoid a circular import through acp-spawn/openclaw-tools.
const SESSIONS_SPAWN_ACP_STREAM_TARGETS = ["parent"] as const;
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

type AcpSpawnModule = typeof import("../acp-spawn.js");

let acpSpawnModulePromise: Promise<AcpSpawnModule> | undefined;

async function loadAcpSpawnModule(): Promise<AcpSpawnModule> {
  acpSpawnModulePromise ??= import("../acp-spawn.js");
  return await acpSpawnModulePromise;
}

function summarizeError(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === "string") {
    return err;
  }
  return "error";
}

function addRoleToFailureResult<T extends { status: string }>(
  result: T,
  role: string | undefined,
): T | (T & { role: string }) {
  if (!role || (result.status !== "error" && result.status !== "forbidden")) {
    return result;
  }
  return { ...result, role };
}

function resolveTrackedSpawnMode(params: {
  requestedMode?: "run" | "session";
  threadRequested: boolean;
}): "run" | "session" {
  if (params.requestedMode === "run" || params.requestedMode === "session") {
    return params.requestedMode;
  }
  return params.threadRequested ? "session" : "run";
}

async function cleanupUntrackedAcpSession(sessionKey: string): Promise<void> {
  const key = sessionKey.trim();
  if (!key) {
    return;
  }
  try {
    await callGateway({
      method: "sessions.delete",
      params: {
        key,
        deleteTranscript: true,
        emitLifecycleHooks: false,
      },
      timeoutMs: 10_000,
    });
  } catch {
    // Best-effort cleanup only.
  }
}

const SessionsSpawnToolSchema = Type.Object({
  task: Type.String(),
  label: Type.Optional(Type.String()),
  runtime: optionalStringEnum(SESSIONS_SPAWN_RUNTIMES),
  agentId: Type.Optional(Type.String()),
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
  mode: optionalStringEnum(SUBAGENT_SPAWN_MODES),
  cleanup: optionalStringEnum(["delete", "keep"] as const),
  sandbox: optionalStringEnum(SESSIONS_SPAWN_SANDBOX_MODES),
  streamTo: optionalStringEnum(SESSIONS_SPAWN_ACP_STREAM_TARGETS),
  lightContext: Type.Optional(
    Type.Boolean({
      description:
        "When true, spawned subagent runs use lightweight bootstrap context. Only applies to runtime='subagent'.",
    }),
  ),

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
    agentSessionKey?: string;
    agentChannel?: GatewayMessageChannel;
    agentAccountId?: string;
    agentTo?: string;
    agentThreadId?: string | number;
    sandboxed?: boolean;
    /** Explicit agent ID override for cron/hook sessions where session key parsing may not work. */
    requesterAgentIdOverride?: string;
    /**
     * PR-8 follow-up: stable run id of the PARENT run spawning this child.
     * Used to:
     *  - add childRunId to the parent's `AgentRunContext.openSubagentRunIds`
     *    so `exit_plan_mode` can block submission while research is in flight.
     *  - force `cleanup: "keep"` when the parent session is in plan mode,
     *    keeping research children visible in the session menu.
     */
    runId?: string;
  } & SpawnedToolContext,
): AnyAgentTool {
  return {
    label: "Sessions",
    name: "sessions_spawn",
    displaySummary: SESSIONS_SPAWN_TOOL_DISPLAY_SUMMARY,
    description: describeSessionsSpawnTool(),
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
      const label = readStringParam(params, "label") ?? "";
      const runtime = params.runtime === "acp" ? "acp" : "subagent";
      const requestedAgentId = readStringParam(params, "agentId");
      const resumeSessionId = readStringParam(params, "resumeSessionId");
      const modelOverride = readStringParam(params, "model");
      const thinkingOverrideRaw = readStringParam(params, "thinking");
      const cwd = readStringParam(params, "cwd");
      const mode = params.mode === "run" || params.mode === "session" ? params.mode : undefined;
      const cleanup =
        params.cleanup === "keep" || params.cleanup === "delete" ? params.cleanup : "keep";
      const expectsCompletionMessage = params.expectsCompletionMessage !== false;
      const sandbox = params.sandbox === "require" ? "require" : "inherit";
      const streamTo = params.streamTo === "parent" ? "parent" : undefined;
      const lightContext = params.lightContext === true;
      if (runtime === "acp" && lightContext) {
        throw new Error("lightContext is only supported for runtime='subagent'.");
      }
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

      const roleContext = requestedAgentId ? { role: requestedAgentId } : {};

      if (streamTo && runtime !== "acp") {
        return jsonResult({
          status: "error",
          error: `streamTo is only supported for runtime=acp; got runtime=${runtime}`,
          ...roleContext,
        });
      }

      if (resumeSessionId && runtime !== "acp") {
        return jsonResult({
          status: "error",
          error: `resumeSessionId is only supported for runtime=acp; got runtime=${runtime}`,
          ...roleContext,
        });
      }

      // Subagent concurrency cap during plan mode. Without this, an
      // agent in plan mode could spawn N research children and build
      // up a race surface where each completion fires an announce-
      // turn that could collide with exit_plan_mode submission or
      // approval resolution. The cap value is
      // `MAX_CONCURRENT_SUBAGENTS_IN_PLAN_MODE` (defined in
      // `src/agents/plan-mode/index.ts`); subsequent spawns over the
      // cap are rejected with a ToolInputError (agent learns to
      // sequence). Copilot review #68939 (round-2): comment kept
      // value-agnostic so it stays correct if the constant ever
      // changes — see the constant for the current numeric value.
      const spawnParentCtx = opts?.runId ? getAgentRunContext(opts.runId) : undefined;
      if (
        spawnParentCtx?.inPlanMode === true &&
        (spawnParentCtx.openSubagentRunIds?.size ?? 0) >= MAX_CONCURRENT_SUBAGENTS_IN_PLAN_MODE
      ) {
        throw new ToolInputError(
          `Plan mode allows only ${MAX_CONCURRENT_SUBAGENTS_IN_PLAN_MODE} concurrent research ${
            MAX_CONCURRENT_SUBAGENTS_IN_PLAN_MODE === 1 ? "subagent" : "subagents"
          }. Wait for the current child to return before spawning another.`,
        );
      }

      if (runtime === "acp") {
        const { isSpawnAcpAcceptedResult, spawnAcpDirect } = await loadAcpSpawnModule();
        if (Array.isArray(attachments) && attachments.length > 0) {
          return jsonResult({
            status: "error",
            error:
              "attachments are currently unsupported for runtime=acp; use runtime=subagent or remove attachments",
            ...roleContext,
          });
        }
        const result = await spawnAcpDirect(
          {
            task,
            label: label || undefined,
            agentId: requestedAgentId,
            resumeSessionId,
            cwd,
            mode: mode === "run" || mode === "session" ? mode : undefined,
            thread,
            sandbox,
            streamTo,
          },
          {
            agentSessionKey: opts?.agentSessionKey,
            agentChannel: opts?.agentChannel,
            agentAccountId: opts?.agentAccountId,
            agentTo: opts?.agentTo,
            agentThreadId: opts?.agentThreadId,
            agentGroupId: opts?.agentGroupId ?? undefined,
            // Copilot review #68939 (round-1): forward the
            // group-scoped context fields the WIP-strip in commit 4
            // (b6b2783ba3) inadvertently dropped. Without these,
            // spawned sessions in group channels (Discord/Slack
            // role-aware allowlists) lose downstream policy /
            // permission resolution. Re-added to mirror the parent
            // session's context.
            agentGroupSpace: opts?.agentGroupSpace,
            agentMemberRoleIds: opts?.agentMemberRoleIds,
            sandboxed: opts?.sandboxed,
          },
        );
        const childSessionKey = result.childSessionKey?.trim();
        const childRunId = isSpawnAcpAcceptedResult(result) ? result.runId?.trim() : undefined;
        const shouldTrackViaRegistry =
          result.status === "accepted" &&
          Boolean(childSessionKey) &&
          Boolean(childRunId) &&
          streamTo !== "parent";
        if (shouldTrackViaRegistry && childSessionKey && childRunId) {
          const cfg = loadConfig();
          const trackedSpawnMode = resolveTrackedSpawnMode({
            requestedMode: result.mode,
            threadRequested: thread,
          });
          // PR-8 follow-up: when the parent session is in plan mode,
          // force cleanup:"keep" so research children stay visible in the
          // session menu even after they complete. Prior default was to
          // purge them (cleanup:"delete" + time-based filter), which hid
          // results the user may want to inspect during plan synthesis.
          //
          // `inPlanMode` is mirrored onto AgentRunContext by the runner at
          // context-registration time (kept there to avoid a session-store
          // read on every spawn).
          const parentCtx = opts?.runId ? getAgentRunContext(opts.runId) : undefined;
          const parentInPlanMode = parentCtx?.inPlanMode === true;
          const trackedCleanup =
            trackedSpawnMode === "session" || parentInPlanMode ? "keep" : cleanup;
          const { mainKey, alias } = resolveMainSessionAlias(cfg);
          const requesterInternalKey = opts?.agentSessionKey
            ? resolveInternalSessionKey({
                key: opts.agentSessionKey,
                alias,
                mainKey,
              })
            : alias;
          const requesterDisplayKey = resolveDisplaySessionKey({
            key: requesterInternalKey,
            alias,
            mainKey,
          });
          const requesterOrigin = normalizeDeliveryContext({
            channel: opts?.agentChannel,
            accountId: opts?.agentAccountId,
            to: opts?.agentTo,
            threadId: opts?.agentThreadId,
          });
          try {
            registerSubagentRun({
              runId: childRunId,
              childSessionKey,
              requesterSessionKey: requesterInternalKey,
              requesterOrigin,
              requesterDisplayKey,
              task,
              cleanup: trackedCleanup,
              label: label || undefined,
              runTimeoutSeconds,
              expectsCompletionMessage,
              spawnMode: trackedSpawnMode,
            });
            // PR-8 follow-up: track this child in the parent's
            // `openSubagentRunIds` set so `exit_plan_mode` can block
            // plan submission while research children are in flight.
            // The completion hook in `subagent-registry-run-manager.ts`
            // drains the set when the child ends.
            if (opts?.runId && parentCtx) {
              trackOpenSubagentForParent(opts.runId, childRunId);
            }
          } catch (err) {
            // Best-effort only: the ACP turn was already started above, so deleting the
            // child session record here does not guarantee the in-flight run was aborted.
            await cleanupUntrackedAcpSession(childSessionKey);
            return jsonResult({
              status: "error",
              error: `Failed to register ACP run: ${summarizeError(err)}. Cleanup was attempted, but the already-started ACP run may still finish in the background.`,
              childSessionKey,
              runId: childRunId,
              ...roleContext,
            });
          }
        }
        return jsonResult(addRoleToFailureResult(result, requestedAgentId));
      }

      // PR-8 follow-up: mirror the in-plan-mode cleanup override applied
      // on the ACP path above. When the parent session is in plan mode,
      // force cleanup:"keep" so research children stay visible in the
      // session menu.
      const directParentCtx = opts?.runId ? getAgentRunContext(opts.runId) : undefined;
      const directInPlanMode = directParentCtx?.inPlanMode === true;
      const directCleanup: "delete" | "keep" | undefined = directInPlanMode ? "keep" : cleanup;
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
          cleanup: directCleanup,
          sandbox,
          lightContext,
          expectsCompletionMessage,
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
          // Copilot review #68939 (round-1): forward
          // `agentMemberRoleIds` (Discord/Slack role-aware
          // allowlist policy resolution). The subagent spawn path
          // already had `agentGroupSpace`; missing
          // `agentMemberRoleIds` was the WIP-strip artifact.
          agentMemberRoleIds: opts?.agentMemberRoleIds,
          requesterAgentIdOverride: opts?.requesterAgentIdOverride,
          workspaceDir: opts?.workspaceDir,
        },
      );
      // PR-8 follow-up: track child runId in the parent's
      // `openSubagentRunIds` so `exit_plan_mode` can block plan
      // submission while research is in flight.
      if (
        directParentCtx &&
        opts?.runId &&
        result.status === "accepted" &&
        typeof result.runId === "string" &&
        result.runId
      ) {
        trackOpenSubagentForParent(opts.runId, result.runId);
      }

      return jsonResult(addRoleToFailureResult(result, requestedAgentId));
    },
  };
}
