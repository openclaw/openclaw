import { Type } from "@sinclair/typebox";
import type { GatewayMessageChannel } from "../../utils/message-channel.js";
import { waitForAgentRun, readLatestAssistantReply } from "../run-wait.js";
import { optionalStringEnum } from "../schema/typebox.js";
import type { SpawnedToolContext } from "../spawned-context.js";
import {
  registerOutputCaptureGate,
  signalOutputCaptured,
  subagentRuns,
} from "../subagent-registry-memory.js";
import { spawnSubagentDirect } from "../subagent-spawn.js";
import {
  describeSessionsDelegateTool,
  describeSessionsDelegateBatchTool,
  SESSIONS_DELEGATE_TOOL_DISPLAY_SUMMARY,
  SESSIONS_DELEGATE_BATCH_TOOL_DISPLAY_SUMMARY,
} from "../tool-description-presets.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam, ToolInputError } from "./common.js";

const DEFAULT_DELEGATE_TIMEOUT_SECONDS = 120;
const MAX_BATCH_SIZE = 10;
const FROZEN_RESULT_POLL_INTERVAL_MS = 200;
const FROZEN_RESULT_MAX_POLL_MS = 2000;

type DelegateToolOpts = {
  agentSessionKey?: string;
  agentChannel?: GatewayMessageChannel;
  agentAccountId?: string;
  agentTo?: string;
  agentThreadId?: string | number;
  agentGroupId?: string | null;
  agentGroupChannel?: string | null;
  agentGroupSpace?: string | null;
  sandboxed?: boolean;
  requesterAgentIdOverride?: string;
} & SpawnedToolContext;

const SESSIONS_DELEGATE_SANDBOX_MODES = ["inherit", "require"] as const;

const SessionsDelegateToolSchema = Type.Object({
  task: Type.String(),
  label: Type.Optional(Type.String()),
  agentId: Type.Optional(Type.String()),
  model: Type.Optional(Type.String()),
  thinking: Type.Optional(Type.String()),
  timeoutSeconds: Type.Optional(Type.Number({ minimum: 1 })),
  sandbox: optionalStringEnum(SESSIONS_DELEGATE_SANDBOX_MODES),
  lightContext: Type.Optional(Type.Boolean()),
  cleanup: optionalStringEnum(["delete", "keep"] as const),
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
});

const SessionsDelegateBatchToolSchema = Type.Object({
  tasks: Type.Array(
    Type.Object({
      task: Type.String(),
      label: Type.Optional(Type.String()),
      agentId: Type.Optional(Type.String()),
      model: Type.Optional(Type.String()),
      timeoutSeconds: Type.Optional(Type.Number({ minimum: 1 })),
    }),
    { minItems: 1, maxItems: MAX_BATCH_SIZE },
  ),
  timeoutSeconds: Type.Optional(Type.Number({ minimum: 1 })),
  failureMode: optionalStringEnum(["partial", "all"] as const),
});

/**
 * Wait for `frozenResultText` to appear in the registry entry.
 * There is a small race between `waitForAgentRun` resolving and the lifecycle
 * controller capturing the frozen result, so we poll briefly before falling back
 * to `readLatestAssistantReply`.
 */
async function readChildOutput(params: {
  runId: string;
  childSessionKey: string;
}): Promise<string | undefined> {
  const deadline = Date.now() + FROZEN_RESULT_MAX_POLL_MS;
  while (Date.now() < deadline) {
    const entry = subagentRuns.get(params.runId);
    // frozenResultText is a string when captured, null when the immediate capture
    // missed the reply (waitForReply: false for delegate runs), or undefined when
    // the lifecycle controller has not yet processed the end event.
    if (entry && typeof entry.frozenResultText === "string") {
      return entry.frozenResultText;
    }
    // null means capture ran but found nothing — stop polling, fall through to
    // the history-based fallback which can read the reply even after a race.
    if (entry && entry.frozenResultText === null) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, FROZEN_RESULT_POLL_INTERVAL_MS));
  }
  // Fall back to reading the latest assistant reply from chat history.
  return readLatestAssistantReply({ sessionKey: params.childSessionKey });
}

type SingleDelegateResult = {
  status: "ok" | "timeout" | "error" | "forbidden";
  output?: string;
  runId?: string;
  childSessionKey?: string;
  runtimeMs?: number;
  error?: string;
};

