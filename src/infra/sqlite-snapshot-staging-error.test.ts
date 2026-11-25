import { expect, it } from "vitest";
import { encodeOpenClawStateWorkerError } from "../state/openclaw-state-worker-error.js";
import { classifyRetiredSqliteSnapshotRemovalError } from "./sqlite-lifecycle-errors.js";
import { deferSqliteSnapshotCleanupAfterRead } from "./sqlite-readonly-location-cleanup.js";
import { decodeSqliteSnapshotStagingError } from "./sqlite-snapshot-staging-error.js";

it.each([false, true])(
  "preserves post-retirement removal deferral across staging transport (retired: %s)",
  (retired) => {
    const directory = "/synthetic/retired-snapshot";
    const busy = Object.assign(new Error("file is still open"), {
      code: "EBUSY",
      syscall: "rmdir",
    });
    const error = retired ? classifyRetiredSqliteSnapshotRemovalError(directory, busy) : busy;
    const payload = encodeOpenClawStateWorkerError(error, { includeOrdinary: true });
    const decoded = decodeSqliteSnapshotStagingError(payload);
    expect(deferSqliteSnapshotCleanupAfterRead(decoded, directory)).toBe(retired);
  },
);
