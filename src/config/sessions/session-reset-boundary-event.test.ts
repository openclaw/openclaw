import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempDir } from "../../test-helpers/temp-dir.js";
import {
  buildSessionResetBoundaryEvent,
  buildSessionResetBoundaryPlan,
} from "./session-reset-boundary-event.js";

function message(params: {
  id: string;
  parentId: string | null;
  role: "user" | "assistant";
  content: string;
  second: number;
}) {
  return {
    type: "message",
    id: params.id,
    parentId: params.parentId,
    timestamp: `2026-07-22T00:00:${String(params.second).padStart(2, "0")}.000Z`,
    message: { role: params.role, content: params.content },
  };
}

describe("reset boundary planning", () => {
  it("selects repeated reset tails from the current logical window", () => {
    const oldUser = message({
      id: "old-user",
      parentId: null,
      role: "user",
      content: "discarded",
      second: 1,
    });
    const oldAssistant = message({
      id: "old-assistant",
      parentId: oldUser.id,
      role: "assistant",
      content: "discarded answer",
      second: 2,
    });
    const keptUser = message({
      id: "kept-user",
      parentId: oldAssistant.id,
      role: "user",
      content: "kept",
      second: 3,
    });
    const keptAssistant = message({
      id: "kept-assistant",
      parentId: keptUser.id,
      role: "assistant",
      content: "kept answer",
      second: 4,
    });
    const firstReset = {
      type: "reset",
      id: "first-reset",
      parentId: keptAssistant.id,
      timestamp: "2026-07-22T00:00:05.000Z",
      reason: "new",
      firstKeptEntryId: keptUser.id,
    };

    expect(
      buildSessionResetBoundaryEvent({
        events: [oldUser, oldAssistant, keptUser, keptAssistant, firstReset],
        reason: "reset",
      }),
    ).toMatchObject({
      parentId: firstReset.id,
      firstKeptEntryId: keptUser.id,
    });
  });

  it("seeds only the bounded replay tail from a legacy transcript", async () => {
    await withTempDir({ prefix: "openclaw-reset-boundary-" }, async (dir) => {
      const sessionFile = path.join(dir, "legacy.jsonl");
      const records = Array.from({ length: 20 }, (_, index) =>
        message({
          id: `message-${index}`,
          parentId: index === 0 ? null : `message-${index - 1}`,
          role: index % 2 === 0 ? "user" : "assistant",
          content: `message ${index}`,
          second: index,
        }),
      );
      await fs.writeFile(
        sessionFile,
        `${records.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
      );

      const plan = await buildSessionResetBoundaryPlan({
        events: [],
        legacySessionFile: sessionFile,
        reason: "new",
      });

      expect(plan.seedEvents).toHaveLength(6);
      expect(plan.seedEvents.map((entry) => (entry as { id?: string }).id)).toEqual(
        records.slice(-6).map((entry) => entry.id),
      );
      expect(plan.event.firstKeptEntryId).toBe("message-14");
    });
  });
});
