vi.mock("../media-generation-activity.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../media-generation-activity.js")>()),
  listMediaGenerationOperations: listOperations,
}));
import { expect, it, vi } from "vitest";
import {
  createMusicGenerateDuplicateGuardResult,
  createMusicGenerateStatusActionResult,
} from "./music-generate-tool.actions.js";

const { listOperations } = vi.hoisted(() => ({ listOperations: vi.fn() }));

it("reports an active task and rejects a duplicate request without starting more work", async () => {
  const sessionKey = "agent:main:discord:direct:123";
  const progressSummary = "Queued music generation";
  listOperations.mockReturnValue([
    {
      taskId: "task-active",
      taskKind: "music_generation",
      sourceId: "music_generate:minimax",
      requesterSessionKey: sessionKey,
      task: "night-drive synthwave",
      status: "queued",
      progressSummary,
    },
  ]);
  const status = await createMusicGenerateStatusActionResult(sessionKey);
  const duplicate = await createMusicGenerateDuplicateGuardResult(sessionKey, {
    prompt: "night-drive synthwave",
  });
  for (const result of [status, duplicate]) {
    expect(result?.details).toMatchObject({
      active: true,
      status: "queued",
      provider: "minimax",
      progressSummary,
    });
    expect(result?.content[0]).toMatchObject({
      text: expect.stringContaining(
        "Music generation task task-active is already queued with minimax.",
      ),
    });
  }
  expect(duplicate?.details).toHaveProperty("duplicateGuard", true);
  expect(duplicate?.content).toStrictEqual([
    {
      type: "text",
      text: "Music generation task task-active is already queued with minimax.\nProgress: Queued music generation.\nDo not call music_generate again for this request. Do not wait, poll, or yield for it: end this turn; the completion arrives as a later turn and sends the finished music here.",
    },
  ]);
});
