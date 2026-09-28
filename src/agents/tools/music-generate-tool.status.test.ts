vi.mock("../media-generation-activity.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../media-generation-activity.js")>();
  return {
    ...actual,
    listMediaGenerationOperations: mediaActivityMocks.listMediaGenerationOperations,
  };
});
// Music generation status tests cover duplicate guards and explicit status
// actions for background music tasks.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as musicGenerationRuntime from "../../music-generation/runtime.js";
import { recordRecentMediaGenerationTaskStartForSession } from "../media-generation-task-status-shared.js";
import { resetRecentMediaGenerationDuplicateGuardsForTests } from "../media-generation-task-status-shared.test-support.js";
import { MUSIC_GENERATION_TASK_KIND } from "../media-generation-task-status.js";
import {
  createMusicGenerateDuplicateGuardResult,
  createMusicGenerateStatusActionResult,
} from "./music-generate-tool.actions.js";

const mediaActivityMocks = vi.hoisted(() => {
  const mocks = {
    listOperations: vi.fn(),
    listMediaGenerationOperations: vi.fn(),
  };
  mocks.listMediaGenerationOperations.mockImplementation((ownerKey) =>
    mocks.listOperations(ownerKey),
  );
  return mocks;
});

function resetMusicStatusMocks() {
  vi.restoreAllMocks();
  vi.spyOn(musicGenerationRuntime, "listRuntimeMusicGenerationProviders").mockReturnValue([]);
  mediaActivityMocks.listOperations.mockReset();
  mediaActivityMocks.listOperations.mockReturnValue([]);
  mediaActivityMocks.listMediaGenerationOperations.mockReset();
  mediaActivityMocks.listMediaGenerationOperations.mockImplementation((ownerKey) =>
    mediaActivityMocks.listOperations(ownerKey),
  );
  resetRecentMediaGenerationDuplicateGuardsForTests();
}

describe("createMusicGenerateTool status actions", () => {
  beforeEach(resetMusicStatusMocks);

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns active task status instead of starting a duplicate generation", async () => {
    // Duplicate guard responses prevent agents from launching parallel provider
    // jobs while a matching request is still running.
    mediaActivityMocks.listOperations.mockReturnValue([
      {
        taskId: "task-active",
        runtime: "cli",
        taskKind: MUSIC_GENERATION_TASK_KIND,
        sourceId: "music_generate:google",
        requesterSessionKey: "agent:main:discord:direct:123",
        ownerKey: "agent:main:discord:direct:123",
        scopeKind: "session",
        runId: "tool:music_generate:active",
        task: "night-drive synthwave",
        status: "running",
        deliveryStatus: "not_applicable",
        notifyPolicy: "silent",
        createdAt: Date.now(),
        progressSummary: "Generating music",
      },
    ]);

    const result = await createMusicGenerateDuplicateGuardResult("agent:main:discord:direct:123", {
      prompt: "night-drive synthwave",
    });

    expect(result?.content).toStrictEqual([
      {
        type: "text",
        text: "Music generation task task-active is already running with google.\nProgress: Generating music.\nDo not call music_generate again for this request. Wait for the completion event; the completion agent will send the finished music here.",
      },
    ]);
    expect(result?.details).toMatchObject({
      action: "status",
      duplicateGuard: true,
      active: true,
      existingTask: true,
      status: "running",
      taskKind: MUSIC_GENERATION_TASK_KIND,
      provider: "google",
      task: { taskId: "task-active", runId: "tool:music_generate:active" },
      progressSummary: "Generating music",
    });
  });

  it("reports active task status when action=status is requested", async () => {
    mediaActivityMocks.listOperations.mockReturnValue([
      {
        taskId: "task-active",
        runtime: "cli",
        taskKind: MUSIC_GENERATION_TASK_KIND,
        sourceId: "music_generate:minimax",
        requesterSessionKey: "agent:main:discord:direct:123",
        ownerKey: "agent:main:discord:direct:123",
        scopeKind: "session",
        runId: "tool:music_generate:active",
        task: "night-drive synthwave",
        status: "queued",
        deliveryStatus: "not_applicable",
        notifyPolicy: "silent",
        createdAt: Date.now(),
        progressSummary: "Queued music generation",
      },
    ]);

    const result = await createMusicGenerateStatusActionResult("agent:main:discord:direct:123");
    const text = (result.content?.[0] as { text: string } | undefined)?.text ?? "";

    expect(text).toContain("Music generation task task-active is already queued with minimax.");
    expect(result.details).toMatchObject({
      action: "status",
      active: true,
      existingTask: true,
      status: "queued",
      taskKind: MUSIC_GENERATION_TASK_KIND,
      provider: "minimax",
      task: { taskId: "task-active" },
      progressSummary: "Queued music generation",
    });
  });

  it("returns recent succeeded music status instead of starting a duplicate generation", async () => {
    const now = Date.now();
    recordRecentMediaGenerationTaskStartForSession({
      sessionKey: "agent:main:discord:direct:123",
      taskKind: MUSIC_GENERATION_TASK_KIND,
      sourcePrefix: "music_generate",
      taskId: "task-recent-music",
      runId: "tool:music_generate:recent",
      taskLabel: "night-drive synthwave",
      requestKey: "music-request:night-drive",
      providerId: "google",
      progressSummary: "Generating music",
      nowMs: now - 20_000,
    });
    mediaActivityMocks.listOperations.mockReturnValue([
      {
        taskId: "task-recent-music",
        runtime: "cli",
        taskKind: MUSIC_GENERATION_TASK_KIND,
        sourceId: "music_generate:google",
        requesterSessionKey: "agent:main:discord:direct:123",
        ownerKey: "agent:main:discord:direct:123",
        scopeKind: "session",
        runId: "tool:music_generate:recent",
        task: "night-drive synthwave",
        status: "succeeded",
        deliveryStatus: "not_applicable",
        notifyPolicy: "silent",
        createdAt: now - 20_000,
        endedAt: now - 10_000,
        progressSummary: "Generated 1 track",
      },
    ]);

    const result = await createMusicGenerateDuplicateGuardResult("agent:main:discord:direct:123", {
      requestKey: "music-request:night-drive",
    });
    const text = (result?.content?.[0] as { text: string } | undefined)?.text ?? "";

    expect(text).toContain("Music generation task task-recent-music recently succeeded");
    expect(text).toContain(
      "Do not call music_generate again for the same request; this recent music generation already completed.",
    );
    expect(result?.details?.duplicateGuard).toBe(true);
    expect(result?.details?.active).toBe(false);
  });
});
