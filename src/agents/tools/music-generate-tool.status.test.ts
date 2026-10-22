vi.mock("../media-generation-activity.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../media-generation-activity.js")>();
  return {
    ...actual,
    listMediaGenerationOperations: mediaActivityMocks.listMediaGenerationOperations,
  };
});
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as musicGenerationRegistry from "../../media-generation/registry.js";
import type { MediaGenerationOperation } from "../media-generation-activity.js";
import { resetRecentMediaGenerationDuplicateGuardsForTests } from "../media-generation-task-status-shared.test-support.js";
import { MUSIC_GENERATION_TASK_KIND } from "../media-generation-task-status.js";
import {
  createMusicGenerateDuplicateGuardResult,
  createMusicGenerateStatusActionResult,
} from "./music-generate-tool.actions.js";

const mediaActivityMocks = vi.hoisted(() => ({ listMediaGenerationOperations: vi.fn() }));
const sessionKey = "agent:main:discord:direct:123";
const prompt = "night-drive synthwave";
function setOperation(overrides: Partial<MediaGenerationOperation> & { createdAt?: number } = {}) {
  mediaActivityMocks.listMediaGenerationOperations.mockReturnValue([
    {
      taskId: "task-active",
      runtime: "cli",
      taskKind: MUSIC_GENERATION_TASK_KIND,
      sourceId: "music_generate:google",
      requesterSessionKey: sessionKey,
      ownerKey: sessionKey,
      scopeKind: "session",
      runId: "tool:music_generate:active",
      task: prompt,
      status: "running",
      deliveryStatus: "not_applicable",
      notifyPolicy: "silent",
      createdAt: Date.now(),
      progressSummary: "Generating music",
      ...overrides,
    },
  ]);
}

function resetMusicStatusMocks() {
  vi.restoreAllMocks();
  vi.spyOn(musicGenerationRegistry, "listMusicGenerationProviders").mockReturnValue([]);
  mediaActivityMocks.listMediaGenerationOperations.mockReset().mockReturnValue([]);
  resetRecentMediaGenerationDuplicateGuardsForTests();
}

describe("createMusicGenerateTool status actions", () => {
  beforeEach(resetMusicStatusMocks);

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns active task status instead of starting a duplicate generation", async () => {
    setOperation();
    const result = await createMusicGenerateDuplicateGuardResult(sessionKey, { prompt });

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
    setOperation({
      sourceId: "music_generate:minimax",
      status: "queued",
      progressSummary: "Queued music generation",
    });
    const result = await createMusicGenerateStatusActionResult(sessionKey);
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
    setOperation({
      taskId: "task-recent-music",
      requestKey: "music-request:night-drive",
      runId: "tool:music_generate:recent",
      status: "succeeded",
      createdAt: Date.now() - 20_000,
      endedAt: Date.now() - 10_000,
      progressSummary: "Generated 1 track",
    });
    const result = await createMusicGenerateDuplicateGuardResult(sessionKey, {
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
