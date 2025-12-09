import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { acquireGatewayLock, GatewayLockError } from "./gateway-lock.js";

const newLockPath = () =>
  path.join(
    os.tmpdir(),
    `clawdis-gateway-lock-test-${process.pid}-${Math.random().toString(16).slice(2)}.sock`,
  );

describe("gateway-lock", () => {
  it("prevents concurrent gateway instances and releases cleanly", async () => {
    const lockPath = newLockPath();

    const release1 = await acquireGatewayLock(lockPath);
    expect(fs.existsSync(lockPath)).toBe(true);

    await expect(acquireGatewayLock(lockPath)).rejects.toBeInstanceOf(
      GatewayLockError,
    );

    await release1();
    expect(fs.existsSync(lockPath)).toBe(false);

    // After release, lock can be reacquired.
    const release2 = await acquireGatewayLock(lockPath);
    await release2();
    expect(fs.existsSync(lockPath)).toBe(false);
  });
});