async function executeSingleDelegate(
  params: Record<string, unknown>,
  opts: DelegateToolOpts | undefined,
): Promise<SingleDelegateResult> {
  const task = readStringParam(params, "task", { required: true });
  const label = readStringParam(params, "label") ?? "";
  const agentId = readStringParam(params, "agentId");
  const model = readStringParam(params, "model");
  const thinking = readStringParam(params, "thinking");
  const sandbox = params.sandbox === "require" ? "require" : ("inherit" as const);
  const lightContext = params.lightContext === true;
  const cleanup =
    params.cleanup === "keep" || params.cleanup === "delete" ? params.cleanup : "delete";
  const timeoutSecondsRaw =
    typeof params.timeoutSeconds === "number" ? params.timeoutSeconds : undefined;
  const timeoutSeconds =
    typeof timeoutSecondsRaw === "number" && Number.isFinite(timeoutSecondsRaw)
      ? Math.max(1, Math.floor(timeoutSecondsRaw))
      : DEFAULT_DELEGATE_TIMEOUT_SECONDS;
  const attachments = Array.isArray(params.attachments)
    ? (params.attachments as Array<{
        name: string;
        content: string;
        encoding?: "utf8" | "base64";
        mimeType?: string;
      }>)
    : undefined;

  const startedAt = Date.now();

  const spawnResult = await spawnSubagentDirect(
    {
      task,
      label: label || undefined,
      agentId,
      model,
      thinking,
      runTimeoutSeconds: timeoutSeconds,
      thread: false,
      mode: "run",
      cleanup,
      sandbox,
      lightContext,
      expectsCompletionMessage: false,
      attachments,
    },
    {
      agentSessionKey: opts?.agentSessionKey,
      agentChannel: opts?.agentChannel,
      agentAccountId: opts?.agentAccountId,
      agentTo: opts?.agentTo,
      agentThreadId: opts?.agentThreadId,
      agentGroupId: opts?.agentGroupId ?? undefined,
      agentGroupChannel: opts?.agentGroupChannel ?? undefined,
      agentGroupSpace: opts?.agentGroupSpace ?? undefined,
      requesterAgentIdOverride: opts?.requesterAgentIdOverride,
      workspaceDir: opts?.workspaceDir,
    },
  );

  if (spawnResult.status !== "accepted") {
    return {
      status: spawnResult.status === "forbidden" ? "forbidden" : "error",
      error: spawnResult.error ?? "Spawn failed",
      childSessionKey: spawnResult.childSessionKey,
    };
  }

  const childSessionKey = spawnResult.childSessionKey!;
  const runId = spawnResult.runId!;

  // Register a gate so the lifecycle cleanup fast path waits for us to
  // finish reading the child output before deleting the session/entry.
  registerOutputCaptureGate(runId);

  const waitResult = await waitForAgentRun({
    runId,
    timeoutMs: timeoutSeconds * 1000,
  });

  if (waitResult.status === "timeout") {
    signalOutputCaptured(runId);
    return {
      status: "timeout",
      runId,
      childSessionKey,
      runtimeMs: Date.now() - startedAt,
      error: "Child run did not complete within the timeout.",
    };
  }

  if (waitResult.status === "error") {
    signalOutputCaptured(runId);
    return {
      status: "error",
      runId,
      childSessionKey,
      runtimeMs: Date.now() - startedAt,
      error: waitResult.error ?? "Child run failed.",
    };
  }

  const output = await readChildOutput({ runId, childSessionKey });
  signalOutputCaptured(runId);

  return {
    status: "ok",
    output: output ?? undefined,
    runId,
    childSessionKey,
    runtimeMs: Date.now() - startedAt,
  };
}

export function createSessionsDelegateTool(opts?: DelegateToolOpts): AnyAgentTool {
  return {
    label: "Sessions",
    name: "sessions_delegate",
    displaySummary: SESSIONS_DELEGATE_TOOL_DISPLAY_SUMMARY,
    description: describeSessionsDelegateTool(),
    parameters: SessionsDelegateToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const result = await executeSingleDelegate(params, opts);
      return jsonResult(result);
    },
  };
}

