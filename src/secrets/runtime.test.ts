import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureAuthProfileStore } from "../agents/auth-profiles.js";
import { loadConfig, type OpenClawConfig } from "../config/config.js";
import {
  activateSecretsRuntimeSnapshot,
  clearSecretsRuntimeSnapshot,
  prepareSecretsRuntimeSnapshot,
} from "./runtime.js";

const runExecMock = vi.hoisted(() => vi.fn());

vi.mock("../process/exec.js", () => ({
  runExec: runExecMock,
}));

describe("secrets runtime snapshot", () => {
  afterEach(() => {
    runExecMock.mockReset();
    clearSecretsRuntimeSnapshot();
  });

  it("resolves env refs for config and auth profiles", async () => {
    const config: OpenClawConfig = {
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            apiKey: { source: "env", id: "OPENAI_API_KEY" },
            models: [],
          },
        },
      },
    };

    const snapshot = await prepareSecretsRuntimeSnapshot({
      config,
      env: {
        OPENAI_API_KEY: "sk-env-openai",
        GITHUB_TOKEN: "ghp-env-token",
      },
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore: () => ({
        version: 1,
        profiles: {
          "openai:default": {
            type: "api_key",
            provider: "openai",
            key: "old-openai",
            keyRef: { source: "env", id: "OPENAI_API_KEY" },
          },
          "github-copilot:default": {
            type: "token",
            provider: "github-copilot",
            token: "old-gh",
            tokenRef: { source: "env", id: "GITHUB_TOKEN" },
          },
        },
      }),
    });

    expect(snapshot.config.models?.providers?.openai?.apiKey).toBe("sk-env-openai");
    expect(snapshot.warnings).toHaveLength(2);
    expect(snapshot.authStores[0]?.store.profiles["openai:default"]).toMatchObject({
      type: "api_key",
      key: "sk-env-openai",
    });
    expect(snapshot.authStores[0]?.store.profiles["github-copilot:default"]).toMatchObject({
      type: "token",
      token: "ghp-env-token",
    });
  });

  it("resolves file refs via sops json payload", async () => {
    runExecMock.mockResolvedValueOnce({
      stdout: JSON.stringify({
        providers: {
          openai: {
            apiKey: "sk-from-sops",
          },
        },
      }),
      stderr: "",
    });

    const config: OpenClawConfig = {
      secrets: {
        sources: {
          file: {
            type: "sops",
            path: "~/.openclaw/secrets.enc.json",
            timeoutMs: 7000,
          },
        },
      },
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            apiKey: { source: "file", id: "/providers/openai/apiKey" },
            models: [],
          },
        },
      },
    };

    const snapshot = await prepareSecretsRuntimeSnapshot({
      config,
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore: () => ({ version: 1, profiles: {} }),
    });

    expect(snapshot.config.models?.providers?.openai?.apiKey).toBe("sk-from-sops");
    expect(runExecMock).toHaveBeenCalledWith(
      "sops",
      ["--decrypt", "--output-type", "json", expect.stringContaining("secrets.enc.json")],
      {
        timeoutMs: 7000,
        maxBuffer: 10 * 1024 * 1024,
      },
    );
  });

  it("activates runtime snapshots for loadConfig and ensureAuthProfileStore", async () => {
    const prepared = await prepareSecretsRuntimeSnapshot({
      config: {
        models: {
          providers: {
            openai: {
              baseUrl: "https://api.openai.com/v1",
              apiKey: { source: "env", id: "OPENAI_API_KEY" },
              models: [],
            },
          },
        },
      },
      env: { OPENAI_API_KEY: "sk-runtime" },
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore: () => ({
        version: 1,
        profiles: {
          "openai:default": {
            type: "api_key",
            provider: "openai",
            keyRef: { source: "env", id: "OPENAI_API_KEY" },
          },
        },
      }),
    });

    activateSecretsRuntimeSnapshot(prepared);

    expect(loadConfig().models?.providers?.openai?.apiKey).toBe("sk-runtime");
    const store = ensureAuthProfileStore("/tmp/openclaw-agent-main");
    expect(store.profiles["openai:default"]).toMatchObject({
      type: "api_key",
      key: "sk-runtime",
    });
  });

  it("does not write inherited auth stores during runtime secret activation", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-secrets-runtime-"));
    const stateDir = path.join(root, ".openclaw");
    const mainAgentDir = path.join(stateDir, "agents", "main", "agent");
    const workerStorePath = path.join(stateDir, "agents", "worker", "agent", "auth-profiles.json");
    const prevStateDir = process.env.OPENCLAW_STATE_DIR;

    try {
      await fs.mkdir(mainAgentDir, { recursive: true });
      await fs.writeFile(
        path.join(mainAgentDir, "auth-profiles.json"),
        JSON.stringify({
          version: 1,
          profiles: {
            "openai:default": {
              type: "api_key",
              provider: "openai",
              keyRef: { source: "env", id: "OPENAI_API_KEY" },
            },
          },
        }),
        "utf8",
      );
      process.env.OPENCLAW_STATE_DIR = stateDir;

      await prepareSecretsRuntimeSnapshot({
        config: {
          agents: {
            list: [{ id: "worker" }],
          },
        },
        env: { OPENAI_API_KEY: "sk-runtime-worker" },
      });

      await expect(fs.access(workerStorePath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (prevStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = prevStateDir;
      }
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
