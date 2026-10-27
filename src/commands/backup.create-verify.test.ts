// Backup create/verify tests cover archive creation, runtime output, and verification failure handling.
import fsSync, { existsSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { makeBackupResult } from "../infra/backup-create.test-support.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { backupCreateCommand } from "./backup.js";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, existsSync: vi.fn(actual.existsSync) };
});

const createBackupArchiveMock = vi.hoisted(() => vi.fn());
const verifyBackupArchiveMock = vi.hoisted(() => vi.fn());
const writeRuntimeJsonMock = vi.hoisted(() => vi.fn());
const recordBackupRunOutcomeMock = vi.hoisted(() => vi.fn());

vi.mock("../infra/backup-create.js", () => ({
  createBackupArchive: createBackupArchiveMock,
}));

vi.mock("./backup-verify.js", () => ({
  verifyBackupArchive: verifyBackupArchiveMock,
}));

vi.mock("../runtime.js", async () => {
  const actual = await vi.importActual<typeof import("../runtime.js")>("../runtime.js");
  return {
    ...actual,
    writeRuntimeJson: writeRuntimeJsonMock,
  };
});

// mock-isolation: Archive settlement uses a controlled outcome; routing has real-ledger coverage.
vi.mock("../cli/local-state-owner.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../cli/local-state-owner.js")>()),
  runWithLocalStateOwner: recordBackupRunOutcomeMock,
}));

describe("backupCreateCommand verification", () => {
  beforeEach(() => {
    createBackupArchiveMock.mockReset();
    verifyBackupArchiveMock.mockReset();
    writeRuntimeJsonMock.mockReset();
    recordBackupRunOutcomeMock.mockReset();
    const databasePath = resolveOpenClawStateSqlitePath();
    vi.mocked(existsSync)
      .mockReset()
      .mockImplementation((value) => value === databasePath || fsSync.existsSync(value));
  });

  afterEach(() => vi.restoreAllMocks());

  it("formats created archives with included and skipped paths", async () => {
    createBackupArchiveMock.mockResolvedValue(
      makeBackupResult({
        verified: true,
        skippedVolatileCount: 3,
        assets: [
          {
            kind: "state",
            sourcePath: "/state",
            archivePath: "archive/state",
            displayPath: "~/.openclaw",
          },
        ],
        skipped: [
          {
            kind: "workspace",
            sourcePath: "/workspace",
            displayPath: "~/Projects/openclaw",
            reason: "covered",
            coveredBy: "~/.openclaw",
          },
        ],
      }),
    );
    const runtime = createTestRuntime();
    await backupCreateCommand(runtime);
    expect(runtime.log).toHaveBeenCalledExactlyOnceWith(
      [
        "Backup archive: /tmp/openclaw-backup.tar.gz",
        "Included 1 path:",
        "- state: ~/.openclaw",
        "Skipped 1 path:",
        "- workspace: ~/Projects/openclaw (covered by ~/.openclaw)",
        "Created /tmp/openclaw-backup.tar.gz",
        "Skipped 3 volatile files (live sessions, cron logs, queues, managed runtime paths, sockets, pid/tmp).",
        "Archive verification: passed",
      ].join("\n"),
    );
  });

  it("verifies the archive and settles outcome recording before reporting completion", async () => {
    createBackupArchiveMock.mockResolvedValue(makeBackupResult({ verified: false }));
    verifyBackupArchiveMock.mockResolvedValue({
      ok: true,
      archivePath: "/tmp/openclaw-backup.tar.gz",
    });

    const recording = createDeferred();
    const recordingStarted = createDeferred();
    recordBackupRunOutcomeMock.mockImplementationOnce(() => {
      recordingStarted.resolve();
      return recording.promise;
    });
    const runtime = createTestRuntime();
    const pending = backupCreateCommand(runtime, { verify: true });
    await recordingStarted.promise;
    expect(runtime.log).not.toHaveBeenCalled();
    recording.resolve();
    const result = await pending;
    expect(runtime.log).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("Archive verification: passed"),
    );

    expect(result.verified).toBe(true);
    expect(verifyBackupArchiveMock).toHaveBeenCalledExactlyOnceWith("/tmp/openclaw-backup.tar.gz");
  });

  it("does not claim completion when both backup and outcome recording fail", async () => {
    const backupError = new Error("snapshot failed");
    createBackupArchiveMock.mockRejectedValue(backupError);
    recordBackupRunOutcomeMock.mockRejectedValue(new Error("café\x1b[31m\nrecord failed"));
    const runtime = createTestRuntime();

    await expect(backupCreateCommand(runtime)).rejects.toBe(backupError);

    expect(runtime.error).toHaveBeenCalledWith(
      "Warning: the backup outcome could not be recorded: café\\nrecord failed",
    );
  });
});