export function createSessionsDelegateBatchTool(opts?: DelegateToolOpts): AnyAgentTool {
  return {
    label: "Sessions",
    name: "sessions_delegate_batch",
    displaySummary: SESSIONS_DELEGATE_BATCH_TOOL_DISPLAY_SUMMARY,
    description: describeSessionsDelegateBatchTool(),
    parameters: SessionsDelegateBatchToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const tasks = params.tasks as Array<Record<string, unknown>>;
      if (!Array.isArray(tasks) || tasks.length === 0) {
        throw new ToolInputError("tasks must be a non-empty array.");
      }
      if (tasks.length > MAX_BATCH_SIZE) {
        throw new ToolInputError(`tasks may contain at most ${MAX_BATCH_SIZE} items.`);
      }
      const failureMode = params.failureMode === "all" ? "all" : "partial";
      const overallTimeoutSeconds =
        typeof params.timeoutSeconds === "number" && Number.isFinite(params.timeoutSeconds)
          ? Math.max(1, Math.floor(params.timeoutSeconds))
          : undefined;

      // Spawn all children, then wait in parallel.
      const spawnedTasks: Array<{
        index: number;
        task: string;
        promise: Promise<SingleDelegateResult>;
      }> = [];

      for (const [i, taskParams] of tasks.entries()) {
        const taskStr = typeof taskParams.task === "string" ? taskParams.task : `Task ${i + 1}`;
        // Each child gets its own timeout; the overall timeout is enforced via Promise.race below.
        const childParams: Record<string, unknown> = {
          ...taskParams,
          // Use per-task timeout if set, otherwise fall back to overall timeout.
          timeoutSeconds: taskParams.timeoutSeconds ?? overallTimeoutSeconds,
        };
        spawnedTasks.push({
          index: i,
          task: taskStr,
          promise: executeSingleDelegate(childParams, opts),
        });
      }

      // Wait for all tasks, optionally bounded by the overall timeout.
      let settledResults: Array<PromiseSettledResult<SingleDelegateResult>>;
      if (overallTimeoutSeconds) {
        const timeoutPromise = new Promise<"timeout">((resolve) =>
          setTimeout(() => resolve("timeout"), overallTimeoutSeconds * 1000),
        );
        const allPromise = Promise.allSettled(spawnedTasks.map((t) => t.promise));
        const raceResult = await Promise.race([allPromise, timeoutPromise]);
        if (raceResult === "timeout") {
          // Collect whatever has settled so far.
          settledResults = await Promise.allSettled(
            spawnedTasks.map((t) =>
              Promise.race([
                t.promise,
                new Promise<SingleDelegateResult>((resolve) =>
                  // Give a tiny grace period for already-completing tasks.
                  setTimeout(
                    () =>
                      resolve({
                        status: "timeout",
                        error: "Overall batch timeout exceeded.",
                      }),
                    500,
                  ),
                ),
              ]),
            ),
          );
        } else {
          settledResults = raceResult;
        }
      } else {
        settledResults = await Promise.allSettled(spawnedTasks.map((t) => t.promise));
      }

      // Collect results.
      const results: Array<{
        index: number;
        task: string;
        status: string;
        output?: string;
        runId?: string;
        childSessionKey?: string;
        runtimeMs?: number;
        error?: string;
      }> = [];

      let completed = 0;
      let failed = 0;
      let timedOut = 0;

      for (const [i, settled] of settledResults.entries()) {
        const spawned = spawnedTasks[i];
        if (!spawned) {
          continue;
        }
        if (settled.status === "fulfilled") {
          const r = settled.value;
          results.push({
            index: spawned.index,
            task: spawned.task,
            status: r.status,
            output: r.output,
            runId: r.runId,
            childSessionKey: r.childSessionKey,
            runtimeMs: r.runtimeMs,
            error: r.error,
          });
          if (r.status === "ok") {
            completed++;
          } else if (r.status === "timeout") {
            timedOut++;
          } else {
            failed++;
          }
        } else {
          failed++;
          results.push({
            index: spawned.index,
            task: spawned.task,
            status: "error",
            error: settled.reason instanceof Error ? settled.reason.message : "Unknown error",
          });
        }
      }

      const allSucceeded = completed === tasks.length;
      const batchStatus = allSucceeded ? "ok" : failureMode === "all" ? "error" : "partial";

      return jsonResult({
        status: batchStatus,
        results,
        summary: {
          total: tasks.length,
          completed,
          failed,
          timedOut,
        },
      });
    },
  };
}
