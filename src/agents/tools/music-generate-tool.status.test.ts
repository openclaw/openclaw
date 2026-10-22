vi.mock("../media-generation-activity.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../media-generation-activity.js")>();
  return {
    ...actual,
    listMediaGenerationOperations: mediaActivityMocks.listMediaGenerationOperations,
  };
});
import { beforeEach, expect, it, vi } from "vitest";
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
function setOperation(overrides: Partial<MediaGenerationOperation> = {}) {
  mediaActivityMocks.listMediaGenerationOperations.mockReturnValue([
    {
      taskId: "task-active",
      taskKind: MUSIC_GENERATION_TASK_KIND,
      sourceId: "music_generate:google",
      requesterSessionKey: sessionKey,
      runId: "tool:music_generate:active",
      task: prompt,
      status: "running",
      progressSummary: "Generating music",
      ...overrides,
    },
  ]);
}

beforeEach(() => {
  mediaActivityMocks.listMediaGenerationOperations.mockReset().mockReturnValue([]);
  resetRecentMediaGenerationDuplicateGuardsForTests();
});

it.each([
  ["running", "google", "Generating music"],
  ["queued", "minimax", "Queued music generation"],
] as const)(
  "reports %s music tasks without starting another",
  async (status, provider, progressSummary) => {
    setOperation({ sourceId: `music_generate:${provider}`, status, progressSummary });
    const duplicate = status === "running";
    const result = duplicate
      ? await createMusicGenerateDuplicateGuardResult(sessionKey, { prompt })
      : await createMusicGenerateStatusActionResult(sessionKey);
    expect(result?.details).toMatchObject({
      action: "status",
      ...(duplicate ? { duplicateGuard: true } : {}),
      active: true,
      existingTask: true,
      status,
      taskKind: MUSIC_GENERATION_TASK_KIND,
      provider,
      task: { taskId: "task-active", runId: "tool:music_generate:active" },
      progressSummary,
    });
    if (duplicate) {
      expect(result?.content).toStrictEqual([
        {
          type: "text",
          text: "Music generation task task-active is already running with google.\nProgress: Generating music.\nDo not call music_generate again for this request. Do not wait, poll, or yield for it: end this turn; the completion arrives as a later turn and sends the finished music here.",
        },
      ]);
    } else {
      expect(result?.content[0]?.text).toContain(
        "Music generation task task-active is already queued with minimax.",
      );
    }
  },
);
