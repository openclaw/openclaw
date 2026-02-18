import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadApnsRegistration,
  normalizeApnsEnvironment,
  registerApnsToken,
  resolveApnsAuthConfigFromEnv,
} from "./push-apns.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-push-apns-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
});

describe("push APNs registration store", () => {
  it("stores and reloads node APNs registration", async () => {
    const baseDir = await makeTempDir();
    const saved = await registerApnsToken({
      nodeId: "ios-node-1",
      token: "ABCD1234ABCD1234ABCD1234ABCD1234",
      topic: "ai.openclaw.ios",
      environment: "sandbox",
      baseDir,
    });

    const loaded = await loadApnsRegistration("ios-node-1", baseDir);
    expect(loaded).not.toBeNull();
    expect(loaded?.nodeId).toBe("ios-node-1");
    expect(loaded?.token).toBe("abcd1234abcd1234abcd1234abcd1234");
    expect(loaded?.topic).toBe("ai.openclaw.ios");
    expect(loaded?.environment).toBe("sandbox");
    expect(loaded?.updatedAtMs).toBe(saved.updatedAtMs);
  });

  it("rejects invalid APNs tokens", async () => {
    const baseDir = await makeTempDir();
    await expect(
      registerApnsToken({
        nodeId: "ios-node-1",
        token: "not-a-token",
        topic: "ai.openclaw.ios",
        baseDir,
      }),
    ).rejects.toThrow("invalid APNs token");
  });
});

describe("push APNs env config", () => {
  it("normalizes APNs environment values", () => {
    expect(normalizeApnsEnvironment("sandbox")).toBe("sandbox");
    expect(normalizeApnsEnvironment("PRODUCTION")).toBe("production");
    expect(normalizeApnsEnvironment("staging")).toBeNull();
  });

  it("resolves inline private key and unescapes newlines", async () => {
    const env = {
      OPENCLAW_APNS_TEAM_ID: "TEAM123",
      OPENCLAW_APNS_KEY_ID: "KEY123",
      OPENCLAW_APNS_PRIVATE_KEY_P8:
        "-----BEGIN PRIVATE KEY-----\\nline-a\\nline-b\\n-----END PRIVATE KEY-----",
    } as NodeJS.ProcessEnv;
    const resolved = await resolveApnsAuthConfigFromEnv(env);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) {
      return;
    }
    expect(resolved.value.privateKey).toContain("\nline-a\n");
    expect(resolved.value.teamId).toBe("TEAM123");
    expect(resolved.value.keyId).toBe("KEY123");
  });

  it("returns an error when required APNs auth vars are missing", async () => {
    const resolved = await resolveApnsAuthConfigFromEnv({} as NodeJS.ProcessEnv);
    expect(resolved.ok).toBe(false);
    if (resolved.ok) {
      return;
    }
    expect(resolved.error).toContain("OPENCLAW_APNS_TEAM_ID");
  });
});
