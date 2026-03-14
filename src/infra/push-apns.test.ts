import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearApnsRegistration,
  clearApnsRegistrationIfCurrent,
  loadApnsRegistration,
  registerApnsRegistration,
  registerApnsToken,
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

function createDirectApnsSendFixture(params: {
  nodeId: string;
  environment: "sandbox" | "production";
  sendResult: { status: number; apnsId: string; body: string };
}) {
  return {
    send: vi.fn().mockResolvedValue(params.sendResult),
    registration: {
      nodeId: params.nodeId,
      transport: "direct" as const,
      token: "ABCD1234ABCD1234ABCD1234ABCD1234",
      topic: "ai.openclaw.ios",
      environment: params.environment,
      updatedAtMs: 1,
    },
    auth: {
      teamId: "TEAM123",
      keyId: "KEY123",
      privateKey: testAuthPrivateKey,
    },
  };
}

afterEach(async () => {
  vi.unstubAllGlobals();
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
    expect(loaded?.transport).toBe("direct");
    expect(loaded && loaded.transport === "direct" ? loaded.token : null).toBe(
      "abcd1234abcd1234abcd1234abcd1234",
    );
    expect(loaded?.topic).toBe("ai.openclaw.ios");
    expect(loaded?.environment).toBe("sandbox");
    expect(loaded?.updatedAtMs).toBe(saved.updatedAtMs);
  });

  it("stores and reloads relay-backed APNs registrations without a raw token", async () => {
    const baseDir = await makeTempDir();
    const saved = await registerApnsRegistration({
      nodeId: "ios-node-relay",
      transport: "relay",
      relayHandle: "relay-handle-123",
      sendGrant: "send-grant-123",
      installationId: "install-123",
      topic: "ai.openclaw.ios",
      environment: "production",
      distribution: "official",
      tokenDebugSuffix: "abcd1234",
      baseDir,
    });

    const loaded = await loadApnsRegistration("ios-node-relay", baseDir);
    expect(saved.transport).toBe("relay");
    expect(loaded).toMatchObject({
      nodeId: "ios-node-relay",
      transport: "relay",
      relayHandle: "relay-handle-123",
      sendGrant: "send-grant-123",
      installationId: "install-123",
      topic: "ai.openclaw.ios",
      environment: "production",
      distribution: "official",
      tokenDebugSuffix: "abcd1234",
    });
    expect(loaded && "token" in loaded).toBe(false);
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

  it("rejects oversized direct APNs registration fields", async () => {
    const baseDir = await makeTempDir();
    await expect(
      registerApnsToken({
        nodeId: "n".repeat(257),
        token: "ABCD1234ABCD1234ABCD1234ABCD1234",
        topic: "ai.openclaw.ios",
        baseDir,
      }),
    ).rejects.toThrow("nodeId required");
    await expect(
      registerApnsToken({
        nodeId: "ios-node-1",
        token: "A".repeat(513),
        topic: "ai.openclaw.ios",
        baseDir,
      }),
    ).rejects.toThrow("invalid APNs token");
    await expect(
      registerApnsToken({
        nodeId: "ios-node-1",
        token: "ABCD1234ABCD1234ABCD1234ABCD1234",
        topic: "a".repeat(256),
        baseDir,
      }),
    ).rejects.toThrow("topic required");
  });

  it("rejects relay registrations that do not use production/official values", async () => {
    const baseDir = await makeTempDir();
    await expect(
      registerApnsRegistration({
        nodeId: "ios-node-relay",
        transport: "relay",
        relayHandle: "relay-handle-123",
        sendGrant: "send-grant-123",
        installationId: "install-123",
        topic: "ai.openclaw.ios",
        environment: "staging",
        distribution: "official",
        baseDir,
      }),
    ).rejects.toThrow("relay registrations must use production environment");
    await expect(
      registerApnsRegistration({
        nodeId: "ios-node-relay",
        transport: "relay",
        relayHandle: "relay-handle-123",
        sendGrant: "send-grant-123",
        installationId: "install-123",
        topic: "ai.openclaw.ios",
        environment: "production",
        distribution: "beta",
        baseDir,
      }),
    ).rejects.toThrow("relay registrations must use official distribution");
  });

  it("rejects oversized relay registration identifiers", async () => {
    const baseDir = await makeTempDir();
    const oversized = "x".repeat(257);
    await expect(
      registerApnsRegistration({
        nodeId: "ios-node-relay",
        transport: "relay",
        relayHandle: oversized,
        sendGrant: "send-grant-123",
        installationId: "install-123",
        topic: "ai.openclaw.ios",
        environment: "production",
        distribution: "official",
        baseDir,
      }),
    ).rejects.toThrow("relayHandle too long");
    await expect(
      registerApnsRegistration({
        nodeId: "ios-node-relay",
        transport: "relay",
        relayHandle: "relay-handle-123",
        sendGrant: "send-grant-123",
        installationId: oversized,
        topic: "ai.openclaw.ios",
        environment: "production",
        distribution: "official",
        baseDir,
      }),
    ).rejects.toThrow("installationId too long");
    await expect(
      registerApnsRegistration({
        nodeId: "ios-node-relay",
        transport: "relay",
        relayHandle: "relay-handle-123",
        sendGrant: "x".repeat(1025),
        installationId: "install-123",
        topic: "ai.openclaw.ios",
        environment: "production",
        distribution: "official",
        baseDir,
      }),
    ).rejects.toThrow("sendGrant too long");
  });

  it("clears registrations", async () => {
    const baseDir = await makeTempDir();
    await registerApnsToken({
      nodeId: "ios-node-1",
      token: "ABCD1234ABCD1234ABCD1234ABCD1234",
      topic: "ai.openclaw.ios",
      baseDir,
    });

    await expect(clearApnsRegistration("ios-node-1", baseDir)).resolves.toBe(true);
    await expect(loadApnsRegistration("ios-node-1", baseDir)).resolves.toBeNull();
  });

  it("only clears a registration when the stored entry still matches", async () => {
    vi.useFakeTimers();
    try {
      const baseDir = await makeTempDir();
      vi.setSystemTime(new Date("2026-03-11T00:00:00Z"));
      const stale = await registerApnsToken({
        nodeId: "ios-node-1",
        token: "ABCD1234ABCD1234ABCD1234ABCD1234",
        topic: "ai.openclaw.ios",
        environment: "sandbox",
        baseDir,
      });

      vi.setSystemTime(new Date("2026-03-11T00:00:01Z"));
      const fresh = await registerApnsToken({
        nodeId: "ios-node-1",
        token: "ABCD1234ABCD1234ABCD1234ABCD1234",
        topic: "ai.openclaw.ios",
        environment: "sandbox",
        baseDir,
      });

      await expect(
        clearApnsRegistrationIfCurrent({
          nodeId: "ios-node-1",
          registration: stale,
          baseDir,
        }),
      ).resolves.toBe(false);
      await expect(loadApnsRegistration("ios-node-1", baseDir)).resolves.toEqual(fresh);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("push APNs send semantics", () => {
  it("sends alert pushes with alert headers and payload", async () => {
    const { send, registration, auth } = createDirectApnsSendFixture({
      nodeId: "ios-node-alert",
      environment: "sandbox",
      sendResult: {
        status: 200,
        apnsId: "apns-alert-id",
        body: "",
      },
    });

    const result = await sendApnsAlert({
      registration,
      nodeId: "ios-node-alert",
      title: "Wake",
      body: "Ping",
      auth,
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
    expect(result.transport).toBe("direct");
  });

  it("sends background wake pushes with silent payload semantics", async () => {
    const { send, registration, auth } = createDirectApnsSendFixture({
      nodeId: "ios-node-wake",
      environment: "production",
      sendResult: {
        status: 200,
        apnsId: "apns-wake-id",
        body: "",
      },
    });

    const result = await sendApnsBackgroundWake({
      registration,
      nodeId: "ios-node-wake",
      wakeReason: "node.invoke",
      auth,
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
    expect(result.transport).toBe("direct");
  });

  it("defaults background wake reason when not provided", async () => {
    const { send, registration, auth } = createDirectApnsSendFixture({
      nodeId: "ios-node-wake-default-reason",
      environment: "sandbox",
      sendResult: {
        status: 200,
        apnsId: "apns-wake-default-reason-id",
        body: "",
      },
    });

    await sendApnsBackgroundWake({
      registration,
      nodeId: "ios-node-wake-default-reason",
      auth,
      requestSender: send,
    });

    const sent = send.mock.calls[0]?.[0];
    expect(sent?.payload).toMatchObject({
      openclaw: {
        kind: "node.wake",
        reason: "node.invoke",
        nodeId: "ios-node-wake-default-reason",
      },
    });
  });
});
