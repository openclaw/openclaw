import fs from "node:fs/promises";
import { isNotFoundPathError } from "../../infra/path-guards.js";
import { validateJsonSchemaValue } from "../../plugins/schema-validator.js";
import {
  TrajectoryV1Schema,
  type ReplayRunsCreateRequest,
  type ReplayRunsGetStateResponse,
  type TrajectoryV1,
} from "../../research/contracts/index.js";
import { ReplayControlError } from "./errors.js";
import { buildRecordedToolLookup } from "./recorded-tools.js";
import type { ReplayLimits, ReplayRunState, ReplayStepResult } from "./types.js";

const DEFAULT_LIMITS: ReplayLimits = {
  maxSteps: 512,
  maxToolCalls: 2048,
  timeoutMs: 300_000,
};

function resolveLimits(request: ReplayRunsCreateRequest): ReplayLimits {
  return {
    maxSteps: request.maxSteps ?? DEFAULT_LIMITS.maxSteps,
    maxToolCalls: request.maxToolCalls ?? DEFAULT_LIMITS.maxToolCalls,
    timeoutMs: request.timeoutMs ?? DEFAULT_LIMITS.timeoutMs,
  };
}

async function loadTrajectory(trajectoryPath: string): Promise<TrajectoryV1> {
  let raw: string;
  try {
    raw = await fs.readFile(trajectoryPath, "utf8");
  } catch (err) {
    if (isNotFoundPathError(err)) {
      throw new ReplayControlError({
        code: "not_found",
        status: 404,
        message: `Trajectory file not found: ${trajectoryPath}`,
      });
    }
    throw new ReplayControlError({
      code: "invalid_request",
      status: 400,
      message: `Cannot read trajectory file: ${trajectoryPath}`,
    });
  }
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new ReplayControlError({
      code: "invalid_request",
      status: 400,
      message: "Trajectory file is not valid JSON",
    });
  }
  const validated = validateJsonSchemaValue({
    schema: TrajectoryV1Schema,
    cacheKey: "replay.control.trajectory.v1",
    value,
  });
  if (!validated.ok) {
    const reason = validated.errors.map((error) => error.text).join("; ");
    throw new ReplayControlError({
      code: "invalid_request",
      status: 400,
      message: `Invalid trajectory: ${reason}`,
    });
  }
  return value as TrajectoryV1;
}

export async function createReplayRun(params: {
  runId: string;
  request: ReplayRunsCreateRequest;
  nowMs?: number;
}): Promise<ReplayRunState> {
  const nowMs = params.nowMs ?? Date.now();
  const trajectory = await loadTrajectory(params.request.trajectoryPath);
  const toolAllowlist = new Set(
    params.request.toolAllowlist !== undefined
      ? params.request.toolAllowlist
      : trajectory.toolCalls.map((toolCall) => toolCall.toolName),
  );
  return {
    runId: params.runId,
    mode: "recorded",
    status: "created",
    trajectory,
    stepIdx: 0,
    toolCallCount: 0,
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
    limits: resolveLimits(params.request),
    toolAllowlist,
  };
}

function getAssistantTextForStep(trajectory: TrajectoryV1, stepIdx: number): string | undefined {
  const assistantMessages = trajectory.messages.filter((message) => message.role === "assistant");
  return assistantMessages[stepIdx]?.text;
}

export function stepReplayRun(params: { run: ReplayRunState; nowMs?: number }): ReplayStepResult {
  const nowMs = params.nowMs ?? Date.now();
  const { run } = params;
  if (run.status === "closed") {
    throw new ReplayControlError({
      code: "conflict",
      status: 409,
      message: `Run is closed: ${run.runId}`,
    });
  }
  if (run.status === "completed") {
    throw new ReplayControlError({
      code: "conflict",
      status: 409,
      message: `Run is already completed: ${run.runId}`,
    });
  }
  if (run.stepIdx >= run.limits.maxSteps) {
    throw new ReplayControlError({
      code: "limit_exceeded",
      status: 400,
      message: `Max steps exceeded (${run.limits.maxSteps})`,
    });
  }
  if (nowMs - run.createdAtMs > run.limits.timeoutMs) {
    throw new ReplayControlError({
      code: "limit_exceeded",
      status: 400,
      message: `Replay timeout exceeded (${run.limits.timeoutMs}ms)`,
    });
  }

  const currentStep = run.stepIdx;
  const stepToolCalls = run.trajectory.toolCalls.filter(
    (toolCall) => toolCall.stepIdx === currentStep,
  );
  const nextToolCallCount = run.toolCallCount + stepToolCalls.length;
  if (nextToolCallCount > run.limits.maxToolCalls) {
    throw new ReplayControlError({
      code: "limit_exceeded",
      status: 400,
      message: `Max tool calls exceeded (${run.limits.maxToolCalls})`,
    });
  }

  for (const toolCall of stepToolCalls) {
    if (!run.toolAllowlist.has(toolCall.toolName)) {
      throw new ReplayControlError({
        code: "tool_not_recorded",
        status: 400,
        message: `Tool is not allowlisted in replay: ${toolCall.toolName}`,
      });
    }
  }

  const lookup = buildRecordedToolLookup(run.trajectory);
  const replayedToolCalls = stepToolCalls.map((toolCall) => {
    const recorded = lookup.byToolCallId.get(toolCall.toolCallId);
    if (!recorded) {
      throw new ReplayControlError({
        code: "tool_not_recorded",
        status: 400,
        message: `No recorded output for toolCallId=${toolCall.toolCallId}`,
      });
    }
    return recorded;
  });

  run.stepIdx += 1;
  run.toolCallCount = nextToolCallCount;
  const totalSteps = Math.max(
    run.trajectory.messages.filter((message) => message.role === "assistant").length,
    Math.max(0, ...run.trajectory.toolCalls.map((toolCall) => toolCall.stepIdx + 1)),
  );
  const done = run.stepIdx >= totalSteps;
  run.status = done ? "completed" : "running";
  run.updatedAtMs = nowMs;

  return {
    runId: run.runId,
    status: run.status === "completed" ? "completed" : "running",
    stepIdx: currentStep,
    done,
    assistantText: getAssistantTextForStep(run.trajectory, currentStep),
    replayedToolCalls,
  };
}

export function closeReplayRun(run: ReplayRunState, nowMs?: number): void {
  run.status = "closed";
  run.closedAtMs = nowMs ?? Date.now();
  run.updatedAtMs = run.closedAtMs;
}

export function toReplayRunStateResponse(run: ReplayRunState): ReplayRunsGetStateResponse {
  const totalSteps = Math.max(
    run.trajectory.messages.filter((message) => message.role === "assistant").length,
    Math.max(0, ...run.trajectory.toolCalls.map((toolCall) => toolCall.stepIdx + 1)),
  );
  return {
    runId: run.runId,
    status: run.status,
    mode: run.mode,
    stepIdx: run.stepIdx,
    totalSteps,
    toolCallCount: run.toolCallCount,
    createdAtMs: run.createdAtMs,
    updatedAtMs: run.updatedAtMs,
  };
}
