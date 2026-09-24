import fs from "node:fs/promises";
import path from "node:path";
import type { Worker } from "node:worker_threads";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { readChatHistoryCliSessionImportSnapshot } from "./cli-session-history.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("projects oversized Claude messages off-thread using one worker per snapshot", async () => {
  const homeDir = tempDirs.make("openclaw-claude-snapshot-");
  const sessionId = "5b8b202c-f6bb-4046-9475-d2f15fd07530";
  const projectsDir = path.join(homeDir, ".claude", "projects", "demo-workspace");
  const record = (uuid: string, content: string) =>
    JSON.stringify({
      type: "user",
      uuid,
      timestamp: "2026-03-26T16:29:54.700Z",
      message: { role: "user", content },
    });
  const oversized = "q".repeat(2 * 1024 * 1024);
  await fs.mkdir(projectsDir, { recursive: true });
  await fs.writeFile(
    path.join(projectsDir, `${sessionId}.jsonl`),
    [
      record("oversized-user-0", oversized),
      "!".repeat(2 * 1024 * 1024),
      record("oversized-user-1", oversized),
      record("oversized-user-2", oversized),
      record("visible-after-oversized", "visible"),
    ].join("\n"),
    "utf8",
  );
  const parseSpy = vi.spyOn(JSON, "parse");
  const workers: Worker[] = [];
  const onWorker = (worker: Worker) => workers.push(worker);
  process.on("worker", onWorker);
  try {
    const messages = await readChatHistoryCliSessionImportSnapshot({
      entry: {
        sessionId: "openclaw-session",
        updatedAt: Date.now(),
        cliSessionBindings: { "claude-cli": { sessionId } },
      },
      provider: "claude-cli",
      localMessages: [],
      homeDir,
    });

    expect(messages).toHaveLength(4);
    for (let index = 0; index < 3; index++) {
      expect(messages[index]).toMatchObject({
        __openclaw: { externalId: `oversized-user-${index}` },
        content: expect.stringContaining("exceeded 1 MiB"),
      });
    }
    expect(messages[3]).toMatchObject({
      __openclaw: { externalId: "visible-after-oversized" },
      content: "visible",
    });
    expect(workers).toHaveLength(1);
    expect(workers[0]?.threadId).toBe(-1);
    expect(
      parseSpy.mock.calls.some(
        ([source]) => typeof source === "string" && source.length > 1024 * 1024,
      ),
    ).toBe(false);
  } finally {
    process.off("worker", onWorker);
    parseSpy.mockRestore();
  }
});
