import rawFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { Worker } from "node:worker_threads";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  readChatHistoryCliSessionImportSnapshot,
  resolveChatHistoryWithCliSessionImports,
} from "./cli-session-history.js";
import {
  boundEntry,
  createClaudeTextHistoryLines,
  withClaudeProjectsDir,
} from "./cli-session-history.test-support.js";
import { expectRecordFields, requireGatewayRecord } from "./test-helpers.assertions.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function readRecord(value: unknown): Record<string, unknown> {
  return requireGatewayRecord(value, "record");
}

it("refreshes changed Claude snapshots and singleflights concurrent reads", async () => {
  await withClaudeProjectsDir(async ({ homeDir, sessionId, filePath }) => {
    const params = {
      entry: boundEntry(sessionId),
      provider: "claude-cli",
      localMessages: [],
      homeDir,
    };
    const read = async () =>
      resolveChatHistoryWithCliSessionImports({
        ...params,
        preparedImportedMessages: await readChatHistoryCliSessionImportSnapshot(params),
      });
    const streamSpy = vi.spyOn(rawFs, "createReadStream");
    const transcriptRedact = await import("../agents/transcript-redact.js");
    const redactSpy = vi.spyOn(transcriptRedact, "redactTranscriptMessage");
    const readdirSyncSpy = vi.spyOn(rawFs, "readdirSync");
    const existsSyncSpy = vi.spyOn(rawFs, "existsSync");
    const initial = await (async () => {
      try {
        const [first, second] = await Promise.all([
          readChatHistoryCliSessionImportSnapshot(params),
          readChatHistoryCliSessionImportSnapshot(params),
        ]);
        expect(second).toEqual(first);
        const secondToolBlocks = readRecord(second.at(-1)).content;
        if (!Array.isArray(secondToolBlocks)) {
          throw new Error("Expected imported tool call and result blocks");
        }
        readRecord(readRecord(secondToolBlocks[0]).arguments).command = "mutated";
        expect(first.at(-1)).toMatchObject({
          content: [{ arguments: { command: "pwd" } }, { content: "/tmp/demo" }],
        });
        expect(await readChatHistoryCliSessionImportSnapshot(params)).toEqual(first);
        expect(streamSpy).toHaveBeenCalledTimes(1);
        expect(redactSpy).toHaveBeenCalledTimes(first.length);
        // Scope this to transcript discovery; redaction may load unrelated config.
        const projectsDir = path.dirname(path.dirname(filePath));
        expect(
          readdirSyncSpy.mock.calls.filter(([directory]) => directory === projectsDir),
        ).toHaveLength(0);
        expect(existsSyncSpy).not.toHaveBeenCalledWith(filePath);
        return resolveChatHistoryWithCliSessionImports({
          ...params,
          preparedImportedMessages: first,
        });
      } finally {
        streamSpy.mockRestore();
        redactSpy.mockRestore();
        readdirSyncSpy.mockRestore();
        existsSyncSpy.mockRestore();
      }
    })();
    expect(initial.messages).toHaveLength(3);

    await fs.appendFile(
      filePath,
      `\n${createClaudeTextHistoryLines([
        { role: "user", uuid: "appended-user", content: "appended" },
      ])}`,
      "utf8",
    );
    const appended = await read();
    expect(appended.messages).toHaveLength(4);
    expect(appended.messages.map((message) => readRecord(message)["__openclaw"])).toContainEqual(
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
    expect(replaced.messages).toHaveLength(1);
    expectRecordFields(readRecord(replaced.messages[0])["__openclaw"], "fields", {
      externalId: "replacement-assistant",
    });

    const movedProjectDir = path.join(path.dirname(path.dirname(filePath)), "moved-workspace");
    await fs.mkdir(movedProjectDir);
    const movedFilePath = path.join(movedProjectDir, path.basename(filePath));
    await fs.rename(filePath, movedFilePath);
    expect(await read()).toEqual(replaced);

    await fs.rm(movedFilePath);
    const deleted = await read();
    expect(deleted).toEqual({ messages: [], imported: false, expanded: false });
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
    const pending = readChatHistoryCliSessionImportSnapshot({
      entry: boundEntry(sessionId),
      provider: "claude-cli",
      localMessages: [],
      homeDir,
    });
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

it.each(["success", "failure"] as const)(
  "shares interleaved pending Claude reads and retires them after %s",
  async (outcome) => {
    const homeDir = tempDirs.make("openclaw-claude-interleaved-");
    const projectsDir = path.join(homeDir, ".claude", "projects", "workspace");
    await fs.mkdir(projectsDir, { recursive: true });
    for (const sessionId of ["first", "second"]) {
      await fs.writeFile(
        path.join(projectsDir, `${sessionId}.jsonl`),
        JSON.stringify({
          type: "user",
          uuid: `${sessionId}-message`,
          message: { role: "user", content: `${sessionId} transcript` },
        }),
      );
    }
    const firstPath = await fs.realpath(path.join(projectsDir, "first.jsonl"));
    const secondPath = await fs.realpath(path.join(projectsDir, "second.jsonl"));
    const firstOpenStarted = createDeferred();
    const releaseFirstOpen = createDeferred();
    const createReadStream = rawFs.createReadStream;
    const stat = fs.stat;
    let firstStats = 0;
    let failFirstOpen = outcome === "failure";
    const reads: Promise<unknown[]>[] = [];
    const read = (sessionId: string) => {
      const pending = readChatHistoryCliSessionImportSnapshot({
        entry: {
          sessionId: "openclaw-session",
          updatedAt: 0,
          cliSessionBindings: { "claude-cli": { sessionId } },
        },
        provider: "claude-cli",
        localMessages: [],
        homeDir,
      });
      reads.push(pending);
      return pending;
    };
    const streamSpy = vi.spyOn(rawFs, "createReadStream").mockImplementation((file, options) => {
      if (file !== firstPath) {
        return createReadStream(file, options);
      }
      return createReadStream(file, {
        ...(typeof options === "string" ? { encoding: options } : options),
        fs: {
          open(openedPath, flags, mode, callback) {
            firstOpenStarted.resolve();
            void releaseFirstOpen.promise.then(() => {
              if (failFirstOpen) {
                callback(new Error("synthetic read failure"), -1);
              } else {
                rawFs.open(openedPath, flags, mode, callback);
              }
            });
          },
          read: rawFs.read,
          close: rawFs.close,
        },
      });
    });
    const statSpy = vi.spyOn(fs, "stat").mockImplementation(async (...args) => {
      const result = await stat(...args);
      if (args[0] === firstPath && ++firstStats === 2) {
        // The repeated read has its fingerprint before the held file can open.
        releaseFirstOpen.resolve();
      }
      return result;
    });
    try {
      const firstRead = read("first");
      await firstOpenStarted.promise;
      expect(await read("second")).toMatchObject([{ content: "second transcript" }]);
      const [first, repeated] = await Promise.all([firstRead, read("first")]);
      expect(first).toMatchObject(outcome === "success" ? [{ content: "first transcript" }] : []);
      expect(repeated).toEqual(first);
      expect(streamSpy.mock.calls.filter(([file]) => file === firstPath)).toHaveLength(1);
      if (outcome === "success") {
        requireGatewayRecord(first[0], "first snapshot message").content = "caller-only edit";
        expect(repeated).toMatchObject([{ content: "first transcript" }]);
      }
      failFirstOpen = false;
      expect(await read("first")).toMatchObject([{ content: "first transcript" }]);
      expect(streamSpy.mock.calls.filter(([file]) => file === firstPath)).toHaveLength(
        outcome === "success" ? 1 : 2,
      );
      // Completed imports still retain only the most recently requested snapshot.
      expect(await read("second")).toMatchObject([{ content: "second transcript" }]);
      expect(streamSpy.mock.calls.filter(([file]) => file === secondPath)).toHaveLength(2);
    } finally {
      releaseFirstOpen.resolve();
      await Promise.allSettled(reads);
      statSpy.mockRestore();
      streamSpy.mockRestore();
    }
  },
);

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
