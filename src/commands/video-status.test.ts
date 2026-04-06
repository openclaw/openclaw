import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OutputRuntimeEnv } from "../runtime.js";
import { videoStatusCommand } from "./video-status.js";

const mocks = vi.hoisted(() => ({
  getTaskById: vi.fn(),
  buildVideoGenerationTaskStatusDetails: vi.fn(),
  buildVideoGenerationTaskStatusText: vi.fn(),
}));

vi.mock("../tasks/task-registry.js", () => ({
  getTaskById: mocks.getTaskById,
}));

vi.mock("../agents/video-generation-task-status.js", () => ({
  buildVideoGenerationTaskStatusDetails: mocks.buildVideoGenerationTaskStatusDetails,
  buildVideoGenerationTaskStatusText: mocks.buildVideoGenerationTaskStatusText,
  VIDEO_GENERATION_TASK_KIND: "video_generation",
}));

function createMockRuntime(): OutputRuntimeEnv & {
  output: string[];
  jsonOutput: unknown[];
  exitCode: number | null;
} {
  const output: string[] = [];
  const jsonOutput: unknown[] = [];
  let exitCode: number | null = null;
  return {
    output,
    jsonOutput,
    get exitCode() {
      return exitCode;
    },
    log: (...args: unknown[]) => {
      output.push(args.map(String).join(" "));
    },
    error: (...args: unknown[]) => {
      output.push(`ERROR: ${args.map(String).join(" ")}`);
    },
    exit: ((code: number) => {
      exitCode = code;
    }) as unknown as (code: number) => never,
    writeStdout: (value: string) => {
      output.push(value);
    },
    writeJson: (value: unknown) => {
      jsonOutput.push(value);
    },
  };
}

describe("videoStatusCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows status text for a valid video generation task", async () => {
    const task = { taskId: "task-1", taskKind: "video_generation", status: "running" };
    mocks.getTaskById.mockReturnValue(task);
    mocks.buildVideoGenerationTaskStatusText.mockReturnValue("Video generation in progress...");

    const runtime = createMockRuntime();
    await videoStatusCommand({ taskId: "task-1" }, runtime);

    expect(runtime.output).toContain("Video generation in progress...");
    expect(runtime.exitCode).toBeNull();
  });

  it("outputs JSON when --json flag is set", async () => {
    const task = { taskId: "task-1", taskKind: "video_generation", status: "complete" };
    const details = { taskId: "task-1", status: "complete", provider: "google" };
    mocks.getTaskById.mockReturnValue(task);
    mocks.buildVideoGenerationTaskStatusDetails.mockReturnValue(details);

    const runtime = createMockRuntime();
    await videoStatusCommand({ taskId: "task-1", json: true }, runtime);

    expect(runtime.jsonOutput).toHaveLength(1);
    expect(runtime.jsonOutput[0]).toEqual(details);
  });

  it("exits 1 when task not found", async () => {
    mocks.getTaskById.mockReturnValue(undefined);

    const runtime = createMockRuntime();
    await videoStatusCommand({ taskId: "missing-task" }, runtime);

    expect(runtime.exitCode).toBe(1);
    expect(runtime.output.some((line) => line.includes("Task not found"))).toBe(true);
  });

  it("exits 1 when task is not a video generation task", async () => {
    mocks.getTaskById.mockReturnValue({
      taskId: "task-1",
      taskKind: "image_generation",
      status: "running",
    });

    const runtime = createMockRuntime();
    await videoStatusCommand({ taskId: "task-1" }, runtime);

    expect(runtime.exitCode).toBe(1);
    expect(runtime.output.some((line) => line.includes("not a video generation task"))).toBe(true);
  });
});
