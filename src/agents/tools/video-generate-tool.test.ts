import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import * as mediaStore from "../../media/store.js";
import * as videoGenerationRuntime from "../../video-generation/runtime.js";
import { createVideoGenerateTool } from "./video-generate-tool.js";

const taskExecutorMocks = vi.hoisted(() => ({
  createRunningTaskRun: vi.fn(),
  completeTaskRunByRunId: vi.fn(),
  failTaskRunByRunId: vi.fn(),
}));

vi.mock("../../tasks/task-executor.js", () => taskExecutorMocks);

function asConfig(value: unknown): OpenClawConfig {
  return value as OpenClawConfig;
}

describe("createVideoGenerateTool", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(videoGenerationRuntime, "listRuntimeVideoGenerationProviders").mockReturnValue([]);
    taskExecutorMocks.createRunningTaskRun.mockReset();
    taskExecutorMocks.completeTaskRunByRunId.mockReset();
    taskExecutorMocks.failTaskRunByRunId.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns null when no video-generation config or auth-backed provider is available", () => {
    vi.spyOn(videoGenerationRuntime, "listRuntimeVideoGenerationProviders").mockReturnValue([]);

    expect(createVideoGenerateTool({ config: asConfig({}) })).toBeNull();
  });

  it("registers when video-generation config is present", () => {
    expect(
      createVideoGenerateTool({
        config: asConfig({
          agents: {
            defaults: {
              videoGenerationModel: { primary: "qwen/wan2.6-t2v" },
            },
          },
        }),
      }),
    ).not.toBeNull();
  });

  it("generates videos, saves them, and emits MEDIA paths", async () => {
    taskExecutorMocks.createRunningTaskRun.mockReturnValue({
      taskId: "task-123",
      runtime: "cli",
      requesterSessionKey: "agent:main:discord:direct:123",
      ownerKey: "agent:main:discord:direct:123",
      scopeKind: "session",
      task: "friendly lobster surfing",
      status: "running",
      deliveryStatus: "not_applicable",
      notifyPolicy: "silent",
      createdAt: Date.now(),
    });
    taskExecutorMocks.completeTaskRunByRunId.mockReturnValue(undefined);
    vi.spyOn(videoGenerationRuntime, "generateVideo").mockResolvedValue({
      provider: "qwen",
      model: "wan2.6-t2v",
      attempts: [],
      videos: [
        {
          buffer: Buffer.from("video-bytes"),
          mimeType: "video/mp4",
          fileName: "lobster.mp4",
        },
      ],
      metadata: { taskId: "task-1" },
    });
    vi.spyOn(mediaStore, "saveMediaBuffer").mockResolvedValueOnce({
      path: "/tmp/generated-lobster.mp4",
      id: "generated-lobster.mp4",
      size: 11,
      contentType: "video/mp4",
    });

    const tool = createVideoGenerateTool({
      config: asConfig({
        agents: {
          defaults: {
            videoGenerationModel: { primary: "qwen/wan2.6-t2v" },
          },
        },
      }),
      agentSessionKey: "agent:main:discord:direct:123",
      requesterOrigin: {
        channel: "discord",
        to: "channel:1",
      },
    });
    expect(tool).not.toBeNull();
    if (!tool) {
      throw new Error("expected video_generate tool");
    }

    const result = await tool.execute("call-1", { prompt: "friendly lobster surfing" });
    const text = (result.content?.[0] as { text: string } | undefined)?.text ?? "";

    expect(text).toContain("Generated 1 video with qwen/wan2.6-t2v.");
    expect(text).toContain("MEDIA:/tmp/generated-lobster.mp4");
    expect(result.details).toMatchObject({
      provider: "qwen",
      model: "wan2.6-t2v",
      count: 1,
      task: {
        taskId: "task-123",
      },
      media: {
        mediaUrls: ["/tmp/generated-lobster.mp4"],
      },
      paths: ["/tmp/generated-lobster.mp4"],
      metadata: { taskId: "task-1" },
    });
    expect(taskExecutorMocks.createRunningTaskRun).toHaveBeenCalledWith(
      expect.objectContaining({
        runtime: "cli",
        requesterSessionKey: "agent:main:discord:direct:123",
        ownerKey: "agent:main:discord:direct:123",
        label: "Video generation",
        task: "friendly lobster surfing",
      }),
    );
    expect(taskExecutorMocks.completeTaskRunByRunId).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: expect.stringMatching(/^tool:video_generate:/),
      }),
    );
  });

  it("marks the task failed when provider generation throws", async () => {
    taskExecutorMocks.createRunningTaskRun.mockReturnValue({
      taskId: "task-fail",
      runtime: "cli",
      requesterSessionKey: "agent:main:discord:direct:123",
      ownerKey: "agent:main:discord:direct:123",
      scopeKind: "session",
      task: "broken lobster",
      status: "running",
      deliveryStatus: "not_applicable",
      notifyPolicy: "silent",
      createdAt: Date.now(),
    });
    taskExecutorMocks.failTaskRunByRunId.mockReturnValue(undefined);
    vi.spyOn(videoGenerationRuntime, "generateVideo").mockRejectedValue(new Error("queue boom"));

    const tool = createVideoGenerateTool({
      config: asConfig({
        agents: {
          defaults: {
            videoGenerationModel: { primary: "qwen/wan2.6-t2v" },
          },
        },
      }),
      agentSessionKey: "agent:main:discord:direct:123",
    });
    expect(tool).not.toBeNull();
    if (!tool) {
      throw new Error("expected video_generate tool");
    }

    await expect(tool.execute("call-2", { prompt: "broken lobster" })).rejects.toThrow(
      "queue boom",
    );
    expect(taskExecutorMocks.failTaskRunByRunId).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: expect.stringMatching(/^tool:video_generate:/),
        error: "queue boom",
      }),
    );
  });

  it("shows duration normalization details from runtime metadata", async () => {
    vi.spyOn(videoGenerationRuntime, "generateVideo").mockResolvedValue({
      provider: "google",
      model: "veo-3.1-fast-generate-preview",
      attempts: [],
      videos: [
        {
          buffer: Buffer.from("video-bytes"),
          mimeType: "video/mp4",
          fileName: "lobster.mp4",
        },
      ],
      metadata: {
        requestedDurationSeconds: 5,
        normalizedDurationSeconds: 6,
        supportedDurationSeconds: [4, 6, 8],
      },
    });
    vi.spyOn(mediaStore, "saveMediaBuffer").mockResolvedValueOnce({
      path: "/tmp/generated-lobster.mp4",
      id: "generated-lobster.mp4",
      size: 11,
      contentType: "video/mp4",
    });

    const tool = createVideoGenerateTool({
      config: asConfig({
        agents: {
          defaults: {
            videoGenerationModel: { primary: "google/veo-3.1-fast-generate-preview" },
          },
        },
      }),
    });
    if (!tool) {
      throw new Error("expected video_generate tool");
    }

    const result = await tool.execute("call-1", {
      prompt: "friendly lobster surfing",
      durationSeconds: 5,
    });
    const text = (result.content?.[0] as { text: string } | undefined)?.text ?? "";

    expect(text).toContain("Duration normalized: requested 5s; used 6s.");
    expect(result.details).toMatchObject({
      durationSeconds: 6,
      requestedDurationSeconds: 5,
      supportedDurationSeconds: [4, 6, 8],
    });
  });

  it("lists supported provider durations when advertised", async () => {
    vi.spyOn(videoGenerationRuntime, "listRuntimeVideoGenerationProviders").mockReturnValue([
      {
        id: "google",
        defaultModel: "veo-3.1-fast-generate-preview",
        models: ["veo-3.1-fast-generate-preview"],
        capabilities: {
          maxDurationSeconds: 8,
          supportedDurationSeconds: [4, 6, 8],
        },
        generateVideo: vi.fn(async () => {
          throw new Error("not used");
        }),
      },
    ]);

    const tool = createVideoGenerateTool({
      config: asConfig({
        agents: {
          defaults: {
            videoGenerationModel: { primary: "google/veo-3.1-fast-generate-preview" },
          },
        },
      }),
    });
    if (!tool) {
      throw new Error("expected video_generate tool");
    }

    const result = await tool.execute("call-1", { action: "list" });
    const text = (result.content?.[0] as { text: string } | undefined)?.text ?? "";
    expect(text).toContain("supportedDurationSeconds=4/6/8");
  });
});
