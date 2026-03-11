import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearApnsRegistration,
  loadApnsRegistration,
  normalizeApnsEnvironment,
  registerApnsRegistration,
  registerApnsToken,
  resolveApnsAuthConfigFromEnv,
  resolveApnsRelayConfigFromEnv,
  sendApnsAlert,
  sendApnsBackgroundWake,
  shouldClearStoredApnsRegistration,
  shouldInvalidateApnsRegistration,
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

  it("rejects relay registrations that do not use production/official values", async () => {
    const baseDir = await makeTempDir();
    await expect(
      registerApnsRegistration({
        nodeId: "ios-node-relay",
        transport: "relay",
        relayHandle: "relay-handle-123",
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
        installationId: oversized,
        topic: "ai.openclaw.ios",
        environment: "production",
        distribution: "official",
        baseDir,
      }),
    ).rejects.toThrow("installationId too long");
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
        "-----BEGIN PRIVATE KEY-----\\nline-a\\nline-b\\n-----END PRIVATE KEY-----", // pragma: allowlist secret
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

  it("resolves APNs relay config from env", () => {
    const resolved = resolveApnsRelayConfigFromEnv({
      OPENCLAW_APNS_RELAY_BASE_URL: "https://relay.example.com",
      OPENCLAW_APNS_RELAY_AUTH_TOKEN: "relay-secret",
      OPENCLAW_APNS_RELAY_TIMEOUT_MS: "2500",
    } as NodeJS.ProcessEnv);
    expect(resolved).toMatchObject({
      ok: true,
      value: {
        baseUrl: "https://relay.example.com",
        authToken: "relay-secret",
        timeoutMs: 2500,
      },
    });
  });

  it("rejects insecure APNs relay http URLs by default", () => {
    const resolved = resolveApnsRelayConfigFromEnv({
      OPENCLAW_APNS_RELAY_BASE_URL: "http://relay.example.com",
      OPENCLAW_APNS_RELAY_AUTH_TOKEN: "relay-secret",
    } as NodeJS.ProcessEnv);
    expect(resolved).toMatchObject({
      ok: false,
    });
    if (resolved.ok) {
      return;
    }
    expect(resolved.error).toContain("OPENCLAW_APNS_RELAY_ALLOW_HTTP=true");
  });

  it("allows APNs relay http URLs only when explicitly enabled", () => {
    const resolved = resolveApnsRelayConfigFromEnv({
      OPENCLAW_APNS_RELAY_BASE_URL: "http://127.0.0.1:8787",
      OPENCLAW_APNS_RELAY_AUTH_TOKEN: "relay-secret",
      OPENCLAW_APNS_RELAY_ALLOW_HTTP: "true",
    } as NodeJS.ProcessEnv);
    expect(resolved).toMatchObject({
      ok: true,
      value: {
        baseUrl: "http://127.0.0.1:8787",
        authToken: "relay-secret",
        timeoutMs: 10_000,
      },
    });
  });

  it("rejects http relay URLs for non-loopback hosts even when explicitly enabled", () => {
    const resolved = resolveApnsRelayConfigFromEnv({
      OPENCLAW_APNS_RELAY_BASE_URL: "http://relay.example.com",
      OPENCLAW_APNS_RELAY_AUTH_TOKEN: "relay-secret",
      OPENCLAW_APNS_RELAY_ALLOW_HTTP: "true",
    } as NodeJS.ProcessEnv);
    expect(resolved).toMatchObject({
      ok: false,
    });
    if (resolved.ok) {
      return;
    }
    expect(resolved.error).toContain("loopback hosts");
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
      registration: {
        nodeId: "ios-node-alert",
        transport: "direct",
        token: "ABCD1234ABCD1234ABCD1234ABCD1234",
        topic: "ai.openclaw.ios",
        environment: "sandbox",
        updatedAtMs: 1,
      },
      nodeId: "ios-node-alert",
      title: "Wake",
      body: "Ping",
      auth: {
        teamId: "TEAM123",
        keyId: "KEY123",
        privateKey: testAuthPrivateKey,
      },
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
    const send = vi.fn().mockResolvedValue({
      status: 200,
      apnsId: "apns-wake-id",
      body: "",
    });

    const result = await sendApnsBackgroundWake({
      registration: {
        nodeId: "ios-node-wake",
        transport: "direct",
        token: "ABCD1234ABCD1234ABCD1234ABCD1234",
        topic: "ai.openclaw.ios",
        environment: "production",
        updatedAtMs: 1,
      },
      nodeId: "ios-node-wake",
      wakeReason: "node.invoke",
      auth: {
        teamId: "TEAM123",
        keyId: "KEY123",
        privateKey: testAuthPrivateKey,
      },
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
    const send = vi.fn().mockResolvedValue({
      status: 200,
      apnsId: "apns-wake-default-reason-id",
      body: "",
    });

    await sendApnsBackgroundWake({
      registration: {
        nodeId: "ios-node-wake-default-reason",
        transport: "direct",
        token: "ABCD1234ABCD1234ABCD1234ABCD1234",
        topic: "ai.openclaw.ios",
        environment: "sandbox",
        updatedAtMs: 1,
      },
      nodeId: "ios-node-wake-default-reason",
      auth: {
        teamId: "TEAM123",
        keyId: "KEY123",
        privateKey: testAuthPrivateKey,
      },
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

  it("routes relay-backed alert pushes through the relay sender", async () => {
    const send = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      apnsId: "relay-apns-id",
      environment: "production",
      tokenSuffix: "abcd1234",
    });

    const result = await sendApnsAlert({
      relayConfig: {
        baseUrl: "https://relay.example.com",
        authToken: "relay-secret",
        timeoutMs: 1000,
      },
      registration: {
        nodeId: "ios-node-relay",
        transport: "relay",
        relayHandle: "relay-handle-123",
        installationId: "install-123",
        topic: "ai.openclaw.ios",
        environment: "production",
        distribution: "official",
        updatedAtMs: 1,
        tokenDebugSuffix: "abcd1234",
      },
      nodeId: "ios-node-relay",
      title: "Wake",
      body: "Ping",
      relayRequestSender: send,
    });

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toMatchObject({
      relayHandle: "relay-handle-123",
      pushType: "alert",
      priority: "10",
      payload: {
        aps: {
          alert: { title: "Wake", body: "Ping" },
          sound: "default",
        },
      },
    });
    expect(result).toMatchObject({
      ok: true,
      status: 200,
      transport: "relay",
      environment: "production",
      tokenSuffix: "abcd1234",
    });
  });

  it("flags invalid device responses for registration invalidation", () => {
    expect(shouldInvalidateApnsRegistration({ status: 400, reason: "BadDeviceToken" })).toBe(true);
    expect(shouldInvalidateApnsRegistration({ status: 410, reason: "Unregistered" })).toBe(true);
    expect(shouldInvalidateApnsRegistration({ status: 429, reason: "TooManyRequests" })).toBe(
      false,
    );
  });

  it("only clears stored registrations for direct APNs failures without an override mismatch", () => {
    expect(
      shouldClearStoredApnsRegistration({
        registration: {
          nodeId: "ios-node-direct",
          transport: "direct",
          token: "ABCD1234ABCD1234ABCD1234ABCD1234",
          topic: "ai.openclaw.ios",
          environment: "sandbox",
          updatedAtMs: 1,
        },
        result: { status: 400, reason: "BadDeviceToken" },
      }),
    ).toBe(true);

    expect(
      shouldClearStoredApnsRegistration({
        registration: {
          nodeId: "ios-node-relay",
          transport: "relay",
          relayHandle: "relay-handle-123",
          installationId: "install-123",
          topic: "ai.openclaw.ios",
          environment: "production",
          distribution: "official",
          updatedAtMs: 1,
        },
        result: { status: 410, reason: "Unregistered" },
      }),
    ).toBe(false);

    expect(
      shouldClearStoredApnsRegistration({
        registration: {
          nodeId: "ios-node-direct",
          transport: "direct",
          token: "ABCD1234ABCD1234ABCD1234ABCD1234",
          topic: "ai.openclaw.ios",
          environment: "sandbox",
          updatedAtMs: 1,
        },
        result: { status: 400, reason: "BadDeviceToken" },
        overrideEnvironment: "production",
      }),
    ).toBe(false);
  });
});
