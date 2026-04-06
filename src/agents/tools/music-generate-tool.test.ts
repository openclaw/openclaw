import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import * as mediaStore from "../../media/store.js";
import * as musicGenerationRuntime from "../../music-generation/runtime.js";
import * as musicGenerateBackground from "./music-generate-background.js";
import { createMusicGenerateTool } from "./music-generate-tool.js";

const taskRuntimeInternalMocks = vi.hoisted(() => ({
  listTasksForOwnerKey: vi.fn(),
}));

const taskExecutorMocks = vi.hoisted(() => ({
  createRunningTaskRun: vi.fn(),
  completeTaskRunByRunId: vi.fn(),
  failTaskRunByRunId: vi.fn(),
  recordTaskRunProgressByRunId: vi.fn(),
}));

vi.mock("../../tasks/runtime-internal.js", () => taskRuntimeInternalMocks);
vi.mock("../../tasks/task-executor.js", () => taskExecutorMocks);

function asConfig(value: unknown): OpenClawConfig {
  return value as OpenClawConfig;
}

describe("createMusicGenerateTool", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(musicGenerationRuntime, "listRuntimeMusicGenerationProviders").mockReturnValue([]);
    taskRuntimeInternalMocks.listTasksForOwnerKey.mockReset();
    taskRuntimeInternalMocks.listTasksForOwnerKey.mockReturnValue([]);
    taskExecutorMocks.createRunningTaskRun.mockReset();
    taskExecutorMocks.completeTaskRunByRunId.mockReset();
    taskExecutorMocks.failTaskRunByRunId.mockReset();
    taskExecutorMocks.recordTaskRunProgressByRunId.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns null when no music-generation config or auth-backed provider is available", () => {
    vi.spyOn(musicGenerationRuntime, "listRuntimeMusicGenerationProviders").mockReturnValue([]);
    expect(createMusicGenerateTool({ config: asConfig({}) })).toBeNull();
  });

  it("registers when music-generation config is present", () => {
    expect(
      createMusicGenerateTool({
        config: asConfig({
          agents: {
            defaults: {
              musicGenerationModel: { primary: "google/lyria-3-clip-preview" },
            },
          },
        }),
      }),
    ).not.toBeNull();
  });

  it("generates tracks, saves them, and emits MEDIA paths without a session-backed detach", async () => {
    taskExecutorMocks.createRunningTaskRun.mockReturnValue({
      taskId: "task-123",
      runtime: "cli",
      requesterSessionKey: "agent:main:discord:direct:123",
      ownerKey: "agent:main:discord:direct:123",
      scopeKind: "session",
      task: "night-drive synthwave",
      status: "running",
      deliveryStatus: "not_applicable",
      notifyPolicy: "silent",
      createdAt: Date.now(),
    });
    vi.spyOn(musicGenerationRuntime, "generateMusic").mockResolvedValue({
      provider: "google",
      model: "lyria-3-clip-preview",
      attempts: [],
      tracks: [
        {
          buffer: Buffer.from("music-bytes"),
          mimeType: "audio/mpeg",
          fileName: "night-drive.mp3",
        },
      ],
      lyrics: ["wake the city up"],
      metadata: { taskId: "music-task-1" },
    });
    vi.spyOn(mediaStore, "saveMediaBuffer").mockResolvedValueOnce({
      path: "/tmp/generated-night-drive.mp3",
      id: "generated-night-drive.mp3",
      size: 11,
      contentType: "audio/mpeg",
    });

    const tool = createMusicGenerateTool({
      config: asConfig({
        agents: {
          defaults: {
            musicGenerationModel: { primary: "google/lyria-3-clip-preview" },
          },
        },
      }),
    });
    expect(tool).not.toBeNull();
    if (!tool) {
      throw new Error("expected music_generate tool");
    }

    const result = await tool.execute("call-1", {
      prompt: "night-drive synthwave",
      instrumental: true,
    });
    const text = (result.content?.[0] as { text: string } | undefined)?.text ?? "";

    expect(text).toContain("Generated 1 track with google/lyria-3-clip-preview.");
    expect(text).toContain("Lyrics returned.");
    expect(text).toContain("MEDIA:/tmp/generated-night-drive.mp3");
    expect(result.details).toMatchObject({
      provider: "google",
      model: "lyria-3-clip-preview",
      count: 1,
      instrumental: true,
      lyrics: ["wake the city up"],
      task: {
        taskId: "task-123",
      },
      media: {
        mediaUrls: ["/tmp/generated-night-drive.mp3"],
      },
      paths: ["/tmp/generated-night-drive.mp3"],
      metadata: { taskId: "music-task-1" },
    });
    expect(taskExecutorMocks.createRunningTaskRun).not.toHaveBeenCalled();
    expect(taskExecutorMocks.completeTaskRunByRunId).not.toHaveBeenCalled();
  });

  it("starts background generation and wakes the session with MEDIA lines", async () => {
    taskExecutorMocks.createRunningTaskRun.mockReturnValue({
      taskId: "task-123",
      runtime: "cli",
      requesterSessionKey: "agent:main:discord:direct:123",
      ownerKey: "agent:main:discord:direct:123",
      scopeKind: "session",
      task: "night-drive synthwave",
      status: "running",
      deliveryStatus: "not_applicable",
      notifyPolicy: "silent",
      createdAt: Date.now(),
    });
    const wakeSpy = vi
      .spyOn(musicGenerateBackground, "wakeMusicGenerationTaskCompletion")
      .mockResolvedValue(undefined);
    vi.spyOn(musicGenerationRuntime, "generateMusic").mockResolvedValue({
      provider: "google",
      model: "lyria-3-clip-preview",
      attempts: [],
      tracks: [
        {
          buffer: Buffer.from("music-bytes"),
          mimeType: "audio/mpeg",
          fileName: "night-drive.mp3",
        },
      ],
      metadata: { taskId: "music-task-1" },
    });
    vi.spyOn(mediaStore, "saveMediaBuffer").mockResolvedValueOnce({
      path: "/tmp/generated-night-drive.mp3",
      id: "generated-night-drive.mp3",
      size: 11,
      contentType: "audio/mpeg",
    });

    let scheduledWork: (() => Promise<void>) | undefined;
    const tool = createMusicGenerateTool({
      config: asConfig({
        agents: {
          defaults: {
            musicGenerationModel: { primary: "google/lyria-3-clip-preview" },
          },
        },
      }),
      agentSessionKey: "agent:main:discord:direct:123",
      requesterOrigin: {
        channel: "discord",
        to: "channel:1",
      },
      scheduleBackgroundWork: (work) => {
        scheduledWork = work;
      },
    });
    if (!tool) {
      throw new Error("expected music_generate tool");
    }

    const result = await tool.execute("call-1", {
      prompt: "night-drive synthwave",
      instrumental: true,
    });
    const text = (result.content?.[0] as { text: string } | undefined)?.text ?? "";

    expect(text).toContain("Background task started for music generation (task-123).");
    expect(text).toContain("Do not call music_generate again for this request.");
    expect(result.details).toMatchObject({
      async: true,
      status: "started",
      task: {
        taskId: "task-123",
      },
      instrumental: true,
    });
    expect(typeof scheduledWork).toBe("function");
    await scheduledWork?.();
    expect(taskExecutorMocks.recordTaskRunProgressByRunId).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: expect.stringMatching(/^tool:music_generate:/),
        progressSummary: "Generating music",
      }),
    );
    expect(taskExecutorMocks.completeTaskRunByRunId).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: expect.stringMatching(/^tool:music_generate:/),
      }),
    );
    expect(wakeSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        handle: expect.objectContaining({
          taskId: "task-123",
        }),
        status: "ok",
        result: expect.stringContaining("MEDIA:/tmp/generated-night-drive.mp3"),
      }),
    );
  });

  it("lists provider capabilities", async () => {
    vi.spyOn(musicGenerationRuntime, "listRuntimeMusicGenerationProviders").mockReturnValue([
      {
        id: "minimax",
        defaultModel: "music-2.5+",
        models: ["music-2.5+"],
        capabilities: {
          maxTracks: 1,
          supportsLyrics: true,
          supportsInstrumental: true,
          supportsDuration: true,
          supportsFormat: true,
          supportedFormats: ["mp3"],
        },
        generateMusic: vi.fn(async () => {
          throw new Error("not used");
        }),
      },
    ]);

    const tool = createMusicGenerateTool({
      config: asConfig({
        agents: {
          defaults: {
            musicGenerationModel: { primary: "minimax/music-2.5+" },
          },
        },
      }),
    });
    if (!tool) {
      throw new Error("expected music_generate tool");
    }

    const result = await tool.execute("call-1", { action: "list" });
    const text = (result.content?.[0] as { text: string } | undefined)?.text ?? "";
    expect(text).toContain("supportedFormats=mp3");
    expect(text).toContain("instrumental");
  });
});
