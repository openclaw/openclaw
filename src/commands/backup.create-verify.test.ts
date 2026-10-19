// Backup create/verify tests cover archive creation, runtime output, and verification failure handling.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { backupCreateCommand } from "./backup.js";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

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
vi.mock("./backup-outcome.js", () => ({
  recordBackupRunOutcomeWithOwner: recordBackupRunOutcomeMock,
}));

describe("backupCreateCommand verification", () => {
  beforeEach(() => {
    createBackupArchiveMock.mockReset();
    verifyBackupArchiveMock.mockReset();
    writeRuntimeJsonMock.mockReset();
    recordBackupRunOutcomeMock.mockReset();
  });

  it("verifies the archive and settles outcome recording before reporting completion", async () => {
    createBackupArchiveMock.mockResolvedValue({
      archivePath: "/tmp/openclaw-backup.tar.gz",
      archiveRoot: "openclaw-backup",
      createdAt: "2026-04-07T00:00:00.000Z",
      runtimeVersion: "test",
      assetCount: 1,
      entryCount: 2,
      assets: [],
      skipped: [],
      skippedVolatileCount: 0,
      verified: false,
      dryRun: false,
      includeWorkspace: false,
      onlyConfig: false,
    });
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
    recordBackupRunOutcomeMock.mockRejectedValue(new Error("record failed"));
    const runtime = createTestRuntime();

    await expect(backupCreateCommand(runtime)).rejects.toBe(backupError);

    expect(runtime.error).toHaveBeenCalledWith(
      "Warning: the backup outcome could not be recorded: record failed",
    );
  });
});
