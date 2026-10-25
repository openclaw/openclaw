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
import * as musicGenerationRegistry from "../../media-generation/registry.js";
import type { MediaGenerationOperation } from "../media-generation-activity.js";
import { resetGeneratedMediaTaskActivityForTests } from "../media-generation-activity.test-support.js";
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
  vi.spyOn(musicGenerationRegistry, "listMusicGenerationProviders").mockReturnValue([]);
  mediaActivityMocks.listOperations.mockReset();
  mediaActivityMocks.listOperations.mockReturnValue([]);
  mediaActivityMocks.listMediaGenerationOperations.mockReset();
  mediaActivityMocks.listMediaGenerationOperations.mockImplementation((ownerKey) =>
    mediaActivityMocks.listOperations(ownerKey),
  );
  resetGeneratedMediaTaskActivityForTests();
}

function musicStatusOperation(overrides: Partial<MediaGenerationOperation> = {}) {
  return {
    taskId: "task-active",
    taskKind: MUSIC_GENERATION_TASK_KIND,
    sourceId: "music_generate:google",
    requesterSessionKey: "agent:main:discord:direct:123",
    runId: "tool:music_generate:active",
    task: "night-drive synthwave",
    status: "running",
    progressSummary: "Generating music",
    ...overrides,
  };
}

describe("createMusicGenerateTool status actions", () => {
  beforeEach(resetMusicStatusMocks);

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns active task status instead of starting a duplicate generation", async () => {
    // Duplicate guard responses prevent agents from launching parallel provider
    // jobs while a matching request is still running.
    mediaActivityMocks.listOperations.mockReturnValue([musicStatusOperation()]);

    const result = await createMusicGenerateDuplicateGuardResult("agent:main:discord:direct:123", {
      prompt: "night-drive synthwave",
    });

    expect(result?.content).toStrictEqual([
      {
        type: "text",
        text: "Music generation task task-active is already running with google.\nProgress: Generating music.\nDo not call music_generate again for this request. Do not wait, poll, or yield for it: end this turn; the completion arrives as a later turn and sends the finished music here.",
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
      musicStatusOperation({
        sourceId: "music_generate:minimax",
        status: "queued",
        progressSummary: "Queued music generation",
      }),
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
    mediaActivityMocks.listOperations.mockReturnValue([
      musicStatusOperation({
        taskId: "task-recent-music",
        requestKey: "music-request:night-drive",
        runId: "tool:music_generate:recent",
        status: "succeeded",
        endedAt: now - 10_000,
        progressSummary: "Generated 1 track",
      }),
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
