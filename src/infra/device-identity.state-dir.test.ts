import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  restoreStateDirEnv,
  setStateDirEnv,
  snapshotStateDirEnv,
} from "../test-helpers/state-dir-env.js";

describe("device identity state dir defaults", () => {
  let envSnapshot: ReturnType<typeof snapshotStateDirEnv>;

  beforeEach(() => {
    envSnapshot = snapshotStateDirEnv();
  });

  afterEach(() => {
    vi.resetModules();
    restoreStateDirEnv(envSnapshot);
  });

  it("writes the default identity file under OPENCLAW_STATE_DIR", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-identity-state-"));
    const stateDir = path.join(tempRoot, "state");
    setStateDirEnv(stateDir);
    vi.resetModules();

    const { loadOrCreateDeviceIdentity } = await import("./device-identity.js");
    const identity = loadOrCreateDeviceIdentity();

    try {
      const identityPath = path.join(stateDir, "identity", "device.json");
      const raw = JSON.parse(await fs.readFile(identityPath, "utf8")) as { deviceId?: string };
      expect(raw.deviceId).toBe(identity.deviceId);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });
});
