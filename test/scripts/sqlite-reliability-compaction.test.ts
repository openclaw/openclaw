import { fork } from "node:child_process";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { runVacuumInterruptionProof } from "../../scripts/lib/sqlite-reliability-compaction.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return { ...original, fork: vi.fn(original.fork) };
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

it("reports a failed compaction spawn without replacing its error or waiting for an exit", async () => {
  const root = tempDirs.make("compaction-spawn-error-");
  const missingExecutable = path.join(root, "missing-node");
  const original = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  let closed: Promise<void> | undefined;
  vi.mocked(fork).mockImplementationOnce((modulePath, args, options) => {
    // Exercise a real native spawn failure; no database worker is created.
    const child = original.fork(modulePath, args, { ...options, execPath: missingExecutable });
    // Keep native cleanup joinable even when broken code drops its error handler.
    child.once("error", () => {});
    closed = new Promise<void>((resolve) => {
      child.once("close", () => resolve());
    });
    return child;
  });
  const unexpectedRecovery = () => {
    throw new Error("A failed spawn must not begin recovery");
  };
  try {
    await expect(
      runVacuumInterruptionProof({
        env: process.env,
        expectedAutoVacuum: 0,
        expectedPayload: { bytes: 0, idSum: 0, rows: 0 },
        expectedState: { batches: 0, rows: 0, sha256: "unused" },
        readAutoVacuum: unexpectedRecovery,
        readPayload: unexpectedRecovery,
        recoverAndVerifyDatabase: unexpectedRecovery,
        target: { identity: { role: "global" }, path: path.join(root, "state.sqlite") },
      }),
    ).rejects.toMatchObject({ code: "ENOENT", path: missingExecutable });
  } finally {
    await closed;
  }
});
