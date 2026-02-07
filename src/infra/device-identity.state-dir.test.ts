import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  restoreStateDirEnv,
  setStateDirEnv,
  snapshotStateDirEnv,
} from "../test-helpers/state-dir-env.js";
import { loadOrCreateDeviceIdentity } from "./device-identity.js";

describe("device identity state dir defaults", () => {
  let envSnapshot: ReturnType<typeof snapshotStateDirEnv>;

  beforeEach(() => {
    envSnapshot = snapshotStateDirEnv();
  });

  afterEach(() => {
    restoreStateDirEnv(envSnapshot);
  });

  it("writes the default identity file under OPENCLAW_STATE_DIR", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-identity-state-"));
    const stateDir = path.join(tempRoot, "state");
    setStateDirEnv(stateDir);
    const identity = loadOrCreateDeviceIdentity();

    try {
      const identityPath = path.join(stateDir, "identity", "device.json");
      const raw = JSON.parse(await fs.readFile(identityPath, "utf8")) as { deviceId?: string };
      expect(raw.deviceId).toBe(identity.deviceId);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("derives a stable identity from MASTER_KEY when identity file is missing", async () => {
    const originalMasterKey = process.env.MASTER_KEY;
    process.env.MASTER_KEY = "test-master-key";

    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-identity-state-"));
    const stateDir = path.join(tempRoot, "state");
    setStateDirEnv(stateDir);
    vi.resetModules();

    try {
      const { loadOrCreateDeviceIdentity } = await import("./device-identity.js");
      const identity1 = loadOrCreateDeviceIdentity();

      const identityPath = path.join(stateDir, "identity", "device.json");
      await fs.unlink(identityPath);

      const identity2 = loadOrCreateDeviceIdentity();
      expect(identity2.deviceId).toBe(identity1.deviceId);
      expect(identity2.publicKeyPem).toBe(identity1.publicKeyPem);
      expect(identity2.privateKeyPem).toBe(identity1.privateKeyPem);
    } finally {
      if (originalMasterKey === undefined) {
        delete process.env.MASTER_KEY;
      } else {
        process.env.MASTER_KEY = originalMasterKey;
      }
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });
});
