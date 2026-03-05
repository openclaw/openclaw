import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const loadConfigMock = vi.hoisted(() => vi.fn());

vi.mock("../config/config.js", () => ({
  loadConfig: loadConfigMock,
}));

const { resolveRelayAcceptedTokensForPort } = await import("./extension-relay-auth.js");

describe("extension-relay-auth SecretRef handling", () => {
  const ENV_KEYS = ["OPENCLAW_GATEWAY_TOKEN", "CLAWDBOT_GATEWAY_TOKEN", "CUSTOM_GATEWAY_TOKEN"];
  const envSnapshot = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      envSnapshot.set(key, process.env[key]);
      delete process.env[key];
    }
    loadConfigMock.mockReset();
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const previous = envSnapshot.get(key);
      if (previous === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous;
      }
    }
  });

  it("resolves env-template gateway.auth.token from its referenced env var", async () => {
    loadConfigMock.mockReturnValue({
      gateway: { auth: { token: "${CUSTOM_GATEWAY_TOKEN}" } },
      secrets: { providers: { default: { source: "env" } } },
    });
    process.env.CUSTOM_GATEWAY_TOKEN = "resolved-gateway-token";

    const tokens = await resolveRelayAcceptedTokensForPort(18790);

    expect(tokens).toContain("resolved-gateway-token");
    expect(tokens[0]).not.toBe("resolved-gateway-token");
  });

  it("fails closed when env-template gateway.auth.token is unresolved", async () => {
    loadConfigMock.mockReturnValue({
      gateway: { auth: { token: "${CUSTOM_GATEWAY_TOKEN}" } },
      secrets: { providers: { default: { source: "env" } } },
    });

    await expect(resolveRelayAcceptedTokensForPort(18790)).rejects.toThrow(
      "gateway.auth.token SecretRef is unavailable",
    );
  });

  it("resolves file-backed gateway.auth.token SecretRef", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-relay-file-secret-"));
    const secretFile = path.join(tempDir, "relay-secrets.json");
    await fs.writeFile(secretFile, JSON.stringify({ relayToken: "resolved-file-relay-token" }));
    await fs.chmod(secretFile, 0o600);

    loadConfigMock.mockReturnValue({
      secrets: {
        providers: {
          fileProvider: { source: "file", path: secretFile, mode: "json" },
        },
      },
      gateway: {
        auth: {
          token: { source: "file", provider: "fileProvider", id: "/relayToken" },
        },
      },
    });

    try {
      const tokens = await resolveRelayAcceptedTokensForPort(18790);
      expect(tokens.length).toBeGreaterThan(0);
      expect(tokens).toContain("resolved-file-relay-token");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("resolves exec-backed gateway.auth.token SecretRef", async () => {
    const execProgram = [
      "process.stdout.write(",
      "JSON.stringify({ protocolVersion: 1, values: { RELAY_TOKEN: 'resolved-exec-relay-token' } })",
      ");",
    ].join("");
    loadConfigMock.mockReturnValue({
      secrets: {
        providers: {
          execProvider: {
            source: "exec",
            command: process.execPath,
            args: ["-e", execProgram],
            allowInsecurePath: true,
          },
        },
      },
      gateway: {
        auth: {
          token: { source: "exec", provider: "execProvider", id: "RELAY_TOKEN" },
        },
      },
    });

    const tokens = await resolveRelayAcceptedTokensForPort(18790);
    expect(tokens.length).toBeGreaterThan(0);
    expect(tokens).toContain("resolved-exec-relay-token");
  });
});
