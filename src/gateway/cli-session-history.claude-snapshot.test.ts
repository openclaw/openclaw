import rawFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { Worker } from "node:worker_threads";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  readClaudeCliSessionMessagesAsync,
  createClaudeTextHistoryLines,
  withClaudeProjectsDir,
} from "./cli-session-history.test-support.js";
import { expectRecordFields, requireGatewayRecord } from "./test-helpers.assertions.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function readRecord(value: unknown): Record<string, unknown> {
  return requireGatewayRecord(value, "record");
}

it("reads changed Claude sources and preserves discovery precedence", async () => {
  await withClaudeProjectsDir(async ({ homeDir, sessionId, filePath }) => {
    const read = () => readClaudeCliSessionMessagesAsync({ cliSessionId: sessionId, homeDir });
    const initial = await read();
    expect(initial).toHaveLength(3);

    await fs.appendFile(
      filePath,
      `\n${createClaudeTextHistoryLines([
        { role: "user", uuid: "appended-user", content: "appended" },
      ])}`,
      "utf8",
    );
    const appended = await read();
    expect(appended).toHaveLength(4);
    expect(appended.map((message) => readRecord(message)["__openclaw"])).toContainEqual(
      expect.objectContaining({ externalId: "appended-user" }),
    );

    await fs.writeFile(
      filePath,
      createClaudeTextHistoryLines([
        { role: "assistant", uuid: "replacement-assistant", content: "replacement" },
      ]),
      "utf8",
    );
    const replaced = await read();
    expect(replaced).toHaveLength(1);
    expectRecordFields(readRecord(replaced[0])["__openclaw"], "fields", {
      externalId: "replacement-assistant",
    });

    const movedProjectDir = path.join(path.dirname(path.dirname(filePath)), "moved-workspace");
    await fs.mkdir(movedProjectDir);
    const movedFilePath = path.join(movedProjectDir, path.basename(filePath));
    await fs.rename(filePath, movedFilePath);
    expect(await read()).toEqual(replaced);

    await fs.rm(movedFilePath);
    const deleted = await read();
    expect(deleted).toEqual([]);
  });
});

it("preserves project precedence when a later matching transcript is found first", async () => {
  await withClaudeProjectsDir(async ({ homeDir, sessionId, filePath }) => {
    const projectsDir = path.dirname(path.dirname(filePath));
    const otherProjectDir = path.join(projectsDir, "other-workspace");
    await fs.mkdir(otherProjectDir);
    await fs.writeFile(
      path.join(otherProjectDir, path.basename(filePath)),
      createClaudeTextHistoryLines([
        { role: "user", uuid: "other-project-user", content: "other project" },
      ]),
    );
    const [firstPath, secondPath] = (await fs.readdir(projectsDir)).map((project) =>
      path.join(projectsDir, project, path.basename(filePath)),
    );
    await fs.writeFile(
      filePath,
      createClaudeTextHistoryLines([
        { role: "user", uuid: "original-project-user", content: "original project" },
      ]),
    );
    const releaseFirst = createDeferred();
    const foundSecond = createDeferred();
    const access = fs.access;
    const accessSpy = vi
      .spyOn(rawFs.promises, "access")
      .mockImplementation(async (candidate, mode) => {
        if (candidate === firstPath) {
          await releaseFirst.promise;
        }
        await access(candidate, mode);
        if (candidate === secondPath) {
          foundSecond.resolve();
        }
      });
    const pending = readClaudeCliSessionMessagesAsync({ cliSessionId: sessionId, homeDir });
    try {
      await Promise.race([foundSecond.promise, pending]);
      releaseFirst.resolve();
      expect(await pending).toMatchObject([
        { content: firstPath === filePath ? "original project" : "other project" },
      ]);
    } finally {
      releaseFirst.resolve();
      await pending;
      accessSpy.mockRestore();
    }
  });
});

it("projects oversized Claude messages off-thread using one worker per snapshot", async () => {
  const homeDir = tempDirs.make("openclaw-claude-snapshot-");
  const sessionId = "5b8b202c-f6bb-4046-9475-d2f15fd07530";
  const projectsDir = path.join(homeDir, ".claude", "projects", "demo-workspace");
  const record = (uuid: string, content: unknown) =>
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
      record("oversized-tool-result", [
        { type: "tool_result", tool_use_id: "tool-1", content: oversized },
      ]),
      record("visible-after-oversized", "visible"),
    ].join("\n"),
    "utf8",
  );
  const parseSpy = vi.spyOn(JSON, "parse");
  const workers: Worker[] = [];
  const onWorker = (worker: Worker) => workers.push(worker);
  process.on("worker", onWorker);
  try {
    const messages = await readClaudeCliSessionMessagesAsync({ cliSessionId: sessionId, homeDir });

    expect(messages).toHaveLength(4);
    for (let index = 0; index < 2; index++) {
      expect(messages[index]).toMatchObject({
        __openclaw: { externalId: `oversized-user-${index}` },
        content: expect.stringContaining("exceeded 1 MiB"),
      });
    }
    // A tool result must keep its shape, or the placeholder renders as a user turn.
    expect(messages[2]).toMatchObject({
      __openclaw: { externalId: "oversized-tool-result" },
      content: [
        {
          type: "tool_result",
          tool_use_id: "tool-1",
          content: expect.stringContaining("exceeded 1 MiB"),
        },
      ],
    });
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
