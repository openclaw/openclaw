import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loadApnsRegistration,
  normalizeApnsEnvironment,
  registerApnsToken,
  resolveApnsAuthConfigFromEnv,
  sendApnsAlert,
  sendApnsBackgroundWake,
} from "./push-apns.js";

const tempDirs: string[] = [];
const testAuthPrivateKey = generateKeyPairSync("ec", { namedCurve: "prime256v1" })
  .privateKey.export({ format: "pem", type: "pkcs8" })
  .toString();

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

describe("push APNs send semantics", () => {
  it("sends alert pushes with alert headers and payload", async () => {
    const send = vi.fn().mockResolvedValue({
      status: 200,
      apnsId: "apns-alert-id",
      body: "",
    });

    const result = await sendApnsAlert({
      auth: {
        teamId: "TEAM123",
        keyId: "KEY123",
        privateKey: testAuthPrivateKey,
      },
      registration: {
        nodeId: "ios-node-alert",
        token: "ABCD1234ABCD1234ABCD1234ABCD1234",
        topic: "ai.openclaw.ios",
        environment: "sandbox",
        updatedAtMs: 1,
      },
      nodeId: "ios-node-alert",
      title: "Wake",
      body: "Ping",
      requestSender: send,
    });

    expect(send).toHaveBeenCalledTimes(1);
    const sent = send.mock.calls[0]?.[0];
    expect(sent?.pushType).toBe("alert");
    expect(sent?.priority).toBe("10");
    expect(sent?.payload).toMatchObject({
      aps: {
        alert: { title: "Wake", body: "Ping" },
        sound: "default",
      },
      openclaw: {
        kind: "push.test",
        nodeId: "ios-node-alert",
      },
    });
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
  });

  it("sends background wake pushes with silent payload semantics", async () => {
    const send = vi.fn().mockResolvedValue({
      status: 200,
      apnsId: "apns-wake-id",
      body: "",
    });

    const result = await sendApnsBackgroundWake({
      auth: {
        teamId: "TEAM123",
        keyId: "KEY123",
        privateKey: testAuthPrivateKey,
      },
      registration: {
        nodeId: "ios-node-wake",
        token: "ABCD1234ABCD1234ABCD1234ABCD1234",
        topic: "ai.openclaw.ios",
        environment: "production",
        updatedAtMs: 1,
      },
      nodeId: "ios-node-wake",
      wakeReason: "node.invoke",
      requestSender: send,
    });

    expect(send).toHaveBeenCalledTimes(1);
    const sent = send.mock.calls[0]?.[0];
    expect(sent?.pushType).toBe("background");
    expect(sent?.priority).toBe("5");
    expect(sent?.payload).toMatchObject({
      aps: {
        "content-available": 1,
      },
      openclaw: {
        kind: "node.wake",
        reason: "node.invoke",
        nodeId: "ios-node-wake",
      },
    });
    const sentPayload = sent?.payload as { aps?: { alert?: unknown; sound?: unknown } } | undefined;
    const aps = sentPayload?.aps;
    expect(aps?.alert).toBeUndefined();
    expect(aps?.sound).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(result.environment).toBe("production");
  });
});
