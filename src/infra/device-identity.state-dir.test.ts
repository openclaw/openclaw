import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import { loadOrCreateDeviceIdentity } from "./device-identity.js";

describe("device identity state dir defaults", () => {
  it("writes the default identity file under OPENCLAW_STATE_DIR", async () => {
    await withStateDirEnv("openclaw-identity-state-", async ({ stateDir }) => {
      const identity = loadOrCreateDeviceIdentity();
      const identityPath = path.join(stateDir, "identity", "device.json");
      const raw = JSON.parse(await fs.readFile(identityPath, "utf8")) as { deviceId?: string };
      expect(raw.deviceId).toBe(identity.deviceId);
    });
  });
});
