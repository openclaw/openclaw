import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyLiveApiKey,
  clearLiveApiKey,
  probeLiveApiKey,
  reloadSecrets,
} from "./secret-ops-helper.js";
import { resolveAuthStorePath } from "../agents/auth-profiles/paths.js";
import type { AuthProfileStore } from "../agents/auth-profiles/types.js";

function createTempAgentDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-secret-ops-"));
}

function readAuthStore(agentDir: string): AuthProfileStore {
  return JSON.parse(fs.readFileSync(resolveAuthStorePath(agentDir), "utf8")) as AuthProfileStore;
}

describe("secret-ops-helper", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("apply-live-api-key creates the reserved jarvis-desktop profile and sets provider order", async () => {
    const agentDir = createTempAgentDir();
    tempDirs.push(agentDir);
    const callGatewayScopedMock = vi.fn().mockResolvedValue({ ok: true, warningCount: 0 });

    const result = await applyLiveApiKey(
      {
        agentId: "jarvis-desktop",
        agentDir,
        url: "ws://127.0.0.1:18789",
        value: "sk-live-secret",
      },
      {
        callGatewayScoped: callGatewayScopedMock,
        loadConfig: () => ({
          gateway: {
            mode: "local",
            port: 18789,
            tls: { enabled: false },
          },
        }),
        loadAuthProfileStoreForSecretsRuntime: (dir?: string) => readAuthStore(dir ?? agentDir),
        normalizeSecretInput: (value: unknown) => String(value).trim(),
        resolveAgentDir: () => agentDir,
        resolveApiKeyForProfile: vi.fn().mockResolvedValue({
          apiKey: "sk-live-secret",
          provider: "anthropic",
        }),
        updateAuthProfileStoreWithLock: (params: {
          agentDir?: string;
          updater: (store: AuthProfileStore) => boolean;
        }) => {
          const store = fs.existsSync(resolveAuthStorePath(agentDir))
            ? readAuthStore(agentDir)
            : { version: 1, profiles: {} };
          params.updater(store);
          fs.mkdirSync(path.dirname(resolveAuthStorePath(agentDir)), { recursive: true });
          fs.writeFileSync(resolveAuthStorePath(agentDir), JSON.stringify(store, null, 2), "utf8");
          return Promise.resolve(store);
        },
      },
    );

    const store = readAuthStore(agentDir);

    expect(result).toMatchObject({
      action: "apply-live-api-key",
      agentId: "jarvis-desktop",
      profileId: "anthropic:jarvis-desktop",
      provider: "anthropic",
      ready: true,
    });
    expect(store.profiles["anthropic:jarvis-desktop"]).toMatchObject({
      type: "api_key",
      provider: "anthropic",
      key: "sk-live-secret",
    });
    expect(store.order?.anthropic).toEqual(["anthropic:jarvis-desktop"]);
    expect(callGatewayScopedMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "secrets.reload",
      }),
    );
  });

  it("clear-live-api-key prunes reserved profile metadata", async () => {
    const agentDir = createTempAgentDir();
    tempDirs.push(agentDir);
    const authStorePath = resolveAuthStorePath(agentDir);

    fs.mkdirSync(path.dirname(authStorePath), { recursive: true });
    fs.writeFileSync(
      authStorePath,
      JSON.stringify(
        {
          version: 1,
          profiles: {
            "anthropic:jarvis-desktop": {
              type: "api_key",
              provider: "anthropic",
              key: "sk-live-secret",
            },
            "anthropic:backup": {
              type: "api_key",
              provider: "anthropic",
              key: "sk-backup",
            },
          },
          order: {
            anthropic: ["anthropic:jarvis-desktop", "anthropic:backup"],
          },
          lastGood: {
            anthropic: "anthropic:jarvis-desktop",
          },
          usageStats: {
            "anthropic:jarvis-desktop": {
              lastUsed: Date.now(),
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    await clearLiveApiKey(
      {
        agentId: "jarvis-desktop",
        agentDir,
        url: "ws://127.0.0.1:18789",
      },
      {
        callGatewayScoped: vi.fn().mockResolvedValue({ ok: true, warningCount: 0 }),
        loadConfig: () => ({
          gateway: {
            mode: "local",
            port: 18789,
            tls: { enabled: false },
          },
        }),
        loadAuthProfileStoreForSecretsRuntime: vi.fn(),
        normalizeSecretInput: (value: unknown) => String(value).trim(),
        resolveAgentDir: () => agentDir,
        resolveApiKeyForProfile: vi.fn(),
        updateAuthProfileStoreWithLock: (params: {
          agentDir?: string;
          updater: (store: AuthProfileStore) => boolean;
        }) => {
          const store = readAuthStore(agentDir);
          params.updater(store);
          fs.writeFileSync(authStorePath, JSON.stringify(store, null, 2), "utf8");
          return Promise.resolve(store);
        },
      },
    );

    const store = readAuthStore(agentDir);

    expect(store.profiles["anthropic:jarvis-desktop"]).toBeUndefined();
    expect(store.order?.anthropic).toEqual(["anthropic:backup"]);
    expect(store.lastGood).toBeUndefined();
    expect(store.usageStats).toBeUndefined();
  });

  it("probe-live-api-key delegates readiness to resolveApiKeyForProfile", async () => {
    const agentDir = createTempAgentDir();
    tempDirs.push(agentDir);
    const authStorePath = resolveAuthStorePath(agentDir);

    fs.mkdirSync(path.dirname(authStorePath), { recursive: true });
    fs.writeFileSync(
      authStorePath,
      JSON.stringify(
        {
          version: 1,
          profiles: {
            "anthropic:jarvis-desktop": {
              type: "api_key",
              provider: "anthropic",
              key: "sk-live-secret",
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const resolveApiKeyForProfileMock = vi.fn().mockResolvedValue({
      apiKey: "sk-live-secret",
      provider: "anthropic",
    });

    const result = await probeLiveApiKey(
      {
        agentId: "jarvis-desktop",
        agentDir,
      },
      {
        callGatewayScoped: vi.fn(),
        loadConfig: () => ({
          gateway: {
            mode: "local",
            port: 18789,
            tls: { enabled: false },
          },
        }),
        loadAuthProfileStoreForSecretsRuntime: (dir?: string) => readAuthStore(dir ?? agentDir),
        normalizeSecretInput: (value: unknown) => String(value).trim(),
        resolveAgentDir: () => agentDir,
        resolveApiKeyForProfile: resolveApiKeyForProfileMock,
        updateAuthProfileStoreWithLock: vi.fn(),
      },
    );

    expect(resolveApiKeyForProfileMock).toHaveBeenCalledWith(
      expect.objectContaining({
        profileId: "anthropic:jarvis-desktop",
        agentDir,
      }),
    );
    expect(result).toMatchObject({
      action: "probe-live-api-key",
      ready: true,
      profileId: "anthropic:jarvis-desktop",
    });
  });

  it("surfaces reload failures with structured errors", async () => {
    await expect(
      reloadSecrets(
        {
          agentId: "jarvis-desktop",
          url: "ws://127.0.0.1:18789",
        },
        {
          callGatewayScoped: vi.fn().mockRejectedValue(
            Object.assign(new Error("gateway unavailable"), {
              code: "gateway_unavailable",
            }),
          ),
          loadConfig: () => ({
            gateway: {
              mode: "local",
              port: 18789,
              tls: { enabled: false },
            },
          }),
          loadAuthProfileStoreForSecretsRuntime: vi.fn(),
          normalizeSecretInput: (value: unknown) => String(value).trim(),
          resolveAgentDir: () => "unused",
          resolveApiKeyForProfile: vi.fn(),
          updateAuthProfileStoreWithLock: vi.fn(),
        },
      ),
    ).rejects.toMatchObject({
      code: "gateway_unavailable",
      message: "gateway unavailable",
    });
  });
});
