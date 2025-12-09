import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { acquireRelayLock, RelayLockError } from "./relay-lock.js";

const newLockPath = () =>
  path.join(
    os.tmpdir(),
    `clawdis-relay-lock-test-${process.pid}-${Math.random().toString(16).slice(2)}.sock`,
  );

describe("relay-lock", () => {
  it("prevents concurrent relay instances and releases cleanly", async () => {
    const lockPath = newLockPath();

    const release1 = await acquireRelayLock(lockPath);
    expect(fs.existsSync(lockPath)).toBe(true);

    await expect(acquireRelayLock(lockPath)).rejects.toBeInstanceOf(
      RelayLockError,
    );

    await release1();
    expect(fs.existsSync(lockPath)).toBe(false);

    // After release, lock can be reacquired.
    const release2 = await acquireRelayLock(lockPath);
    await release2();
    expect(fs.existsSync(lockPath)).toBe(false);
  });
});
