import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_READY_TIMEOUT_MS,
  DEFAULT_SMOKE_TIMEOUT_MS,
  FULL_LOCAL_SERVICES,
  FULL_LOCAL_MOUNT_REPAIR_SERVICES,
  FULL_LOCAL_START_SERVICES,
  buildMountPermissionRepairArgs,
  buildMountPermissionRepairScript,
  buildComposeArgs,
  buildFullLocalContainerConfig,
  buildFullLocalMemorySeedScript,
  buildUpArgs,
  chooseSentinelPort,
  deriveFullLocalRuntime,
  dockerCommandShouldRetry,
  evaluateAgentOsGoldenE2E,
  evaluateProof,
  evaluateSentinelModelProof,
  fetchJsonWithRetries,
  filterStaleFullLocalSmokeTickets,
  parseComposePublishedPort,
  parseComposePsJson,
  parseNvidiaPoolKeys,
  resolveFullLocalNativeAgentIds,
  resolveOpenClawConfigPath,
  resolveWindowsNativeNodePidPath,
  resolveMemoryWikiCommandTimeoutMs,
  seedNvidiaVaultFromRuntime,
  stopWindowsNativeNode,
  validateFullLocalRuntime,
  wikiSummaryReady,
} from "../../scripts/docker/full-local.mjs";

describe("scripts/docker/full-local", () => {
  it("resolves the default config from OPENCLAW_STATE_DIR when set", () => {
    const cwd = path.resolve("repo-root");
    const homeDir = path.resolve("home");

    expect(
      resolveOpenClawConfigPath(
        {
          OPENCLAW_STATE_DIR: "state",
        },
        homeDir,
        cwd,
      ),
    ).toBe(path.join(cwd, "state", "openclaw.json"));
  });

  it("parses NVIDIA key pools without pinning to the first key", () => {
    expect(parseNvidiaPoolKeys("pool-key-a, pool-key-b\npool-key-a")).toEqual([
      "pool-key-a",
      "pool-key-b",
    ]);
  });

  it("seeds the Sentinel NVIDIA vault once and preserves quarantined removals", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "openclaw-repo-"));
    const homeDir = mkdtempSync(path.join(tmpdir(), "openclaw-full-local-"));
    const localAgentsDir = path.join(cwd, ".agents");
    try {
      mkdirSync(localAgentsDir, { recursive: true });
      const runtime = await deriveFullLocalRuntime({
        config: {
          gateway: { auth: { token: "gateway-secret" } },
        },
        cwd,
        env: {
          NVIDIA_API_KEYS: "pool-key-a,pool-key-b",
          OPENCLAW_LOCAL_AGENTS_DIR: localAgentsDir,
          OPENCLAW_SENTINEL_TOKEN: "sentinel-secret",
        },
        homeDir,
        portAvailable: async () => true,
        writeContainerConfigOverlay: true,
      });
      const vaultPath = runtime.facts.nvidiaVaultPathHost;

      const firstSeed = seedNvidiaVaultFromRuntime(runtime);
      expect(firstSeed).toMatchObject({ keyCount: 2, reason: "seeded", seeded: true });
      expect(JSON.parse(readFileSync(vaultPath, "utf8")).keys).toEqual([
        "pool-key-a",
        "pool-key-b",
      ]);

      writeFileSync(vaultPath, JSON.stringify({ keys: ["pool-key-b"], version: "1.0" }));
      const existingVault = seedNvidiaVaultFromRuntime(runtime);
      expect(existingVault).toMatchObject({
        keyCount: 1,
        reason: "vault-has-keys",
        seeded: false,
      });
      expect(JSON.parse(readFileSync(vaultPath, "utf8")).keys).toEqual(["pool-key-b"]);

      writeFileSync(vaultPath, JSON.stringify({ keys: [], version: "1.0" }));
      const emptyAfterQuarantine = seedNvidiaVaultFromRuntime(runtime);
      expect(emptyAfterQuarantine).toMatchObject({
        keyCount: 0,
        reason: "already-seeded",
        seeded: false,
      });
      expect(JSON.parse(readFileSync(vaultPath, "utf8")).keys).toEqual([]);
    } finally {
      rmSync(cwd, { force: true, recursive: true });
      rmSync(homeDir, { force: true, recursive: true });
    }
  });

  it("repairs a malformed Sentinel NVIDIA vault when a seed pool is available", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "openclaw-repo-"));
    const homeDir = mkdtempSync(path.join(tmpdir(), "openclaw-full-local-"));
    const localAgentsDir = path.join(cwd, ".agents");
    try {
      mkdirSync(localAgentsDir, { recursive: true });
      const runtime = await deriveFullLocalRuntime({
        config: {
          gateway: { auth: { token: "gateway-secret" } },
        },
        cwd,
        env: {
          NVIDIA_API_KEYS: "pool-key-a,pool-key-b",
          OPENCLAW_LOCAL_AGENTS_DIR: localAgentsDir,
          OPENCLAW_SENTINEL_TOKEN: "sentinel-secret",
        },
        homeDir,
        portAvailable: async () => true,
        writeContainerConfigOverlay: true,
      });
      const vaultPath = runtime.facts.nvidiaVaultPathHost;
      mkdirSync(path.dirname(vaultPath), { recursive: true });
      writeFileSync(vaultPath, "{ invalid vault json\n");

      const seed = seedNvidiaVaultFromRuntime(runtime);
      expect(seed).toMatchObject({
        keyCount: 2,
        reason: "repaired-malformed-vault",
        seeded: true,
      });
      expect(JSON.parse(readFileSync(vaultPath, "utf8")).keys).toEqual([
        "pool-key-a",
        "pool-key-b",
      ]);
    } finally {
      rmSync(cwd, { force: true, recursive: true });
      rmSync(homeDir, { force: true, recursive: true });
    }
  });

  it("honors the Sentinel reseed flag when replacing an existing NVIDIA vault", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "openclaw-repo-"));
    const homeDir = mkdtempSync(path.join(tmpdir(), "openclaw-full-local-"));
    const localAgentsDir = path.join(cwd, ".agents");
    try {
      mkdirSync(localAgentsDir, { recursive: true });
      const runtime = await deriveFullLocalRuntime({
        config: {
          gateway: { auth: { token: "gateway-secret" } },
        },
        cwd,
        env: {
          NVIDIA_API_KEYS: "pool-key-new-a,pool-key-new-b",
          OPENCLAW_LOCAL_AGENTS_DIR: localAgentsDir,
          OPENCLAW_SENTINEL_RESEED_NVIDIA_VAULT: "1",
          OPENCLAW_SENTINEL_TOKEN: "sentinel-secret",
        },
        homeDir,
        portAvailable: async () => true,
        writeContainerConfigOverlay: true,
      });
      const vaultPath = runtime.facts.nvidiaVaultPathHost;
      mkdirSync(path.dirname(vaultPath), { recursive: true });
      writeFileSync(vaultPath, JSON.stringify({ keys: ["old-key"], version: "1.0" }));
      writeFileSync(
        `${vaultPath}.seeded-by-full-local`,
        JSON.stringify({ keyCount: 1, source: "test" }),
      );

      const seed = seedNvidiaVaultFromRuntime(runtime);
      expect(seed).toMatchObject({ keyCount: 2, reason: "forced", seeded: true });
      expect(JSON.parse(readFileSync(vaultPath, "utf8")).keys).toEqual([
        "pool-key-new-a",
        "pool-key-new-b",
      ]);
    } finally {
      rmSync(cwd, { force: true, recursive: true });
      rmSync(homeDir, { force: true, recursive: true });
    }
  });

  it("derives full-local compose environment from OpenClaw config without inventing tokens", async () => {
    const cwd = path.resolve("repo-root");
    const homeDir = path.resolve("home");
    const runtime = await deriveFullLocalRuntime({
      config: {
        gateway: { auth: { token: "gateway-secret" } },
        models: { providers: { nvidia: { apiKey: "nvidia-secret" } } },
      },
      cwd,
      env: {
        OPENCLAW_CONFIG_DIR: "state",
        OPENCLAW_WORKSPACE_DIR: "workspace",
      },
      homeDir,
      portAvailable: async (port: number) => port !== 18888,
    });

    expect(runtime.env.OPENCLAW_GATEWAY_TOKEN).toBe("gateway-secret");
    expect(runtime.env.OPENCLAW_GATEWAY_PASSWORD).toBeUndefined();
    expect(runtime.env.OPENCLAW_SENTINEL_TOKEN).toBe("nvidia-secret");
    expect(runtime.env.NVIDIA_API_KEY).toBe("nvidia-secret");
    expect(runtime.env.OPENCLAW_SENTINEL_PORT).toBe("18889");
    expect(runtime.env.OPENCLAW_NVIDIA_VAULT_PATH).toBe(
      "/home/node/.openclaw/workspace_nvidia_key_sentinel/vault.json",
    );
    expect(runtime.env.OPENCLAW_MEMORY_WIKI_GATEWAY_TIMEOUT_MS).toBe("300000");
    expect(runtime.env.OPENCLAW_ALLOW_INSECURE_PRIVATE_WS).toBe("1");
    expect(runtime.env.SWARM_BLACKBOARD_BUSY_TIMEOUT_MS).toBe("10000");
    expect(runtime.env.SWARM_BLACKBOARD_JOURNAL_MODE).toBe("DELETE");
    expect(runtime.facts.gatewayAuthConfigured).toBe(true);
    expect(runtime.facts.gatewayPasswordConfigured).toBe(false);
    expect(runtime.facts.gatewayTokenConfigured).toBe(true);
    expect(runtime.facts.sentinelTokenConfigured).toBe(true);
    expect(runtime.facts.nvidiaProviderUsesSentinel).toBe(false);
  });

  it("falls back from non-durable Blackboard journal modes", async () => {
    const runtime = await deriveFullLocalRuntime({
      config: {
        gateway: { auth: { token: "gateway-secret" } },
        models: { providers: { nvidia: { apiKey: "nvidia-secret" } } },
      },
      cwd: path.resolve("repo-root"),
      env: {
        OPENCLAW_CONFIG_DIR: "state",
        OPENCLAW_WORKSPACE_DIR: "workspace",
        SWARM_BLACKBOARD_JOURNAL_MODE: "off",
      },
      homeDir: path.resolve("home"),
      portAvailable: async () => true,
    });

    expect(runtime.env.SWARM_BLACKBOARD_JOURNAL_MODE).toBe("DELETE");
  });

  it("accepts password-authenticated Gateway configs for full-local startup", async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "openclaw-full-local-"));
    const localAgentsDir = mkdtempSync(path.join(tmpdir(), "openclaw-agents-"));
    try {
      const runtime = await deriveFullLocalRuntime({
        config: {
          gateway: { auth: { mode: "password", password: "gateway-password" } },
          models: { providers: { nvidia: { apiKey: "nvidia-secret" } } },
        },
        cwd: path.resolve("repo-root"),
        env: { OPENCLAW_LOCAL_AGENTS_DIR: localAgentsDir },
        homeDir,
        portAvailable: async () => true,
        writeContainerConfigOverlay: true,
      });
      const overlay = JSON.parse(readFileSync(runtime.facts.containerConfigPathHost, "utf8")) as {
        gateway: { auth: { password?: string; token?: string } };
      };

      expect(runtime.env.OPENCLAW_GATEWAY_PASSWORD).toBe("gateway-password");
      expect(runtime.env.OPENCLAW_GATEWAY_TOKEN).toBe("");
      expect(runtime.facts.gatewayAuthConfigured).toBe(true);
      expect(runtime.facts.gatewayPasswordConfigured).toBe(true);
      expect(runtime.facts.gatewayTokenConfigured).toBe(false);
      expect(validateFullLocalRuntime(runtime.facts, runtime.env)).toEqual([]);
      expect(overlay.gateway.auth.password).toBe("gateway-password");
      expect(overlay.gateway.auth.token).toBeUndefined();
    } finally {
      rmSync(homeDir, { force: true, recursive: true });
      rmSync(localAgentsDir, { force: true, recursive: true });
    }
  });

  it("hydrates full-local credentials from the repo dotenv file before validation", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "openclaw-repo-"));
    const homeDir = mkdtempSync(path.join(tmpdir(), "openclaw-full-local-"));
    const localAgentsDir = path.join(cwd, ".agents");
    try {
      mkdirSync(localAgentsDir, { recursive: true });
      writeFileSync(
        path.join(cwd, ".env"),
        [
          "OPENCLAW_GATEWAY_PASSWORD=dotenv-gateway-password",
          "NVIDIA_API_KEY=dotenv-nvidia-key",
          "",
        ].join("\n"),
      );

      const runtime = await deriveFullLocalRuntime({
        config: {
          gateway: { auth: { mode: "password" } },
        },
        cwd,
        env: {
          OPENCLAW_LOCAL_AGENTS_DIR: localAgentsDir,
        },
        homeDir,
        portAvailable: async () => true,
        writeContainerConfigOverlay: true,
      });

      expect(runtime.env.OPENCLAW_GATEWAY_PASSWORD).toBe("dotenv-gateway-password");
      expect(runtime.env.NVIDIA_API_KEY).toBe("dotenv-nvidia-key");
      expect(runtime.env.OPENCLAW_SENTINEL_TOKEN).toBe("dotenv-nvidia-key");
      expect(validateFullLocalRuntime(runtime.facts, runtime.env)).toEqual([]);
    } finally {
      rmSync(cwd, { force: true, recursive: true });
      rmSync(homeDir, { force: true, recursive: true });
    }
  });

  it("hydrates full-local credentials from the durable gateway dotenv fallback", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "openclaw-repo-"));
    const homeDir = mkdtempSync(path.join(tmpdir(), "openclaw-full-local-"));
    const localAgentsDir = path.join(cwd, ".agents");
    try {
      mkdirSync(localAgentsDir, { recursive: true });
      mkdirSync(path.join(homeDir, ".config", "openclaw"), { recursive: true });
      writeFileSync(
        path.join(cwd, ".env"),
        ["OPENCLAW_GATEWAY_PASSWORD=", "OPENCLAW_SENTINEL_TOKEN=", "NVIDIA_API_KEYS=", ""].join(
          "\n",
        ),
      );
      writeFileSync(
        path.join(homeDir, ".config", "openclaw", "gateway.env"),
        [
          "OPENCLAW_GATEWAY_PASSWORD=gateway-env-password",
          "OPENCLAW_SENTINEL_TOKEN=sentinel-token",
          "NVIDIA_API_KEYS=pool-key-a,pool-key-b",
          "",
        ].join("\n"),
      );

      const runtime = await deriveFullLocalRuntime({
        config: {
          gateway: { auth: { mode: "password" } },
        },
        cwd,
        env: {
          OPENCLAW_LOCAL_AGENTS_DIR: localAgentsDir,
        },
        homeDir,
        portAvailable: async () => true,
        writeContainerConfigOverlay: true,
      });

      expect(runtime.env.OPENCLAW_GATEWAY_PASSWORD).toBe("gateway-env-password");
      expect(runtime.env.OPENCLAW_SENTINEL_TOKEN).toBe("sentinel-token");
      expect(runtime.env.NVIDIA_API_KEYS).toBe("pool-key-a,pool-key-b");
      expect(runtime.env.OPENCLAW_SIGNAL_HUB_NVIDIA_API_KEYS).toBe("pool-key-a,pool-key-b");
      expect(runtime.env.OPENCLAW_SIGNAL_HUB_NVIDIA_API_KEY).toBeUndefined();
      expect(validateFullLocalRuntime(runtime.facts, runtime.env)).toEqual([]);
    } finally {
      rmSync(cwd, { force: true, recursive: true });
      rmSync(homeDir, { force: true, recursive: true });
    }
  });

  it("does not hydrate default gateway dotenv credentials for custom config dirs", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "openclaw-repo-"));
    const homeDir = mkdtempSync(path.join(tmpdir(), "openclaw-full-local-"));
    const customConfigDir = path.join(homeDir, "profiles", "work");
    const localAgentsDir = path.join(cwd, ".agents");
    try {
      mkdirSync(localAgentsDir, { recursive: true });
      mkdirSync(path.join(homeDir, ".config", "openclaw"), { recursive: true });
      mkdirSync(customConfigDir, { recursive: true });
      writeFileSync(
        path.join(homeDir, ".config", "openclaw", "gateway.env"),
        [
          "OPENCLAW_GATEWAY_TOKEN=default-profile-token",
          "NVIDIA_API_KEY=default-profile-nvidia",
          "",
        ].join("\n"),
      );

      const runtime = await deriveFullLocalRuntime({
        config: {
          gateway: { auth: { token: "custom-config-token" } },
          models: { providers: { nvidia: { apiKey: "custom-config-nvidia" } } },
        },
        cwd,
        env: {
          OPENCLAW_CONFIG_DIR: customConfigDir,
          OPENCLAW_LOCAL_AGENTS_DIR: localAgentsDir,
        },
        homeDir,
        portAvailable: async () => true,
        writeContainerConfigOverlay: true,
      });

      expect(runtime.env.OPENCLAW_CONFIG_DIR).toBe(customConfigDir);
      expect(runtime.env.OPENCLAW_GATEWAY_TOKEN).toBe("custom-config-token");
      expect(runtime.env.NVIDIA_API_KEY).toBe("custom-config-nvidia");
      expect(runtime.env.OPENCLAW_SENTINEL_TOKEN).toBe("custom-config-nvidia");
    } finally {
      rmSync(cwd, { force: true, recursive: true });
      rmSync(homeDir, { force: true, recursive: true });
    }
  });

  it("hydrates durable gateway dotenv credentials from the effective OpenClaw home", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "openclaw-repo-"));
    const homeDir = mkdtempSync(path.join(tmpdir(), "openclaw-full-local-"));
    const openclawHome = mkdtempSync(path.join(tmpdir(), "openclaw-home-"));
    const localAgentsDir = path.join(cwd, ".agents");
    try {
      mkdirSync(localAgentsDir, { recursive: true });
      mkdirSync(path.join(openclawHome, ".config", "openclaw"), { recursive: true });
      writeFileSync(
        path.join(openclawHome, ".config", "openclaw", "gateway.env"),
        [
          "OPENCLAW_GATEWAY_PASSWORD=gateway-env-password",
          "OPENCLAW_SENTINEL_TOKEN=sentinel-token",
          "NVIDIA_API_KEYS=pool-key-a,pool-key-b",
          "",
        ].join("\n"),
      );

      const runtime = await deriveFullLocalRuntime({
        config: {
          gateway: { auth: { mode: "password" } },
        },
        cwd,
        env: {
          OPENCLAW_HOME: openclawHome,
          OPENCLAW_LOCAL_AGENTS_DIR: localAgentsDir,
        },
        homeDir,
        portAvailable: async () => true,
        writeContainerConfigOverlay: true,
      });

      expect(runtime.env.OPENCLAW_CONFIG_DIR).toBe(path.join(openclawHome, ".openclaw"));
      expect(runtime.env.OPENCLAW_GATEWAY_PASSWORD).toBe("gateway-env-password");
      expect(runtime.env.OPENCLAW_SENTINEL_TOKEN).toBe("sentinel-token");
      expect(runtime.env.OPENCLAW_SIGNAL_HUB_NVIDIA_API_KEYS).toBe("pool-key-a,pool-key-b");
      expect(runtime.env.OPENCLAW_SIGNAL_HUB_NVIDIA_API_KEY).toBeUndefined();
      expect(validateFullLocalRuntime(runtime.facts, runtime.env)).toEqual([]);
    } finally {
      rmSync(cwd, { force: true, recursive: true });
      rmSync(homeDir, { force: true, recursive: true });
      rmSync(openclawHome, { force: true, recursive: true });
    }
  });

  it("prefers explicit Sentinel and NVIDIA env over config fallbacks", async () => {
    const runtime = await deriveFullLocalRuntime({
      config: {
        gateway: { auth: { token: "gateway-secret" } },
        models: { providers: { nvidia: { apiKey: "config-nvidia" } } },
      },
      cwd: path.resolve("repo-root"),
      env: {
        NVIDIA_API_KEY: "env-nvidia",
        OPENCLAW_SENTINEL_PORT: "19888",
        OPENCLAW_SENTINEL_TOKEN: "sentinel-secret",
      },
      homeDir: path.resolve("home"),
      portAvailable: async () => {
        throw new Error("explicit port should skip probing");
      },
    });

    expect(runtime.env.NVIDIA_API_KEY).toBe("env-nvidia");
    expect(runtime.env.OPENCLAW_SENTINEL_TOKEN).toBe("sentinel-secret");
    expect(runtime.env.OPENCLAW_SENTINEL_PORT).toBe("19888");
  });

  it("fails fast when no automatic Sentinel host ports are available", async () => {
    await expect(chooseSentinelPort({}, async () => false)).rejects.toThrow(
      "No available Sentinel port found in 18888-18907",
    );
  });

  it("probes Sentinel host ports on Docker publish and loopback interfaces", async () => {
    const probedHosts: string[] = [];
    const selectedPort = await chooseSentinelPort({}, async (port, host) => {
      probedHosts.push(host);
      return port === 18889;
    });

    expect(selectedPort).toBe("18889");
    expect(probedHosts).toEqual(["0.0.0.0", "0.0.0.0", "127.0.0.1"]);
  });

  it("skips Sentinel ports already occupied on loopback even when Docker can publish", async () => {
    const selectedPort = await chooseSentinelPort({}, async (port, host) => {
      if (port === 18888 && host === "0.0.0.0") {
        return true;
      }
      if (port === 18888 && host === "127.0.0.1") {
        return false;
      }
      return port === 18889;
    });

    expect(selectedPort).toBe("18889");
  });

  it("rejects invalid explicit Sentinel publish ports before compose startup", async () => {
    await expect(
      chooseSentinelPort({ OPENCLAW_SENTINEL_PORT: "18888/tcp" }, async () => true),
    ).rejects.toThrow("OPENCLAW_SENTINEL_PORT must be a TCP port number from 1 to 65535");
    await expect(
      chooseSentinelPort({ OPENCLAW_SENTINEL_PORT: "99999" }, async () => true),
    ).rejects.toThrow("OPENCLAW_SENTINEL_PORT must be a TCP port number from 1 to 65535");
  });

  it("rejects invalid Sentinel listen ports before writing full-local config", async () => {
    await expect(
      deriveFullLocalRuntime({
        config: {
          gateway: { auth: { token: "gateway-secret" } },
          models: { providers: { nvidia: { apiKey: "nvidia-secret" } } },
        },
        cwd: path.resolve("repo-root"),
        env: {
          OPENCLAW_SENTINEL_LISTEN_PORT: "0",
        },
        homeDir: path.resolve("home"),
        portAvailable: async () => true,
      }),
    ).rejects.toThrow("OPENCLAW_SENTINEL_LISTEN_PORT must be a TCP port number from 1 to 65535");

    await expect(
      deriveFullLocalRuntime({
        config: {
          gateway: { auth: { token: "gateway-secret" } },
          models: { providers: { nvidia: { apiKey: "nvidia-secret" } } },
        },
        cwd: path.resolve("repo-root"),
        env: {
          OPENCLAW_SENTINEL_LISTEN_PORT: "not-a-port",
        },
        homeDir: path.resolve("home"),
        portAvailable: async () => true,
      }),
    ).rejects.toThrow("OPENCLAW_SENTINEL_LISTEN_PORT must be a TCP port number from 1 to 65535");
  });

  it("keeps an explicit config file path separate from the full-local state mount", async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "openclaw-full-local-"));
    try {
      const customConfigRoot = path.resolve("etc");
      const customConfigPath = path.join(customConfigRoot, "openclaw.json");
      const runtime = await deriveFullLocalRuntime({
        config: {
          agents: {
            list: [
              {
                agentDir: path.join(customConfigRoot, "agents", "main", "agent"),
                id: "main",
                workspace: path.join(customConfigRoot, "workspace-main"),
              },
            ],
          },
          gateway: { auth: { token: "gateway-secret" } },
          models: { providers: { nvidia: { apiKey: "nvidia-secret" } } },
        },
        cwd: path.resolve("repo-root"),
        env: {
          OPENCLAW_CONFIG_PATH: customConfigPath,
        },
        homeDir,
        portAvailable: async () => true,
        writeContainerConfigOverlay: true,
      });

      expect(runtime.facts.configPath).toBe(customConfigPath);
      expect(runtime.env.OPENCLAW_CONFIG_DIR).toBe(path.join(homeDir, ".openclaw"));
      expect(runtime.env.OPENCLAW_STATE_DIR).toBe(path.join(homeDir, ".openclaw"));
      expect(runtime.facts.nvidiaVaultPathHost).toBe(
        path.join(homeDir, ".openclaw", "workspace_nvidia_key_sentinel", "vault.json"),
      );
      expect(runtime.env.OPENCLAW_CONFIG_SOURCE_DIR).toBe(customConfigRoot);
      expect(runtime.env.OPENCLAW_EXTRA_AGENT_ROOT_DIR).toBe(customConfigRoot);
      const overlay = JSON.parse(readFileSync(runtime.facts.containerConfigPathHost, "utf8")) as {
        agents: { list: Array<{ agentDir: string; workspace: string }> };
      };
      expect(overlay.agents.list[0]?.agentDir).toBe(
        "/home/node/openclaw-extra-agent-root/agents/main/agent",
      );
      expect(overlay.agents.list[0]?.workspace).toBe(
        "/home/node/openclaw-extra-agent-root/workspace-main",
      );
    } finally {
      rmSync(homeDir, { force: true, recursive: true });
    }
  });

  it("maps a custom Sentinel vault path back to the mounted state directory", async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "openclaw-full-local-"));
    try {
      const runtime = await deriveFullLocalRuntime({
        config: {
          gateway: { auth: { token: "gateway-secret" } },
          models: { providers: { nvidia: { apiKey: "nvidia-secret" } } },
        },
        cwd: path.resolve("repo-root"),
        env: {
          OPENCLAW_FULL_LOCAL_NVIDIA_VAULT_PATH: "/home/node/.openclaw/custom-sentinel/vault.json",
        },
        homeDir,
        portAvailable: async () => true,
      });

      expect(runtime.env.OPENCLAW_NVIDIA_VAULT_PATH).toBe(
        "/home/node/.openclaw/custom-sentinel/vault.json",
      );
      expect(runtime.facts.nvidiaVaultPathHost).toBe(
        path.join(homeDir, ".openclaw", "custom-sentinel", "vault.json"),
      );
    } finally {
      rmSync(homeDir, { force: true, recursive: true });
    }
  });

  it("rejects custom Sentinel vault paths outside mounted container roots", async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "openclaw-full-local-"));
    try {
      await expect(
        deriveFullLocalRuntime({
          config: {
            gateway: { auth: { token: "gateway-secret" } },
            models: { providers: { nvidia: { apiKey: "nvidia-secret" } } },
          },
          cwd: path.resolve("repo-root"),
          env: {
            OPENCLAW_FULL_LOCAL_NVIDIA_VAULT_PATH: "/tmp/sentinel/vault.json",
          },
          homeDir,
          portAvailable: async () => true,
        }),
      ).rejects.toThrow(
        "OPENCLAW_FULL_LOCAL_NVIDIA_VAULT_PATH must point inside a writable full-local mounted container path",
      );
    } finally {
      rmSync(homeDir, { force: true, recursive: true });
    }
  });

  it("rejects custom Sentinel vault paths under the read-only config source mount", async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "openclaw-full-local-"));
    try {
      await expect(
        deriveFullLocalRuntime({
          config: {
            gateway: { auth: { token: "gateway-secret" } },
            models: { providers: { nvidia: { apiKey: "nvidia-secret" } } },
          },
          cwd: path.resolve("repo-root"),
          env: {
            OPENCLAW_CONFIG_PATH: path.join(homeDir, "config-source", "openclaw.json"),
            OPENCLAW_FULL_LOCAL_NVIDIA_VAULT_PATH: "/home/node/openclaw-source-config/vault.json",
          },
          homeDir,
          portAvailable: async () => true,
        }),
      ).rejects.toThrow(
        "OPENCLAW_FULL_LOCAL_NVIDIA_VAULT_PATH must point inside a writable full-local mounted container path",
      );
    } finally {
      rmSync(homeDir, { force: true, recursive: true });
    }
  });

  it("maps host paths under /home/node through extra roots", async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "openclaw-full-local-"));
    try {
      const hostWorkspace = path.resolve("/home/node/projects/main");
      const runtime = await deriveFullLocalRuntime({
        config: {
          agents: {
            list: [
              {
                id: "main",
                workspace: "/home/node/projects/main",
              },
            ],
          },
          gateway: { auth: { token: "gateway-secret" } },
          models: { providers: { nvidia: { apiKey: "nvidia-secret" } } },
        },
        cwd: path.resolve("repo-root"),
        env: {},
        homeDir,
        portAvailable: async () => true,
        writeContainerConfigOverlay: true,
      });
      const overlay = JSON.parse(readFileSync(runtime.facts.containerConfigPathHost, "utf8")) as {
        agents: { list: Array<{ workspace: string }> };
      };

      expect(runtime.env.OPENCLAW_EXTRA_AGENT_ROOT_DIR).toBe(hostWorkspace);
      expect(overlay.agents.list[0]?.workspace).toBe("/home/node/openclaw-extra-agent-root");
    } finally {
      rmSync(homeDir, { force: true, recursive: true });
    }
  });

  it("points raw out-of-tree configs at a writable mounted root", async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "openclaw-full-local-"));
    try {
      const customConfigRoot = path.resolve("etc");
      const customConfigPath = path.join(customConfigRoot, "openclaw.json");
      const runtime = await deriveFullLocalRuntime({
        config: {
          gateway: { auth: { token: "gateway-secret" } },
          models: { providers: { nvidia: { apiKey: "nvidia-secret" } } },
        },
        cwd: path.resolve("repo-root"),
        env: {
          OPENCLAW_CONFIG_PATH: customConfigPath,
          OPENCLAW_FULL_LOCAL_USE_RAW_CONFIG: "1",
        },
        homeDir,
        portAvailable: async () => true,
        writeContainerConfigOverlay: true,
      });

      expect(runtime.facts.containerConfigOverlay).toBe(false);
      expect(runtime.facts.containerConfigPath).toBe(
        "/home/node/openclaw-extra-agent-root/openclaw.json",
      );
      expect(runtime.env.OPENCLAW_EXTRA_AGENT_ROOT_DIR).toBe(customConfigRoot);
    } finally {
      rmSync(homeDir, { force: true, recursive: true });
    }
  });

  it("writes custom container config overlays under mounted container roots", async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "openclaw-full-local-"));
    const extraRoot = path.join(homeDir, "mounted-config-root");
    try {
      const runtime = await deriveFullLocalRuntime({
        config: {
          gateway: { auth: { token: "gateway-secret" } },
          models: { providers: { nvidia: { apiKey: "nvidia-secret" } } },
        },
        cwd: path.resolve("repo-root"),
        env: {
          OPENCLAW_CONTAINER_CONFIG_PATH:
            "/home/node/openclaw-extra-agent-root/full-local/openclaw.json",
          OPENCLAW_EXTRA_AGENT_ROOT_DIR: extraRoot,
        },
        homeDir,
        portAvailable: async () => true,
        writeContainerConfigOverlay: true,
      });

      expect(runtime.facts.containerConfigPath).toBe(
        "/home/node/openclaw-extra-agent-root/full-local/openclaw.json",
      );
      expect(runtime.facts.containerConfigPathHost).toBe(
        path.join(extraRoot, "full-local", "openclaw.json"),
      );
      expect(existsSync(runtime.facts.containerConfigPathHost)).toBe(true);
    } finally {
      rmSync(homeDir, { force: true, recursive: true });
    }
  });

  it("rejects custom container config overlay paths outside full-local mounts", async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "openclaw-full-local-"));
    try {
      await expect(
        deriveFullLocalRuntime({
          config: {
            gateway: { auth: { token: "gateway-secret" } },
            models: { providers: { nvidia: { apiKey: "nvidia-secret" } } },
          },
          cwd: path.resolve("repo-root"),
          env: {
            OPENCLAW_CONTAINER_CONFIG_PATH: "/tmp/openclaw.json",
          },
          homeDir,
          portAvailable: async () => true,
          writeContainerConfigOverlay: true,
        }),
      ).rejects.toThrow("OPENCLAW_CONTAINER_CONFIG_PATH must point inside");
    } finally {
      rmSync(homeDir, { force: true, recursive: true });
    }
  });

  it("rejects container config overlays that would overwrite the active host config", async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "openclaw-full-local-"));
    const configDir = path.join(homeDir, ".openclaw");
    const configPath = path.join(configDir, "openclaw.json");
    try {
      mkdirSync(configDir, { recursive: true });
      writeFileSync(configPath, JSON.stringify({ original: true }));

      await expect(
        deriveFullLocalRuntime({
          config: {
            gateway: { auth: { token: "gateway-secret" } },
            models: { providers: { nvidia: { apiKey: "nvidia-secret" } } },
          },
          cwd: path.resolve("repo-root"),
          env: {
            OPENCLAW_CONFIG_DIR: configDir,
            OPENCLAW_CONTAINER_CONFIG_PATH: "/home/node/.openclaw/openclaw.json",
          },
          homeDir,
          portAvailable: async () => true,
          writeContainerConfigOverlay: true,
        }),
      ).rejects.toThrow(
        "OPENCLAW_CONTAINER_CONFIG_PATH must not overwrite the active OpenClaw config",
      );
      expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual({ original: true });
    } finally {
      rmSync(homeDir, { force: true, recursive: true });
    }
  });

  it("rejects raw config mode when external includes need container path rewriting", async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "openclaw-full-local-"));
    const configRoot = path.join(homeDir, "configs");
    const includeRoot = path.join(homeDir, "shared-includes");
    try {
      mkdirSync(configRoot, { recursive: true });
      mkdirSync(includeRoot, { recursive: true });
      const configPath = path.join(configRoot, "openclaw.json");
      const includePath = path.join(includeRoot, "agents.json5");
      writeFileSync(
        includePath,
        JSON.stringify({
          agents: {
            list: [{ id: "main", workspace: path.join(includeRoot, "main-workspace") }],
          },
        }),
      );
      writeFileSync(
        configPath,
        JSON.stringify({
          $include: includePath,
          gateway: { auth: { token: "gateway-secret" } },
          models: { providers: { nvidia: { apiKey: "nvidia-secret" } } },
        }),
      );

      await expect(
        deriveFullLocalRuntime({
          cwd: path.resolve("repo-root"),
          env: {
            OPENCLAW_CONFIG_PATH: configPath,
            OPENCLAW_FULL_LOCAL_USE_RAW_CONFIG: "1",
            OPENCLAW_INCLUDE_ROOTS: includeRoot,
          },
          homeDir,
          portAvailable: async () => true,
          writeContainerConfigOverlay: true,
        }),
      ).rejects.toThrow("Raw full-local config cannot use external OPENCLAW_INCLUDE_ROOTS");
    } finally {
      rmSync(homeDir, { force: true, recursive: true });
    }
  });

  it("maps extra configured agent roots into a mounted container root", async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "openclaw-full-local-"));
    try {
      const extraRoot = path.join(homeDir, "AG-media");
      const agentDir = path.join(extraRoot, "Music video");
      const runtime = await deriveFullLocalRuntime({
        config: {
          agents: {
            list: [
              {
                agentDir,
                id: "phonetic_sniper",
              },
            ],
          },
          gateway: { auth: { token: "gateway-secret" } },
          models: { providers: { nvidia: { apiKey: "nvidia-secret" } } },
        },
        cwd: path.resolve("repo-root"),
        env: {},
        homeDir,
        portAvailable: async () => true,
        writeContainerConfigOverlay: true,
      });
      const overlay = JSON.parse(readFileSync(runtime.facts.containerConfigPathHost, "utf8")) as {
        agents: { list: Array<{ agentDir?: string; id: string }> };
      };

      expect(runtime.env.OPENCLAW_EXTRA_AGENT_ROOT_DIR).toBe(agentDir);
      expect(runtime.facts.extraAgentRootDir).toBe(agentDir);
      expect(overlay.agents.list.find((entry) => entry.id === "phonetic_sniper")?.agentDir).toBe(
        "/home/node/openclaw-extra-agent-root",
      );
    } finally {
      rmSync(homeDir, { force: true, recursive: true });
    }
  });

  it("materializes container-safe MCP servers and records host-only desktop MCPs", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "openclaw-repo-"));
    const homeDir = mkdtempSync(path.join(tmpdir(), "openclaw-full-local-"));
    try {
      const swarmServer = path.join(cwd, ".agents", "skills", "swarm-mcp-server", "server.cjs");
      const pythonServer = path.join(cwd, "skills", "portable", "server.py");
      const desktopServer = path.join(homeDir, "Desktop Tool", "server.py");
      mkdirSync(path.dirname(swarmServer), { recursive: true });
      mkdirSync(path.dirname(pythonServer), { recursive: true });
      mkdirSync(path.dirname(desktopServer), { recursive: true });
      writeFileSync(swarmServer, "console.log('ok')\n");
      writeFileSync(pythonServer, "print('ok')\n");
      writeFileSync(desktopServer, "print('host-only')\n");

      const runtime = await deriveFullLocalRuntime({
        config: {
          gateway: { auth: { token: "gateway-secret" } },
          mcp: {
            servers: {
              desktopOnly: {
                args: [desktopServer],
                command: path.join(homeDir, "venv", "Scripts", "python.exe"),
              },
              portablePython: {
                args: [pythonServer],
                command: path.join(homeDir, "venv", "Scripts", "python.exe"),
                env: {
                  PYTHONPATH: path.dirname(pythonServer),
                  SAFE_FLAG: "1",
                },
              },
              swarm: {
                args: [swarmServer],
                command: "node",
              },
            },
          },
          models: { providers: { nvidia: { apiKey: "nvidia-secret" } } },
        },
        cwd,
        env: {},
        homeDir,
        portAvailable: async () => true,
        writeContainerConfigOverlay: true,
      });
      const overlay = JSON.parse(readFileSync(runtime.facts.containerConfigPathHost, "utf8")) as {
        mcp: {
          servers: Record<
            string,
            { args?: string[]; command?: string; env?: Record<string, string> }
          >;
        };
      };
      const pathMap = JSON.parse(readFileSync(runtime.facts.pathMapPathHost, "utf8")) as {
        agentVenvRoot: string;
        containerPython: string;
        hostOnlyMcpServers?: Array<{ name: string }>;
      };

      expect(overlay.mcp.servers.swarm.args).toEqual([
        "/app/scripts/docker/sidecars/node-mcp-launcher.cjs",
        "/home/node/openclaw-extra-agent-root/server.cjs",
      ]);
      expect(overlay.mcp.servers.swarm.env).toBeUndefined();
      expect(overlay.mcp.servers.portablePython.command).toBe("node");
      expect(overlay.mcp.servers.portablePython.args).toEqual([
        "/app/scripts/docker/sidecars/python-mcp-launcher.cjs",
        "/app/skills/portable/server.py",
      ]);
      expect(overlay.mcp.servers.portablePython.env).toEqual({ SAFE_FLAG: "1" });
      expect(overlay.mcp.servers.desktopOnly).toBeUndefined();
      expect(pathMap.hostOnlyMcpServers?.map((entry) => entry.name)).toEqual(["desktopOnly"]);
      expect(runtime.env.OPENCLAW_EXTRA_AGENT_ROOT_DIR).toBe(path.dirname(swarmServer));
      expect(runtime.env.OPENCLAW_CONTAINER_PYTHON).toBe("/usr/bin/python3");
      expect(runtime.env.OPENCLAW_AGENT_VENV_ROOT).toBe("/home/node/.openclaw/python-venvs");
      expect(pathMap.containerPython).toBe("/usr/bin/python3");
      expect(pathMap.agentVenvRoot).toBe("/home/node/.openclaw/python-venvs");
    } finally {
      rmSync(cwd, { force: true, recursive: true });
      rmSync(homeDir, { force: true, recursive: true });
    }
  });

  it("mounts out-of-tree container-safe MCP launch scripts", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "openclaw-repo-"));
    const homeDir = mkdtempSync(path.join(tmpdir(), "openclaw-full-local-"));
    try {
      const mcpRoot = path.join(homeDir, "External MCP", "Agentfy");
      const mcpScript = path.join(mcpRoot, "run_agent_api.py");
      mkdirSync(mcpRoot, { recursive: true });
      writeFileSync(mcpScript, "print('ok')\n");

      const runtime = await deriveFullLocalRuntime({
        config: {
          gateway: { auth: { token: "gateway-secret" } },
          mcp: {
            servers: {
              agentfy: {
                args: [mcpScript],
                command: "python",
              },
            },
          },
          models: { providers: { nvidia: { apiKey: "nvidia-secret" } } },
        },
        cwd,
        env: {},
        homeDir,
        portAvailable: async () => true,
        writeContainerConfigOverlay: true,
      });
      const overlay = JSON.parse(readFileSync(runtime.facts.containerConfigPathHost, "utf8")) as {
        mcp: { servers: Record<string, { args?: string[]; command?: string }> };
      };
      const pathMap = JSON.parse(readFileSync(runtime.facts.pathMapPathHost, "utf8")) as {
        hostOnlyMcpServers?: Array<{ name: string }>;
      };

      expect(runtime.env.OPENCLAW_EXTRA_AGENT_ROOT_DIR).toBe(mcpRoot);
      expect(overlay.mcp.servers.agentfy.command).toBe("node");
      expect(overlay.mcp.servers.agentfy.args).toEqual([
        "/app/scripts/docker/sidecars/python-mcp-launcher.cjs",
        "/home/node/openclaw-extra-agent-root/run_agent_api.py",
      ]);
      expect(pathMap.hostOnlyMcpServers ?? []).toEqual([]);
    } finally {
      rmSync(cwd, { force: true, recursive: true });
      rmSync(homeDir, { force: true, recursive: true });
    }
  });

  it("keeps Python HTTP apps out of the stdio MCP overlay", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "openclaw-repo-"));
    const homeDir = mkdtempSync(path.join(tmpdir(), "openclaw-full-local-"));
    try {
      const mcpRoot = path.join(homeDir, "External MCP", "Agentfy");
      const mcpScript = path.join(mcpRoot, "run_agent_api.py");
      mkdirSync(mcpRoot, { recursive: true });
      writeFileSync(
        mcpScript,
        [
          "from fastapi import FastAPI",
          "app = FastAPI()",
          "if __name__ == '__main__':",
          "    import uvicorn",
          "    uvicorn.run(app)",
          "",
        ].join("\n"),
      );

      const runtime = await deriveFullLocalRuntime({
        config: {
          gateway: { auth: { token: "gateway-secret" } },
          mcp: {
            servers: {
              agentfy: {
                args: [mcpScript],
                command: "python",
              },
            },
          },
          models: { providers: { nvidia: { apiKey: "nvidia-secret" } } },
        },
        cwd,
        env: {},
        homeDir,
        portAvailable: async () => true,
        writeContainerConfigOverlay: true,
      });
      const overlay = JSON.parse(readFileSync(runtime.facts.containerConfigPathHost, "utf8")) as {
        mcp: { servers: Record<string, { args?: string[]; command?: string }> };
      };
      const pathMap = JSON.parse(readFileSync(runtime.facts.pathMapPathHost, "utf8")) as {
        hostOnlyMcpServers?: Array<{ name: string; reason: string }>;
      };

      expect(overlay.mcp.servers.agentfy).toBeUndefined();
      expect(pathMap.hostOnlyMcpServers?.map((entry) => entry.name)).toEqual(["agentfy"]);
      expect(pathMap.hostOnlyMcpServers?.[0]?.reason).toContain("not a stdio MCP server");
    } finally {
      rmSync(cwd, { force: true, recursive: true });
      rmSync(homeDir, { force: true, recursive: true });
    }
  });

  it("classifies default, explicit, and config-marked native desktop agents", () => {
    expect(
      resolveFullLocalNativeAgentIds(
        {
          agents: {
            list: [
              { id: "future_desktop", params: { fullLocalRuntime: "desktop-native" } },
              { command: "C:\\Tools\\agent.exe", id: "command_agent" },
              { id: "container_agent" },
            ],
          },
        },
        { OPENCLAW_NATIVE_AGENT_IDS: "manual_agent" },
      ),
    ).toEqual([
      "command_agent",
      "future_desktop",
      "manual_agent",
      "pipeline_guardian",
      "uba_god_mode",
    ]);
  });

  it("stops a previous Windows-native bridge before Docker sidecars restart", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "openclaw-repo-"));
    const homeDir = mkdtempSync(path.join(tmpdir(), "openclaw-full-local-"));
    try {
      const runtime = await deriveFullLocalRuntime({
        config: {
          gateway: { auth: { token: "gateway-secret" } },
        },
        cwd,
        env: {
          OPENCLAW_SENTINEL_TOKEN: "sentinel-secret",
        },
        homeDir,
        portAvailable: async () => true,
        writeContainerConfigOverlay: true,
      });
      const pidPath = resolveWindowsNativeNodePidPath(runtime, cwd, homeDir);
      mkdirSync(path.dirname(pidPath), { recursive: true });
      writeFileSync(pidPath, "4242\n");
      const killed: number[] = [];
      const live = new Set([4242]);

      const stopped = stopWindowsNativeNode(runtime, {
        cwd,
        homeDir,
        killProcess: (pid: number) => {
          killed.push(pid);
          live.delete(pid);
        },
        platform: "win32",
        processIsAlive: (pid: number) => live.has(pid),
        sleep: () => {},
      });

      expect(stopped).toMatchObject({ ok: true, pid: 4242, skipped: false });
      expect(killed).toEqual([4242]);
      expect(existsSync(pidPath)).toBe(false);
    } finally {
      rmSync(cwd, { force: true, recursive: true });
      rmSync(homeDir, { force: true, recursive: true });
    }
  });

  it("uses the common parent for multiple extra configured agent roots", async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "openclaw-full-local-"));
    try {
      const extraRoot = path.join(homeDir, "AG-media");
      const runtime = await deriveFullLocalRuntime({
        config: {
          agents: {
            list: [
              {
                agentDir: path.join(extraRoot, "Music video"),
                id: "video",
              },
              {
                id: "audio",
                workspace: path.join(extraRoot, "Audio workspace"),
              },
            ],
          },
          gateway: { auth: { token: "gateway-secret" } },
          models: { providers: { nvidia: { apiKey: "nvidia-secret" } } },
        },
        cwd: path.resolve("repo-root"),
        env: {},
        homeDir,
        portAvailable: async () => true,
        writeContainerConfigOverlay: true,
      });
      const overlay = JSON.parse(readFileSync(runtime.facts.containerConfigPathHost, "utf8")) as {
        agents: { list: Array<{ agentDir?: string; id: string; workspace?: string }> };
      };

      expect(runtime.env.OPENCLAW_EXTRA_AGENT_ROOT_DIR).toBe(extraRoot);
      expect(overlay.agents.list.find((entry) => entry.id === "video")?.agentDir).toBe(
        "/home/node/openclaw-extra-agent-root/Music video",
      );
      expect(overlay.agents.list.find((entry) => entry.id === "audio")?.workspace).toBe(
        "/home/node/openclaw-extra-agent-root/Audio workspace",
      );
    } finally {
      rmSync(homeDir, { force: true, recursive: true });
    }
  });

  it("uses bounded extra mounts instead of a filesystem root for disjoint agent roots", async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "openclaw-full-local-"));
    try {
      const hostRoot = path.parse(homeDir).root;
      const videoRoot = path.join(hostRoot, "OpenClawVideoAgent");
      const toolsRoot = path.join(hostRoot, "OpenClawToolsAgent");
      const runtime = await deriveFullLocalRuntime({
        config: {
          agents: {
            list: [
              { agentDir: videoRoot, id: "video" },
              { agentDir: toolsRoot, id: "tools" },
            ],
          },
          gateway: { auth: { token: "gateway-secret" } },
          models: { providers: { nvidia: { apiKey: "nvidia-secret" } } },
        },
        cwd: path.resolve("repo-root"),
        env: {},
        homeDir,
        portAvailable: async () => true,
        writeContainerConfigOverlay: true,
      });
      const overlay = JSON.parse(readFileSync(runtime.facts.containerConfigPathHost, "utf8")) as {
        agents: { list: Array<{ agentDir?: string; id: string }> };
      };

      expect(runtime.facts.extraAgentRootDirs).toEqual([videoRoot, toolsRoot]);
      expect(runtime.env.OPENCLAW_EXTRA_AGENT_ROOT_DIR).toBe(videoRoot);
      expect(runtime.env.OPENCLAW_EXTRA_AGENT_ROOT_DIR_2).toBe(toolsRoot);
      expect(runtime.env.OPENCLAW_EXTRA_AGENT_ROOT_DIR).not.toBe(hostRoot);
      expect(overlay.agents.list.find((entry) => entry.id === "video")?.agentDir).toBe(
        "/home/node/openclaw-extra-agent-root",
      );
      expect(overlay.agents.list.find((entry) => entry.id === "tools")?.agentDir).toBe(
        "/home/node/openclaw-extra-agent-root-2",
      );
    } finally {
      rmSync(homeDir, { force: true, recursive: true });
    }
  });

  it("honors an explicit extra agent root for full-local path mapping", async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "openclaw-full-local-"));
    try {
      const extraRoot = path.join(homeDir, "mounted");
      const runtime = await deriveFullLocalRuntime({
        config: {
          agents: {
            defaults: {
              workspace: path.join(extraRoot, "workspace"),
            },
          },
          gateway: { auth: { token: "gateway-secret" } },
          models: { providers: { nvidia: { apiKey: "nvidia-secret" } } },
        },
        cwd: path.resolve("repo-root"),
        env: {
          OPENCLAW_EXTRA_AGENT_ROOT_DIR: extraRoot,
        },
        homeDir,
        portAvailable: async () => true,
        writeContainerConfigOverlay: true,
      });

      expect(runtime.env.OPENCLAW_EXTRA_AGENT_ROOT_DIR).toBe(extraRoot);
    } finally {
      rmSync(homeDir, { force: true, recursive: true });
    }
  });

  it("rejects external include roots when explicit extra-root slots are full", async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "openclaw-full-local-"));
    try {
      const includeRoot = path.join(homeDir, "include-root");
      mkdirSync(includeRoot, { recursive: true });

      await expect(
        deriveFullLocalRuntime({
          config: {
            gateway: { auth: { token: "gateway-secret" } },
            models: { providers: { nvidia: { apiKey: "nvidia-secret" } } },
          },
          cwd: path.resolve("repo-root"),
          env: {
            OPENCLAW_EXTRA_AGENT_ROOT_DIR: path.join(homeDir, "slot-1"),
            OPENCLAW_EXTRA_AGENT_ROOT_DIR_2: path.join(homeDir, "slot-2"),
            OPENCLAW_EXTRA_AGENT_ROOT_DIR_3: path.join(homeDir, "slot-3"),
            OPENCLAW_EXTRA_AGENT_ROOT_DIR_4: path.join(homeDir, "slot-4"),
            OPENCLAW_EXTRA_AGENT_ROOT_DIR_5: path.join(homeDir, "slot-5"),
            OPENCLAW_EXTRA_AGENT_ROOT_DIR_6: path.join(homeDir, "slot-6"),
            OPENCLAW_EXTRA_AGENT_ROOT_DIR_7: path.join(homeDir, "slot-7"),
            OPENCLAW_EXTRA_AGENT_ROOT_DIR_8: path.join(homeDir, "slot-8"),
            OPENCLAW_INCLUDE_ROOTS: includeRoot,
          },
          homeDir,
          portAvailable: async () => true,
          writeContainerConfigOverlay: true,
        }),
      ).rejects.toThrow("Full-local needs to mount");
    } finally {
      rmSync(homeDir, { force: true, recursive: true });
    }
  });

  it("rejects raw config mode when explicit extra-root slots leave the source unwritable", async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "openclaw-full-local-"));
    const configDir = path.join(homeDir, ".openclaw");
    const configSourceDir = path.join(homeDir, "host-config");
    const configPath = path.join(configSourceDir, "openclaw.json");
    try {
      mkdirSync(configDir, { recursive: true });
      mkdirSync(configSourceDir, { recursive: true });
      writeFileSync(
        configPath,
        JSON.stringify({
          gateway: { auth: { token: "gateway-secret" } },
          models: { providers: { nvidia: { apiKey: "nvidia-secret" } } },
        }),
      );

      await expect(
        deriveFullLocalRuntime({
          cwd: path.resolve("repo-root"),
          env: {
            OPENCLAW_CONFIG_DIR: configDir,
            OPENCLAW_CONFIG_PATH: configPath,
            OPENCLAW_EXTRA_AGENT_ROOT_DIR: path.join(homeDir, "slot-1"),
            OPENCLAW_EXTRA_AGENT_ROOT_DIR_2: path.join(homeDir, "slot-2"),
            OPENCLAW_EXTRA_AGENT_ROOT_DIR_3: path.join(homeDir, "slot-3"),
            OPENCLAW_EXTRA_AGENT_ROOT_DIR_4: path.join(homeDir, "slot-4"),
            OPENCLAW_EXTRA_AGENT_ROOT_DIR_5: path.join(homeDir, "slot-5"),
            OPENCLAW_EXTRA_AGENT_ROOT_DIR_6: path.join(homeDir, "slot-6"),
            OPENCLAW_EXTRA_AGENT_ROOT_DIR_7: path.join(homeDir, "slot-7"),
            OPENCLAW_EXTRA_AGENT_ROOT_DIR_8: path.join(homeDir, "slot-8"),
            OPENCLAW_FULL_LOCAL_USE_RAW_CONFIG: "1",
          },
          homeDir,
          portAvailable: async () => true,
          writeContainerConfigOverlay: true,
        }),
      ).rejects.toThrow("Full-local needs to mount");
    } finally {
      rmSync(homeDir, { force: true, recursive: true });
    }
  });

  it("reads JSON5 config and resolves relative includes before writing the overlay", async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "openclaw-full-local-"));
    const configDir = path.join(homeDir, ".openclaw");
    try {
      mkdirSync(path.join(configDir, "config"), { recursive: true });
      writeFileSync(
        path.join(configDir, "config", "nvidia.json5"),
        "{ apiKey: 'nvidia-secret', }\n",
      );
      writeFileSync(
        path.join(configDir, "openclaw.json"),
        [
          "{",
          "  // JSON5 comments and trailing commas are valid OpenClaw config.",
          "  gateway: { auth: { token: 'gateway-secret' } },",
          "  models: { providers: { nvidia: { $include: './config/nvidia.json5' } } },",
          "}",
          "",
        ].join("\n"),
      );

      const runtime = await deriveFullLocalRuntime({
        cwd: path.resolve("repo-root"),
        env: {
          OPENCLAW_CONFIG_DIR: configDir,
        },
        homeDir,
        portAvailable: async () => true,
        writeContainerConfigOverlay: true,
      });
      const overlay = JSON.parse(readFileSync(runtime.facts.containerConfigPathHost, "utf8")) as {
        gateway: { auth: { token: string } };
        models: { providers: { nvidia: { apiKey: string } } };
      };

      expect(runtime.env.OPENCLAW_GATEWAY_TOKEN).toBe("gateway-secret");
      expect(runtime.env.OPENCLAW_SENTINEL_TOKEN).toBe("nvidia-secret");
      expect(overlay.models.providers.nvidia.apiKey).toBe("nvidia-secret");
      expect(JSON.stringify(overlay)).not.toContain("$include");
    } finally {
      rmSync(homeDir, { force: true, recursive: true });
    }
  });

  it("rejects config includes that escape allowed roots through symlinks", async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "openclaw-full-local-"));
    const configDir = path.join(homeDir, ".openclaw");
    const outsideDir = path.join(homeDir, "outside");
    try {
      mkdirSync(path.join(configDir, "config"), { recursive: true });
      mkdirSync(outsideDir, { recursive: true });
      const outsideConfig = path.join(outsideDir, "nvidia.json5");
      const includeLink = path.join(configDir, "config", "nvidia.json5");
      writeFileSync(outsideConfig, "{ apiKey: 'nvidia-secret', }\n");
      try {
        symlinkSync(outsideConfig, includeLink, "file");
      } catch {
        return;
      }
      writeFileSync(
        path.join(configDir, "openclaw.json"),
        "{ gateway: { auth: { token: 'gateway-secret' } }, models: { providers: { nvidia: { $include: './config/nvidia.json5' } } } }\n",
      );

      await expect(
        deriveFullLocalRuntime({
          cwd: path.resolve("repo-root"),
          env: {
            OPENCLAW_CONFIG_DIR: configDir,
          },
          homeDir,
          portAvailable: async () => true,
          writeContainerConfigOverlay: true,
        }),
      ).rejects.toThrow("Config include escapes allowed roots");
    } finally {
      rmSync(homeDir, { force: true, recursive: true });
    }
  });

  it("resolves SecretRef-backed full-local tokens before validation and overlay writes", async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "openclaw-full-local-"));
    try {
      const runtime = await deriveFullLocalRuntime({
        config: {
          gateway: {
            auth: {
              token: {
                source: "env",
                provider: "default",
                id: "FULL_LOCAL_GATEWAY_TOKEN",
              },
            },
          },
          models: {
            providers: {
              nvidia: {
                apiKey: {
                  source: "env",
                  provider: "default",
                  id: "FULL_LOCAL_NVIDIA_KEY",
                },
              },
            },
          },
        },
        cwd: path.resolve("repo-root"),
        env: {
          FULL_LOCAL_GATEWAY_TOKEN: "resolved-gateway-secret",
          FULL_LOCAL_NVIDIA_KEY: "resolved-nvidia-secret",
        },
        homeDir,
        portAvailable: async () => true,
        writeContainerConfigOverlay: true,
      });
      const overlay = JSON.parse(readFileSync(runtime.facts.containerConfigPathHost, "utf8")) as {
        gateway: { auth: { token: string } };
        models: { providers: { nvidia: { apiKey: string } } };
      };

      expect(runtime.env.OPENCLAW_GATEWAY_TOKEN).toBe("resolved-gateway-secret");
      expect(runtime.env.OPENCLAW_SENTINEL_TOKEN).toBe("resolved-nvidia-secret");
      expect(overlay.gateway.auth.token).toBe("resolved-gateway-secret");
      expect(overlay.models.providers.nvidia.apiKey).toBe("resolved-nvidia-secret");
    } finally {
      rmSync(homeDir, { force: true, recursive: true });
    }
  });

  it("resolves file and exec SecretRefs for full-local provider credentials", async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "openclaw-full-local-"));
    try {
      const secretFile = path.join(homeDir, "secrets.json");
      const resolverPath = path.join(homeDir, "exec-secret.cjs");
      writeFileSync(
        secretFile,
        JSON.stringify({
          gateway: { token: "file-gateway-secret" },
        }),
      );
      writeFileSync(
        resolverPath,
        [
          "const chunks = [];",
          "process.stdin.on('data', (chunk) => chunks.push(chunk));",
          "process.stdin.on('end', () => {",
          "  const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));",
          "  const values = Object.fromEntries(request.ids.map((id) => [id, 'exec-nvidia-secret']));",
          "  process.stdout.write(JSON.stringify({ protocolVersion: 1, values }));",
          "});",
          "",
        ].join("\n"),
      );

      const runtime = await deriveFullLocalRuntime({
        config: {
          secrets: {
            providers: {
              localfile: {
                source: "file",
                path: secretFile,
                allowInsecurePath: true,
              },
              localexec: {
                source: "exec",
                command: process.execPath,
                args: [resolverPath],
                allowInsecurePath: true,
              },
            },
          },
          gateway: {
            auth: {
              token: {
                source: "file",
                provider: "localfile",
                id: "/gateway/token",
              },
            },
          },
          models: {
            providers: {
              nvidia: {
                apiKey: {
                  source: "exec",
                  provider: "localexec",
                  id: "providers/nvidia/apiKey",
                },
              },
            },
          },
        },
        cwd: path.resolve("repo-root"),
        env: {},
        homeDir,
        portAvailable: async () => true,
      });

      expect(runtime.env.OPENCLAW_GATEWAY_TOKEN).toBe("file-gateway-secret");
      expect(runtime.env.OPENCLAW_SENTINEL_TOKEN).toBe("exec-nvidia-secret");
      expect(runtime.env.NVIDIA_API_KEY).toBe("exec-nvidia-secret");
    } finally {
      rmSync(homeDir, { force: true, recursive: true });
    }
  });

  it.skipIf(process.platform === "win32")(
    "rejects file SecretRefs that fail secure-path checks",
    async () => {
      const homeDir = mkdtempSync(path.join(tmpdir(), "openclaw-full-local-"));
      try {
        const secretFile = path.join(homeDir, "secrets.json");
        writeFileSync(
          secretFile,
          JSON.stringify({
            gateway: { token: "file-gateway-secret" },
          }),
        );
        chmodSync(secretFile, 0o644);

        await expect(
          deriveFullLocalRuntime({
            config: {
              secrets: {
                providers: {
                  localfile: {
                    source: "file",
                    path: secretFile,
                  },
                },
              },
              gateway: {
                auth: {
                  token: {
                    source: "file",
                    provider: "localfile",
                    id: "/gateway/token",
                  },
                },
              },
              models: { providers: { nvidia: { apiKey: "nvidia-secret" } } },
            },
            cwd: path.resolve("repo-root"),
            env: {},
            homeDir,
            portAvailable: async () => true,
          }),
        ).rejects.toThrow(/failed to resolve SecretRef|permissions/i);
      } finally {
        rmSync(homeDir, { force: true, recursive: true });
      }
    },
  );

  it("rejects exec SecretRefs that fail secure command checks", async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "openclaw-full-local-"));
    try {
      await expect(
        deriveFullLocalRuntime({
          config: {
            secrets: {
              providers: {
                localexec: {
                  source: "exec",
                  command: process.execPath,
                  trustedDirs: [homeDir],
                  allowInsecurePath: true,
                },
              },
            },
            gateway: { auth: { token: "gateway-secret" } },
            models: {
              providers: {
                nvidia: {
                  apiKey: {
                    source: "exec",
                    provider: "localexec",
                    id: "providers/nvidia/apiKey",
                  },
                },
              },
            },
          },
          cwd: path.resolve("repo-root"),
          env: {},
          homeDir,
          portAvailable: async () => true,
        }),
      ).rejects.toThrow(/outside trustedDirs/);
    } finally {
      rmSync(homeDir, { force: true, recursive: true });
    }
  });

  it("seeds the memory proof into the resolved main-agent workspace", () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "openclaw-full-local-memory-"));
    try {
      const defaultWorkspace = path.join(homeDir, "default-workspace");
      const mainWorkspace = path.join(homeDir, "main-workspace");
      const configPath = path.join(homeDir, "openclaw.json");
      writeFileSync(
        configPath,
        JSON.stringify({
          agents: {
            defaults: { workspace: defaultWorkspace },
            list: [{ id: "main", workspace: mainWorkspace }],
          },
        }),
      );

      const result = spawnSync(process.execPath, ["-e", buildFullLocalMemorySeedScript()], {
        encoding: "utf8",
        env: {
          ...process.env,
          OPENCLAW_CONFIG_PATH: configPath,
          OPENCLAW_FULL_LOCAL_MEMORY_PROOF_CONTENT: "nonce: test",
          OPENCLAW_WORKSPACE_DIR: defaultWorkspace,
        },
      });

      expect(result.status).toBe(0);
      expect(
        readFileSync(path.join(mainWorkspace, "memory", "full-local-proof.md"), "utf8"),
      ).toContain("nonce: test");
      expect(existsSync(path.join(defaultWorkspace, "memory", "full-local-proof.md"))).toBe(false);
    } finally {
      rmSync(homeDir, { force: true, recursive: true });
    }
  });

  it("seeds the memory proof after resolving included agent config", () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "openclaw-full-local-memory-"));
    const includeRoot = path.join(homeDir, "includes");
    try {
      mkdirSync(includeRoot, { recursive: true });
      const defaultWorkspace = path.join(homeDir, "default-workspace");
      const includedWorkspace = path.join(homeDir, "included-main-workspace");
      const configPath = path.join(homeDir, "openclaw.json");
      const includePath = path.join(includeRoot, "agents.json5");
      writeFileSync(
        includePath,
        JSON.stringify({
          agents: {
            defaults: { workspace: defaultWorkspace },
            list: [{ id: "main", workspace: includedWorkspace }],
          },
        }),
      );
      writeFileSync(configPath, JSON.stringify({ $include: includePath }));

      const result = spawnSync(process.execPath, ["-e", buildFullLocalMemorySeedScript()], {
        encoding: "utf8",
        env: {
          ...process.env,
          OPENCLAW_CONFIG_PATH: configPath,
          OPENCLAW_FULL_LOCAL_MEMORY_PROOF_CONTENT: "nonce: included-test",
          OPENCLAW_INCLUDE_ROOTS: includeRoot,
          OPENCLAW_WORKSPACE_DIR: defaultWorkspace,
        },
      });

      expect(result.status, result.stderr).toBe(0);
      expect(
        readFileSync(path.join(includedWorkspace, "memory", "full-local-proof.md"), "utf8"),
      ).toContain("nonce: included-test");
      expect(existsSync(path.join(defaultWorkspace, "memory", "full-local-proof.md"))).toBe(false);
    } finally {
      rmSync(homeDir, { force: true, recursive: true });
    }
  });

  it("fails fast when an existing full-local config cannot be parsed", async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "openclaw-full-local-"));
    const configDir = path.join(homeDir, ".openclaw");
    try {
      mkdirSync(configDir, { recursive: true });
      writeFileSync(path.join(configDir, "openclaw.json"), "{ invalid json5\n");

      await expect(
        deriveFullLocalRuntime({
          cwd: path.resolve("repo-root"),
          env: {
            OPENCLAW_CONFIG_DIR: configDir,
          },
          homeDir,
          portAvailable: async () => true,
          writeContainerConfigOverlay: true,
        }),
      ).rejects.toThrow("Failed to parse full-local OpenClaw config");
    } finally {
      rmSync(homeDir, { force: true, recursive: true });
    }
  });

  it("aligns Sentinel auth with the NVIDIA provider key when Gateway routes through Sentinel", async () => {
    const runtime = await deriveFullLocalRuntime({
      config: {
        gateway: { auth: { token: "gateway-secret" } },
        models: {
          providers: {
            nvidia: {
              apiKey: "provider-token",
              baseUrl: "http://openclaw-sentinel:18888/v1",
            },
          },
        },
      },
      cwd: path.resolve("repo-root"),
      env: {},
      homeDir: path.resolve("home"),
      portAvailable: async () => true,
    });

    expect(runtime.env.OPENCLAW_SENTINEL_TOKEN).toBe("provider-token");
    expect(runtime.env.NVIDIA_API_KEY).toBeUndefined();
    expect(runtime.env.OPENCLAW_SIGNAL_HUB_NVIDIA_API_KEYS).toBeUndefined();
    expect(runtime.facts.nvidiaApiKeyConfigured).toBe(false);
    expect(runtime.facts.nvidiaProviderUsesSentinel).toBe(true);
    expect(runtime.facts.sentinelTokenMatchesNvidiaProvider).toBe(true);
    expect(validateFullLocalRuntime(runtime.facts, runtime.env)).toContain(
      "Missing NVIDIA API key pool. Set NVIDIA_API_KEY/NVIDIA_API_KEYS, or set models.providers.nvidia.apiKey when the provider is not already routed through Sentinel.",
    );
  });

  it("keeps pre-routed Sentinel provider tokens out of the upstream NVIDIA seed pool", async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "openclaw-full-local-"));
    try {
      const runtime = await deriveFullLocalRuntime({
        config: {
          gateway: { auth: { token: "gateway-secret" } },
          models: {
            providers: {
              nvidia: {
                apiKey: "sentinel-provider-token",
                baseUrl: "http://openclaw-sentinel:18888/v1",
              },
            },
          },
        },
        cwd: path.resolve("repo-root"),
        env: {
          NVIDIA_API_KEYS: "raw-nvidia-key-a,raw-nvidia-key-b",
        },
        homeDir,
        portAvailable: async () => true,
      });

      const seed = seedNvidiaVaultFromRuntime(runtime);
      const vault = JSON.parse(readFileSync(runtime.facts.nvidiaVaultPathHost, "utf8")) as {
        keys: string[];
      };

      expect(runtime.env.OPENCLAW_SENTINEL_TOKEN).toBe("sentinel-provider-token");
      expect(runtime.env.OPENCLAW_SIGNAL_HUB_NVIDIA_API_KEYS).toBe(
        "raw-nvidia-key-a,raw-nvidia-key-b",
      );
      expect(seed).toMatchObject({ keyCount: 2, seeded: true });
      expect(vault.keys).toEqual(["raw-nvidia-key-a", "raw-nvidia-key-b"]);
      expect(vault.keys).not.toContain("sentinel-provider-token");
    } finally {
      rmSync(homeDir, { force: true, recursive: true });
    }
  });

  it("routes env-only NVIDIA full-local configs through Sentinel", async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "openclaw-full-local-"));
    try {
      const runtime = await deriveFullLocalRuntime({
        config: {
          gateway: { auth: { token: "gateway-secret" } },
        },
        cwd: path.resolve("repo-root"),
        env: {
          NVIDIA_API_KEY: "env-nvidia",
        },
        homeDir,
        portAvailable: async () => true,
        writeContainerConfigOverlay: true,
      });

      expect(runtime.env.OPENCLAW_SENTINEL_TOKEN).toBe("env-nvidia");
      expect(runtime.facts.nvidiaProviderUsesSentinel).toBe(true);
    } finally {
      rmSync(homeDir, { force: true, recursive: true });
    }
  });

  it("uses an explicit Sentinel token as the Gateway key for plural NVIDIA key pools", async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "openclaw-full-local-"));
    const localAgentsDir = mkdtempSync(path.join(tmpdir(), "openclaw-agents-"));
    try {
      const runtime = await deriveFullLocalRuntime({
        config: {
          gateway: { auth: { token: "gateway-secret" } },
        },
        cwd: path.resolve("repo-root"),
        env: {
          NVIDIA_API_KEYS: "pool-key-a,pool-key-b",
          OPENCLAW_LOCAL_AGENTS_DIR: localAgentsDir,
          OPENCLAW_SENTINEL_TOKEN: "sentinel-secret",
        },
        homeDir,
        portAvailable: async () => true,
        writeContainerConfigOverlay: true,
      });
      const overlay = JSON.parse(readFileSync(runtime.facts.containerConfigPathHost, "utf8")) as {
        models: { providers: { nvidia: { apiKey: string; baseUrl: string } } };
      };

      expect(runtime.facts.nvidiaApiKeyConfigured).toBe(true);
      expect(runtime.facts.nvidiaProviderUsesSentinel).toBe(true);
      expect(runtime.env.OPENCLAW_SENTINEL_TOKEN).toBe("sentinel-secret");
      expect(runtime.env.OPENCLAW_SIGNAL_HUB_NVIDIA_API_KEYS).toBe("pool-key-a,pool-key-b");
      expect(runtime.env.OPENCLAW_SIGNAL_HUB_NVIDIA_API_KEY).toBeUndefined();
      expect(validateFullLocalRuntime(runtime.facts, runtime.env)).toEqual([]);
      expect(overlay.models.providers.nvidia.apiKey).toBe("sentinel-secret");
      expect(overlay.models.providers.nvidia.baseUrl).toBe("http://openclaw-sentinel:18888/v1");
    } finally {
      rmSync(homeDir, { force: true, recursive: true });
      rmSync(localAgentsDir, { force: true, recursive: true });
    }
  });

  it("uses a standalone Sentinel token as the Gateway key when the NVIDIA vault is preseeded", async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "openclaw-full-local-"));
    const localAgentsDir = mkdtempSync(path.join(tmpdir(), "openclaw-agents-"));
    try {
      const vaultPath = path.join(
        homeDir,
        ".openclaw",
        "workspace_nvidia_key_sentinel",
        "vault.json",
      );
      mkdirSync(path.dirname(vaultPath), { recursive: true });
      writeFileSync(vaultPath, JSON.stringify({ keys: ["nvapi-preseeded"], version: "1.0" }));
      const runtime = await deriveFullLocalRuntime({
        config: {
          gateway: { auth: { token: "gateway-secret" } },
        },
        cwd: path.resolve("repo-root"),
        env: {
          OPENCLAW_LOCAL_AGENTS_DIR: localAgentsDir,
          OPENCLAW_SENTINEL_TOKEN: "sentinel-secret",
        },
        homeDir,
        portAvailable: async () => true,
        writeContainerConfigOverlay: true,
      });
      const overlay = JSON.parse(readFileSync(runtime.facts.containerConfigPathHost, "utf8")) as {
        models: { providers: { nvidia: { apiKey: string; baseUrl: string } } };
      };

      expect(runtime.env.OPENCLAW_SENTINEL_TOKEN).toBe("sentinel-secret");
      expect(runtime.env.NVIDIA_API_KEY).toBeUndefined();
      expect(runtime.env.OPENCLAW_SIGNAL_HUB_NVIDIA_API_KEYS).toBeUndefined();
      expect(runtime.facts.nvidiaApiKeyConfigured).toBe(true);
      expect(validateFullLocalRuntime(runtime.facts, runtime.env)).toEqual([]);
      expect(overlay.models.providers.nvidia.apiKey).toBe("sentinel-secret");
      expect(overlay.models.providers.nvidia.baseUrl).toBe("http://openclaw-sentinel:18888/v1");
    } finally {
      rmSync(homeDir, { force: true, recursive: true });
      rmSync(localAgentsDir, { force: true, recursive: true });
    }
  });

  it("honors explicit Sentinel auth without replacing it with the upstream NVIDIA key", async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "openclaw-full-local-"));
    try {
      const runtime = await deriveFullLocalRuntime({
        config: {
          gateway: { auth: { token: "gateway-secret" } },
          models: { providers: { nvidia: { apiKey: "config-provider-key" } } },
        },
        cwd: path.resolve("repo-root"),
        env: {
          NVIDIA_API_KEY: "env-key-for-sidecars",
          OPENCLAW_SENTINEL_TOKEN: "sentinel-auth-token",
        },
        homeDir,
        portAvailable: async () => true,
        writeContainerConfigOverlay: true,
      });
      const overlay = JSON.parse(readFileSync(runtime.facts.containerConfigPathHost, "utf8")) as {
        models: { providers: { nvidia: { apiKey: string; baseUrl: string } } };
      };

      expect(runtime.env.NVIDIA_API_KEY).toBe("env-key-for-sidecars");
      expect(runtime.env.OPENCLAW_SENTINEL_TOKEN).toBe("sentinel-auth-token");
      expect(runtime.facts.sentinelTokenMatchesNvidiaProvider).toBe(true);
      expect(overlay.models.providers.nvidia.apiKey).toBe("sentinel-auth-token");
      expect(overlay.models.providers.nvidia.baseUrl).toBe("http://openclaw-sentinel:18888/v1");
    } finally {
      rmSync(homeDir, { force: true, recursive: true });
    }
  });

  it("honors configured Sentinel auth without replacing it with the upstream NVIDIA key", async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "openclaw-full-local-"));
    try {
      const runtime = await deriveFullLocalRuntime({
        config: {
          gateway: { auth: { token: "gateway-secret" } },
          models: {
            providers: {
              nvidia: {
                apiKey: "config-provider-key",
                sentinelToken: "configured-sentinel-token",
              },
            },
          },
        },
        cwd: path.resolve("repo-root"),
        env: {
          NVIDIA_API_KEY: "env-key-for-sidecars",
        },
        homeDir,
        portAvailable: async () => true,
        writeContainerConfigOverlay: true,
      });
      const overlay = JSON.parse(readFileSync(runtime.facts.containerConfigPathHost, "utf8")) as {
        models: { providers: { nvidia: { apiKey: string } } };
      };

      expect(runtime.env.NVIDIA_API_KEY).toBe("env-key-for-sidecars");
      expect(runtime.env.OPENCLAW_SENTINEL_TOKEN).toBe("configured-sentinel-token");
      expect(runtime.facts.sentinelTokenMatchesNvidiaProvider).toBe(true);
      expect(overlay.models.providers.nvidia.apiKey).toBe("configured-sentinel-token");
    } finally {
      rmSync(homeDir, { force: true, recursive: true });
    }
  });

  it("builds the explicit sidecar compose command and services", () => {
    expect(buildComposeArgs(["ps", "--format", "json"])).toEqual([
      "compose",
      "-f",
      "docker-compose.yml",
      "-f",
      "docker-compose.sidecars.yml",
      "--profile",
      "local-sidecars",
      "ps",
      "--format",
      "json",
    ]);

    expect(buildUpArgs({}).slice(-FULL_LOCAL_START_SERVICES.length)).toEqual(
      FULL_LOCAL_START_SERVICES,
    );
    expect(FULL_LOCAL_START_SERVICES).toContain("openclaw-cli");
    expect(FULL_LOCAL_SERVICES).not.toContain("openclaw-cli");
    expect(buildUpArgs({})).toContain("--build");
    expect(buildUpArgs({ OPENCLAW_FULL_LOCAL_SKIP_BUILD: "1" })).not.toContain("--build");
  });

  it("builds root mount repair through the sidecar compose profile", () => {
    const args = buildMountPermissionRepairArgs(FULL_LOCAL_MOUNT_REPAIR_SERVICES[0]);
    const script = buildMountPermissionRepairScript();

    expect(FULL_LOCAL_MOUNT_REPAIR_SERVICES).toEqual(["openclaw-gateway"]);
    expect(args.slice(0, 8)).toEqual([
      "compose",
      "-f",
      "docker-compose.yml",
      "-f",
      "docker-compose.sidecars.yml",
      "--profile",
      "local-sidecars",
      "exec",
    ]);
    expect(args).toContain("-u");
    expect(args).toContain("root");
    expect(args).toContain("openclaw-gateway");
    expect(args).toContain("node");
    expect(args).toContain("-e");
    expect(script).toContain("/home/node/.openclaw");
    expect(script).toContain("/home/node/openclaw-extra-agent-root-4");
    expect(script).toContain("OPENCLAW_NVIDIA_VAULT_PATH");
    expect(script).not.toContain("process.env.NVIDIA_API_KEY");
  });

  it("filters only active full-local smoke tickets for stale-ticket cleanup", () => {
    const staleData = {
      createdBy: "scripts/docker/full-local.mjs",
      nonce: "full-local-smoke-123",
      purpose: "Verify signal-hub routes and claims a Blackboard ticket.",
    };
    const tickets = [
      { data: JSON.stringify(staleData), id: "open", status: "OPEN" },
      { data: JSON.stringify(staleData), id: "claimed", status: "CLAIMED" },
      { data: JSON.stringify(staleData), id: "progress", status: "IN_PROGRESS" },
      { data: JSON.stringify(staleData), id: "done", status: "DONE" },
      {
        data: JSON.stringify({ ...staleData, nonce: "manual-smoke" }),
        id: "manual",
        status: "OPEN",
      },
      { data: JSON.stringify({ ...staleData, createdBy: "user" }), id: "user", status: "OPEN" },
      { data: "{ invalid", id: "invalid", status: "OPEN" },
    ];

    expect(filterStaleFullLocalSmokeTickets(tickets).map((ticket) => ticket.id)).toEqual([
      "open",
      "claimed",
      "progress",
    ]);
  });

  it("evaluates the Agent OS golden E2E contract and restart proof", () => {
    const ticketId = "ticket-golden";
    const proof = {
      artifactContract: {
        path: ".artifacts/full-local-agent-os-golden-e2e.json",
        schemaVersion: "agent-os.artifact.v1",
      },
      blackboardAfterRestart: { ok: true },
      proofEventsAfterRestart: {
        events: [
          {
            agent_os: {
              schemaVersion: "agent-os.proof-event.v1",
            },
            payload: {},
          },
        ],
      },
      proofEventsBeforeRestart: {
        events: [
          {
            agent_os: {
              schemaVersion: "agent-os.proof-event.v1",
            },
            payload: {
              agentOsTicket: {
                schemaVersion: "agent-os.ticket.v1",
              },
            },
          },
        ],
      },
      readinessAfterRestart: { ok: true },
      restart: { ok: true },
      smoke: {
        completed: true,
        post: {
          ok: true,
          ticketId,
        },
        routed: true,
      },
      ticketAfterRestart: {
        ticket: {
          id: ticketId,
          status: "DONE",
        },
      },
      ticketBeforeRestart: {
        ticket: {
          id: ticketId,
          status: "DONE",
        },
      },
      ticketId,
    };

    const result = evaluateAgentOsGoldenE2E(proof);

    expect(result.ok).toBe(true);
    expect(result.checks.map((check) => [check.name, check.ok])).toEqual([
      ["ticket accepted", true],
      ["ticket routed", true],
      ["ticket completed", true],
      ["proof events listed", true],
      ["proof event contract", true],
      ["ticket contract in proof", true],
      ["artifact contract", true],
      ["signal-hub restarted", true],
      ["blackboard ready after restart", true],
      ["readiness proof after restart", true],
      ["ticket survived restart", true],
      ["proof survived restart", true],
    ]);

    expect(
      evaluateAgentOsGoldenE2E({
        ...proof,
        ticketAfterRestart: { ticket: { id: ticketId, status: "CLAIMED" } },
      }).ok,
    ).toBe(false);
  });

  it("allows token-optional Sentinel full-local validation", () => {
    const localAgentsDir = mkdtempSync(path.join(tmpdir(), "openclaw-agents-"));
    try {
      expect(
        validateFullLocalRuntime(
          {
            gatewayAuthConfigured: true,
            gatewayTokenConfigured: true,
            localAgentsDir,
            nvidiaApiKeyConfigured: true,
            sentinelTokenConfigured: false,
          },
          { OPENCLAW_SENTINEL_REQUIRE_TOKEN: "0" },
        ),
      ).toEqual([]);
    } finally {
      rmSync(localAgentsDir, { force: true, recursive: true });
    }
  });

  it("does not require ignored local .agents scripts for full-local validation", () => {
    expect(
      validateFullLocalRuntime(
        {
          gatewayAuthConfigured: true,
          gatewayTokenConfigured: true,
          nvidiaApiKeyConfigured: true,
          sentinelTokenConfigured: true,
        },
        {},
      ),
    ).toEqual([]);
  });

  it("keeps Sentinel validator keys after transient NVIDIA validation failures", () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "openclaw-validator-home-"));
    const vaultPath = path.join(homeDir, "vault.json");
    const script = path.resolve("scripts/docker/sidecars/nvidia-key-validator.cjs");
    try {
      const child = spawnSync(
        process.execPath,
        [
          "-e",
          `global.fetch = async () => ({ ok: false, status: 429, text: async () => "rate limited" }); require(${JSON.stringify(script)});`,
        ],
        {
          cwd: path.resolve("."),
          encoding: "utf8",
          env: {
            ...process.env,
            HOME: homeDir,
            NVIDIA_API_KEY: "",
            NVIDIA_API_KEYS: "nvapi-transientkey",
            OPENCLAW_NVIDIA_VAULT_PATH: vaultPath,
            OPENCLAW_SENTINEL_RESEED_NVIDIA_VAULT: "0",
            OPENCLAW_SIGNAL_HUB_NVIDIA_API_KEYS: "",
            USERPROFILE: homeDir,
          },
        },
      );

      expect(child.status, child.stderr).toBe(0);
      expect(JSON.parse(readFileSync(vaultPath, "utf8")).keys).toEqual(["nvapi-transientkey"]);
      expect(`${child.stdout}\n${child.stderr}`).toContain("validation deferred");
    } finally {
      rmSync(homeDir, { force: true, recursive: true });
    }
  });

  it("quarantines Sentinel validator keys only after definitive auth failures", () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "openclaw-validator-home-"));
    const vaultPath = path.join(homeDir, "vault.json");
    const script = path.resolve("scripts/docker/sidecars/nvidia-key-validator.cjs");
    try {
      const child = spawnSync(
        process.execPath,
        [
          "-e",
          `global.fetch = async () => ({ ok: false, status: 401, text: async () => "bad token" }); require(${JSON.stringify(script)});`,
        ],
        {
          cwd: path.resolve("."),
          encoding: "utf8",
          env: {
            ...process.env,
            HOME: homeDir,
            NVIDIA_API_KEY: "",
            NVIDIA_API_KEYS: "nvapi-authfailure",
            OPENCLAW_NVIDIA_VAULT_PATH: vaultPath,
            OPENCLAW_SENTINEL_RESEED_NVIDIA_VAULT: "0",
            OPENCLAW_SIGNAL_HUB_NVIDIA_API_KEYS: "",
            USERPROFILE: homeDir,
          },
        },
      );

      expect(child.status, child.stderr).toBe(0);
      expect(JSON.parse(readFileSync(vaultPath, "utf8")).keys).toEqual([]);
      expect(`${child.stdout}\n${child.stderr}`).toContain("Quarantined invalid NVIDIA key");
    } finally {
      rmSync(homeDir, { force: true, recursive: true });
    }
  });

  it("keeps signal-hub type fallback and claimed-ticket retry paths wired", () => {
    const signalHub = readFileSync("scripts/docker/sidecars/signal-hub.cjs", "utf8");
    const blackboard = readFileSync("scripts/docker/sidecars/blackboard-cli.cjs", "utf8");

    expect(signalHub).not.toContain("ZERO_EMBEDDING");
    expect(blackboard).not.toContain("ZERO_EMBEDDING");
    expect(signalHub).toContain('require("../../lib/proof-events.cjs")');
    expect(signalHub).toContain("ensureProofEventsSchema(conn)");
    expect(signalHub).toContain('recordSignalProofEvent(ticket.id, "SIGNAL_ROUTE"');
    expect(signalHub).toContain("SIGNAL_DISPATCHED");
    expect(signalHub).toContain("SIGNAL_DISPATCH_FAILED");
    expect(blackboard).toContain('require("../../lib/proof-events.cjs")');
    expect(blackboard).toContain("ensureProofEventsSchema(this.db)");
    expect(blackboard).toContain("recordProofEvent(this.db");
    expect(blackboard).toContain('command === "proof-list"');
    expect(blackboard).toContain('command === "proof-summary"');
    expect(blackboard).toContain('command === "proof-record"');
    expect(readFileSync("Dockerfile", "utf8")).toContain(
      "/app/scripts/lib/proof-events.cjs ./scripts/lib/proof-events.cjs",
    );
    expect(readFileSync("Dockerfile", "utf8")).toContain(
      "/app/scripts/lib/agent-os-contracts.cjs ./scripts/lib/agent-os-contracts.cjs",
    );
    expect(signalHub).toMatch(/agentEmbeddings\.length === 0[\s\S]+type-fallback/);
    expect(signalHub).toContain("decodeFloat32Vector(row.embedding)");
    expect(signalHub).toContain("value.byteOffset");
    expect(signalHub).not.toContain("PRAGMA data_version");
    expect(signalHub).not.toContain("initEmbeddings().then");
    expect(signalHub).toContain("void initEmbeddings().catch");
    expect(signalHub).toContain('["autonomy_smoke", "main"]');
    expect(signalHub).toContain(
      'const BLACKBOARD_CLI_PATH = "/app/scripts/docker/sidecars/blackboard-cli.cjs"',
    );
    expect(signalHub).toContain('"agent"');
    expect(signalHub).toContain('"--message"');
    expect(signalHub).toContain('"--session-id"');
    expect(signalHub).toContain("blackboard-${displayTicketId}");
    expect(signalHub).toContain('"--json"');
    expect(signalHub).not.toContain('"run"');
    expect(signalHub).not.toContain('"--durable"');
    expect(signalHub).toContain("Use the exec tool for the state updates");
    expect(signalHub).toContain("For autonomy_smoke, the entire task");
    expect(signalHub).toContain("SWARM_SIGNAL_ACK_ONLY_FINALIZE_GRACE_MS");
    expect(signalHub).toContain("ACK_ONLY_AUTO_DONE");
    expect(signalHub).toContain("SIGNAL_ACK_ONLY_AUTO_DONE");
    expect(signalHub).toContain('ticket.data.includes("capability-agent-routing-proof")');
    expect(signalHub).toContain("agent acknowledged ack-only proof ticket");
    expect(signalHub).toContain("SWARM_SIGNAL_FULL_LOCAL_SMOKE_STALE_MS");
    expect(signalHub).toContain("OPENCLAW_NATIVE_AGENT_IDS");
    expect(signalHub).toContain("30 * 60 * 1000");
    expect(signalHub).toContain("full-local-smoke-");
    expect(signalHub).toContain("archiveStaleFullLocalSmokeTicket");
    expect(signalHub).toContain("ARCHIVED_STALE_FULL_LOCAL_SMOKE");
    expect(signalHub).toContain("if (await triggerAgent(targetAgent, ticket))");
    expect(signalHub).toContain("if (isAckOnlyProofTicket(ticket))");
    expect(signalHub).toContain("markAsDispatched(ticket, targetAgent)");
    expect(signalHub).toContain('const status = isAckOnlyProofTicket(ticket) ? "IN_PROGRESS"');
    expect(signalHub).toContain("ackOnly: isAckOnlyProofTicket(ticket)");
    expect(signalHub).toContain("markDispatchFailed(ticket.id, targetAgent)");
    expect(signalHub).not.toContain("UPDATE tickets SET status = 'CLAIMED'");
    expect(signalHub).toContain("SELECT rowid, * FROM tickets WHERE status IN ('OPEN', 'CLAIMED')");
    expect(signalHub).toContain("Re-dispatching expired claimed ticket");
    const postBody = blackboard.slice(
      blackboard.indexOf("async post("),
      blackboard.indexOf("\n  list()"),
    );
    expect(postBody).not.toContain("getEmbedding");
    expect(postBody).toContain("this.queueTicketEmbedding(row.rowid)");
    expect(blackboard).toContain('command === "embed"');
    expect(blackboard).toContain("if (embedding) {");
    expect(blackboard).toContain("await this.refreshTicketEmbedding(row?.rowid, parsedData)");
    expect(blackboard).toContain("await board.update(");
    expect(readFileSync("scripts/docker/full-local.mjs", "utf8")).toContain(
      '["CLAIMED", "IN_PROGRESS", "DONE"].includes(String(ticket.status))',
    );
    expect(readFileSync("scripts/docker/full-local.mjs", "utf8")).toContain(
      "return { ...smoke, artifactPath, ok: smoke.completed }",
    );
    expect(readFileSync("scripts/docker/full-local.mjs", "utf8")).toContain(
      'command === "golden" || command === "golden-e2e"',
    );
    expect(readFileSync("scripts/docker/full-local.mjs", "utf8")).toContain(
      '["proof-list", ticketId, "--limit", limit]',
    );
    expect(readFileSync("scripts/docker/full-local.mjs", "utf8")).toContain(
      "PRAGMA wal_checkpoint(TRUNCATE);",
    );
    expect(readFileSync("scripts/docker/full-local.mjs", "utf8")).toContain(
      "pruneCheckpointedWalFiles(dbPath, checkpoint)",
    );
    expect(readFileSync("scripts/docker/full-local.mjs", "utf8")).toContain(
      "const windowsNodeStop = stopWindowsNativeNode(runtime, { cwd })",
    );
  });

  it("keeps the Windows native launcher on tracked repo scripts", () => {
    const launcher = readFileSync("start_windows_node.bat", "utf8");
    const windowsNode = readFileSync("scripts/docker/sidecars/windows-node.cjs", "utf8");
    expect(launcher).toContain("scripts\\docker\\sidecars\\windows-node.cjs");
    expect(launcher).not.toContain(".agents");
    expect(windowsNode).toContain('require("../../lib/proof-events.cjs")');
    expect(windowsNode).toContain("ensureProofEventsSchema(conn)");
    expect(windowsNode).toContain("recordWindowsProofEvent");
    expect(windowsNode).toContain("WINDOWS_NODE_DISPATCHED");
    expect(windowsNode).toContain("WINDOWS_NODE_DISPATCH_FAILED");
    expect(windowsNode).toContain("process.env.OPENCLAW_HOME");
    expect(windowsNode).toContain("process.env.OPENCLAW_STATE_DIR");
    expect(windowsNode).toContain("process.env.OPENCLAW_CONFIG_DIR");
    expect(windowsNode).toContain("process.env.OPENCLAW_CONFIG_PATH");
    expect(windowsNode).toContain('const JSON5 = require("json5")');
    expect(windowsNode).toContain('const INCLUDE_KEY = "$include"');
    expect(windowsNode).toContain("function resolveConfigIncludes");
    expect(windowsNode).toContain("OPENCLAW_NATIVE_AGENT_IDS");
    expect(windowsNode).toContain("openclaw.mjs");
    expect(windowsNode).toContain('"agent"');
    expect(windowsNode).toContain('"--session-id"');
    expect(windowsNode).toContain("SWARM_WINDOWS_NODE_DISPATCH_MODE");
  });

  it("keeps Sentinel host exposure and secret mounts constrained", () => {
    const compose = readFileSync("docker-compose.yml", "utf8");
    const sidecars = readFileSync("docker-compose.sidecars.yml", "utf8");
    const gatewayBlock = compose.slice(
      compose.indexOf("  openclaw-gateway:"),
      compose.indexOf("  openclaw-cli:"),
    );
    const sentinelBlock = sidecars.slice(
      sidecars.indexOf("  openclaw-sentinel:"),
      sidecars.indexOf("  openclaw-signal-hub:"),
    );
    const signalHubBlock = sidecars.slice(
      sidecars.indexOf("  openclaw-signal-hub:"),
      sidecars.indexOf("  openclaw-obsidian-syncer:"),
    );

    expect(gatewayBlock).toContain(
      '"${OPENCLAW_GATEWAY_PUBLISH_HOST:-127.0.0.1}:${OPENCLAW_GATEWAY_PORT:-18789}:18789"',
    );
    expect(gatewayBlock).toContain(
      '"${OPENCLAW_BRIDGE_PUBLISH_HOST:-127.0.0.1}:${OPENCLAW_BRIDGE_PORT:-18790}:18790"',
    );
    expect(gatewayBlock).toContain(
      '"${OPENCLAW_MSTEAMS_PUBLISH_HOST:-127.0.0.1}:${OPENCLAW_MSTEAMS_PORT:-3978}:3978"',
    );
    expect(sentinelBlock).toContain(
      '"${OPENCLAW_SENTINEL_PUBLISH_HOST:-127.0.0.1}:${OPENCLAW_SENTINEL_PORT:-18888}:${OPENCLAW_SENTINEL_LISTEN_PORT:-18888}"',
    );
    expect(sentinelBlock).toContain(
      "OPENCLAW_SENTINEL_REQUIRE_TOKEN: ${OPENCLAW_SENTINEL_REQUIRE_TOKEN:-1}",
    );
    expect(sentinelBlock).not.toContain("OPENCLAW_AUTH_PROFILE_SECRET_DIR");
    expect(signalHubBlock).toContain(
      "SWARM_BLACKBOARD_JOURNAL_MODE: ${SWARM_BLACKBOARD_JOURNAL_MODE:-DELETE}",
    );
    expect(signalHubBlock).toContain(
      "SWARM_BLACKBOARD_BUSY_TIMEOUT_MS: ${SWARM_BLACKBOARD_BUSY_TIMEOUT_MS:-10000}",
    );
  });

  it("loads Windows native agent config through JSON5 includes", () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "openclaw-windows-node-"));
    const configDir = path.join(homeDir, ".openclaw");
    const configPath = path.join(configDir, "openclaw.json");
    try {
      mkdirSync(path.join(configDir, "config"), { recursive: true });
      writeFileSync(
        path.join(configDir, "config", "agents.json5"),
        [
          "{",
          "  list: [",
          "    { id: 'uba_god_mode', command: 'python', agentDir: './agents/uba' },",
          "  ],",
          "}",
          "",
        ].join("\n"),
      );
      writeFileSync(
        configPath,
        [
          "{",
          "  // Windows-native nodes use the same JSON5 include contract.",
          "  agents: { $include: './config/agents.json5' },",
          "}",
          "",
        ].join("\n"),
      );

      const script = path.resolve("scripts/docker/sidecars/windows-node.cjs");
      const child = spawnSync(
        process.execPath,
        [
          "-e",
          `const node=require(${JSON.stringify(script)}); process.stdout.write(JSON.stringify(node.readConfig()));`,
        ],
        {
          cwd: path.resolve("."),
          encoding: "utf8",
          env: {
            ...process.env,
            HOME: homeDir,
            OPENCLAW_CONFIG_PATH: configPath,
            OPENCLAW_STATE_DIR: configDir,
            USERPROFILE: homeDir,
          },
        },
      );

      expect(child.status, child.stderr).toBe(0);
      const parsed = JSON.parse(child.stdout) as {
        agents?: { list?: Array<{ agentDir?: string; command?: string; id?: string }> };
      };
      expect(parsed.agents?.list?.[0]).toEqual({
        agentDir: "./agents/uba",
        command: "python",
        id: "uba_god_mode",
      });
    } finally {
      rmSync(homeDir, { force: true, recursive: true });
    }
  });

  it("rejects trusted-proxy Gateway auth for Docker-bridge sidecars", () => {
    const localAgentsDir = mkdtempSync(path.join(tmpdir(), "openclaw-agents-"));
    try {
      expect(
        validateFullLocalRuntime(
          {
            gatewayAuthConfigured: true,
            gatewayAuthMode: "trusted-proxy",
            gatewayPasswordConfigured: true,
            gatewayTokenConfigured: false,
            localAgentsDir,
            nvidiaApiKeyConfigured: true,
            sentinelTokenConfigured: true,
          },
          {},
        ),
      ).toContain(
        "Full-local sidecars cannot authenticate through gateway.auth.mode=trusted-proxy over the Docker bridge. Use gateway.auth.mode token or password for full-local startup.",
      );
    } finally {
      rmSync(localAgentsDir, { force: true, recursive: true });
    }
  });

  it("rejects unauthenticated Gateway mode for host-accessible full-local startup", () => {
    const localAgentsDir = mkdtempSync(path.join(tmpdir(), "openclaw-agents-"));
    try {
      expect(
        validateFullLocalRuntime(
          {
            gatewayAuthConfigured: true,
            gatewayAuthMode: "none",
            gatewayPasswordConfigured: false,
            gatewayTokenConfigured: false,
            localAgentsDir,
            nvidiaApiKeyConfigured: true,
            sentinelTokenConfigured: true,
          },
          {},
        ),
      ).toContain(
        "Full-local refuses gateway.auth.mode=none because the Docker Gateway is host-accessible by default. Use gateway.auth.mode token or password for full-local startup.",
      );
    } finally {
      rmSync(localAgentsDir, { force: true, recursive: true });
    }
  });

  it("rejects loopback-only Gateway binding for bridge sidecars", () => {
    const localAgentsDir = mkdtempSync(path.join(tmpdir(), "openclaw-agents-"));
    try {
      expect(
        validateFullLocalRuntime(
          {
            gatewayAuthConfigured: true,
            gatewayTokenConfigured: true,
            localAgentsDir,
            nvidiaApiKeyConfigured: true,
            sentinelTokenConfigured: true,
          },
          { OPENCLAW_GATEWAY_BIND: "loopback" },
        ),
      ).toContain(
        "Full-local sidecars require the Gateway to listen on the Docker bridge. Remove OPENCLAW_GATEWAY_BIND=loopback or set OPENCLAW_GATEWAY_BIND=lan for full-local startup.",
      );
    } finally {
      rmSync(localAgentsDir, { force: true, recursive: true });
    }
  });

  it("rejects loopback-only Sentinel binding for bridge sidecars", () => {
    const localAgentsDir = mkdtempSync(path.join(tmpdir(), "openclaw-agents-"));
    try {
      expect(
        validateFullLocalRuntime(
          {
            gatewayAuthConfigured: true,
            gatewayTokenConfigured: true,
            localAgentsDir,
            nvidiaApiKeyConfigured: true,
            sentinelTokenConfigured: true,
          },
          { OPENCLAW_SENTINEL_HOST: "127.0.0.1" },
        ),
      ).toContain(
        "Full-local sidecars require Sentinel to listen on the Docker bridge. Remove OPENCLAW_SENTINEL_HOST=loopback or set OPENCLAW_SENTINEL_HOST=0.0.0.0 for full-local startup.",
      );
    } finally {
      rmSync(localAgentsDir, { force: true, recursive: true });
    }
  });

  it("rejects full-local startup without NVIDIA keys for Sentinel readiness", () => {
    const localAgentsDir = mkdtempSync(path.join(tmpdir(), "openclaw-agents-"));
    try {
      expect(
        validateFullLocalRuntime(
          {
            gatewayAuthConfigured: true,
            gatewayTokenConfigured: true,
            localAgentsDir,
            nvidiaApiKeyConfigured: false,
            sentinelTokenConfigured: true,
          },
          {},
        ),
      ).toContain(
        "Missing NVIDIA API key pool. Set NVIDIA_API_KEY/NVIDIA_API_KEYS, or set models.providers.nvidia.apiKey when the provider is not already routed through Sentinel.",
      );
    } finally {
      rmSync(localAgentsDir, { force: true, recursive: true });
    }
  });

  it("keeps the Sentinel watchdog wired to the sidecar Compose overlay", () => {
    const watchdog = readFileSync("scripts/gateway_watchdog.ps1", "utf8");

    expect(watchdog).toContain(
      'docker compose -f "$RepoRoot\\docker-compose.yml" -f "$RepoRoot\\docker-compose.sidecars.yml" --profile sentinel ps --format json openclaw-sentinel',
    );
    expect(watchdog).toContain(
      'compose -f `"$RepoRoot\\docker-compose.yml`" -f `"$RepoRoot\\docker-compose.sidecars.yml`" --profile sentinel restart openclaw-sentinel',
    );
  });

  it("builds a container-safe full-local config overlay for memory/wiki proof", () => {
    const configDir = path.resolve("home", ".openclaw");
    const repoRoot = path.resolve("repo-root");
    const customSwarmDir = path.resolve("AG-Custom-Swarm");
    const workspaceDir = path.resolve("external-workspace");
    const overlay = buildFullLocalContainerConfig(
      {
        agents: {
          defaults: {
            memorySearch: { enabled: false, sync: { watch: true } },
            workspace: workspaceDir,
          },
          list: [
            {
              agentDir: path.join(configDir, "agents", "main", "agent"),
              id: "main",
              workspace: path.join(configDir, "workspace_main"),
            },
            {
              agentDir: path.join(customSwarmDir, "agents", "worker"),
              id: "worker",
              systemPromptOverride: "legacy unsupported capability-profile field",
              workspace: path.join(workspaceDir, "worker"),
            },
          ],
        },
        plugins: {
          slots: { memory: "none" },
          entries: {
            "memory-wiki": {
              config: {
                obsidian: { enabled: false, useOfficialCli: true },
                vault: { path: path.join(customSwarmDir, "Obsidian Vault"), renderMode: "native" },
                vaultMode: "isolated",
              },
            },
          },
        },
      },
      {
        configDir,
        customSwarmDir,
        cwd: repoRoot,
        nvidiaSentinelBaseUrl: "http://openclaw-sentinel:18888/v1",
        workspaceDir,
      },
    ) as {
      agents: {
        defaults: {
          memorySearch: { enabled: boolean; sync: { watch: boolean } };
          workspace: string;
        };
        list: Array<{ agentDir: string; systemPromptOverride?: string; workspace: string }>;
      };
      models: { providers: { nvidia: { baseUrl: string } } };
      plugins: {
        slots: { memory: string };
        entries: Record<string, { enabled: boolean; config?: Record<string, unknown> }>;
      };
    };

    expect(overlay.agents.defaults.memorySearch.enabled).toBe(true);
    expect(overlay.agents.defaults.memorySearch.sync.watch).toBe(false);
    expect(overlay.agents.defaults.workspace).toBe("/home/node/.openclaw/workspace");
    expect(overlay.agents.list[0]?.workspace).toBe("/home/node/.openclaw/workspace_main");
    expect(overlay.agents.list[0]?.agentDir).toBe("/home/node/.openclaw/agents/main/agent");
    expect(overlay.agents.list[1]?.workspace).toBe("/home/node/.openclaw/workspace/worker");
    expect(overlay.agents.list[1]?.agentDir).toBe("/home/node/custom-swarm/agents/worker");
    expect(overlay.agents.list[1]?.systemPromptOverride).toBeUndefined();
    expect(overlay.models.providers.nvidia.baseUrl).toBe("http://openclaw-sentinel:18888/v1");
    expect(overlay.plugins.slots.memory).toBe("memory-core");
    expect(overlay.plugins.entries["memory-core"]?.enabled).toBe(true);
    expect(overlay.plugins.entries["memory-wiki"]?.enabled).toBe(true);
    expect(overlay.plugins.entries["memory-wiki"]?.config).toMatchObject({
      bridge: { enabled: true, readMemoryArtifacts: true },
      obsidian: { enabled: true, openAfterWrites: false, useOfficialCli: false },
      vault: { path: "/home/node/custom-swarm/Obsidian Vault", renderMode: "obsidian" },
      vaultMode: "bridge",
    });
  });

  it("expands home-relative configured paths before writing the container overlay", () => {
    const homeDir = path.resolve("home");
    const configDir = path.join(homeDir, ".openclaw");
    const overlay = buildFullLocalContainerConfig(
      {
        agents: {
          defaults: { workspace: "~/.openclaw/workspace-main" },
          list: [
            {
              agentDir: "~/agents/main/agent",
              id: "main",
              workspace: "~/workspaces/main",
            },
          ],
        },
        plugins: {
          entries: {
            "memory-wiki": {
              config: {
                vault: { path: "~/Obsidian Vault" },
              },
            },
          },
        },
      },
      {
        configDir,
        cwd: path.resolve("repo-root"),
        extraAgentRootDir: homeDir,
        homeDir,
        workspaceDir: path.join(configDir, "workspace"),
      },
    ) as {
      agents: {
        defaults: { workspace: string };
        list: Array<{ agentDir: string; workspace: string }>;
      };
      plugins: { entries: Record<string, { config?: { vault?: { path?: string } } }> };
    };

    expect(overlay.agents.defaults.workspace).toBe("/home/node/.openclaw/workspace-main");
    expect(overlay.agents.list[0]?.agentDir).toBe(
      "/home/node/openclaw-extra-agent-root/agents/main/agent",
    );
    expect(overlay.agents.list[0]?.workspace).toBe(
      "/home/node/openclaw-extra-agent-root/workspaces/main",
    );
    expect(overlay.plugins.entries["memory-wiki"]?.config?.vault?.path).toBe(
      "/home/node/openclaw-extra-agent-root/Obsidian Vault",
    );
  });

  it("removes stale gateway tokens when trusted-proxy owns gateway auth", () => {
    const overlay = buildFullLocalContainerConfig(
      {
        gateway: {
          auth: {
            mode: "trusted-proxy",
            password: "local-password",
            token: "stale-token",
          },
        },
      },
      {
        configDir: path.resolve("home", ".openclaw"),
        cwd: path.resolve("repo-root"),
        gatewayAuthMode: "trusted-proxy",
        gatewayPassword: "local-password",
        workspaceDir: path.resolve("home", ".openclaw", "workspace"),
      },
    ) as {
      gateway: { auth: { mode: string; password?: string; token?: string } };
    };

    expect(overlay.gateway.auth.mode).toBe("trusted-proxy");
    expect(overlay.gateway.auth.password).toBe("local-password");
    expect(overlay.gateway.auth.token).toBeUndefined();
  });

  it("reuses an existing full-local overlay without rewriting it for read-only proof", async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "openclaw-full-local-readonly-"));
    try {
      const configDir = path.join(homeDir, ".openclaw");
      const overlayPath = path.join(configDir, "full-local", "openclaw.json");
      mkdirSync(path.dirname(overlayPath), { recursive: true });
      writeFileSync(overlayPath, '{"existing":true}\n');

      const runtime = await deriveFullLocalRuntime({
        config: {
          gateway: { auth: { token: "gateway-secret" } },
          models: { providers: { nvidia: { apiKey: "nvidia-secret" } } },
        },
        cwd: path.resolve("repo-root"),
        env: { OPENCLAW_CONFIG_DIR: configDir },
        homeDir,
        portAvailable: async () => true,
        writeContainerConfigOverlay: false,
      });

      expect(runtime.facts.containerConfigOverlay).toBe(true);
      expect(runtime.facts.containerConfigPathHost).toBe(overlayPath);
      expect(readFileSync(overlayPath, "utf8")).toBe('{"existing":true}\n');
    } finally {
      rmSync(homeDir, { force: true, recursive: true });
    }
  });

  it("reuses read-only proof overlays without resolving unavailable SecretRefs", async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "openclaw-full-local-readonly-secretref-"));
    try {
      const configDir = path.join(homeDir, ".openclaw");
      const overlayPath = path.join(configDir, "full-local", "openclaw.json");
      mkdirSync(path.dirname(overlayPath), { recursive: true });
      writeFileSync(overlayPath, '{"existing":true}\n');

      const runtime = await deriveFullLocalRuntime({
        config: {
          secrets: {
            providers: {
              missingfile: {
                source: "file",
                path: path.join(homeDir, "missing-secrets.json"),
                allowInsecurePath: true,
              },
            },
          },
          gateway: {
            auth: {
              token: {
                source: "file",
                provider: "missingfile",
                id: "/gateway/token",
              },
            },
          },
          models: {
            providers: {
              nvidia: {
                apiKey: {
                  source: "file",
                  provider: "missingfile",
                  id: "/nvidia/apiKey",
                },
              },
            },
          },
        },
        cwd: path.resolve("repo-root"),
        env: { OPENCLAW_CONFIG_DIR: configDir },
        homeDir,
        portAvailable: async () => true,
        writeContainerConfigOverlay: false,
      });

      expect(runtime.facts.containerConfigOverlay).toBe(true);
      expect(runtime.facts.containerConfigPathHost).toBe(overlayPath);
      expect(runtime.env.OPENCLAW_GATEWAY_TOKEN).toBeUndefined();
      expect(runtime.env.NVIDIA_API_KEY).toBeUndefined();
    } finally {
      rmSync(homeDir, { force: true, recursive: true });
    }
  });

  it("does not create a full-local overlay for read-only proof when none exists", async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "openclaw-full-local-no-overlay-"));
    try {
      const configDir = path.join(homeDir, ".openclaw");

      const runtime = await deriveFullLocalRuntime({
        config: {
          gateway: { auth: { token: "gateway-secret" } },
          models: { providers: { nvidia: { apiKey: "nvidia-secret" } } },
        },
        cwd: path.resolve("repo-root"),
        env: { OPENCLAW_CONFIG_DIR: configDir },
        homeDir,
        portAvailable: async () => true,
        writeContainerConfigOverlay: false,
      });

      expect(runtime.facts.containerConfigOverlay).toBe(false);
      expect(existsSync(path.join(configDir, "full-local", "openclaw.json"))).toBe(false);
    } finally {
      rmSync(homeDir, { force: true, recursive: true });
    }
  });

  it("rejects relative runtime paths that escape mounted full-local roots", () => {
    expect(() =>
      buildFullLocalContainerConfig(
        {
          agents: {
            defaults: {
              workspace: "../outside-workspace",
            },
          },
        },
        {
          configDir: path.resolve("repo-root", ".state"),
          cwd: path.resolve("repo-root"),
          workspaceDir: path.resolve("repo-root", "workspace"),
        },
      ),
    ).toThrow("agents.defaults.workspace is outside the mounted full-local roots");
  });

  it("keeps full-local memory command timeout above the gateway bridge timeout", () => {
    expect(
      resolveMemoryWikiCommandTimeoutMs({
        OPENCLAW_MEMORY_WIKI_GATEWAY_TIMEOUT_MS: "240000",
      }),
    ).toBe(300_000);
    expect(
      resolveMemoryWikiCommandTimeoutMs({
        OPENCLAW_FULL_LOCAL_MEMORY_COMMAND_TIMEOUT_MS: "90000",
        OPENCLAW_MEMORY_WIKI_GATEWAY_TIMEOUT_MS: "240000",
      }),
    ).toBe(300_000);
  });

  it("keeps default readiness above sidecar startup grace periods", () => {
    expect(DEFAULT_READY_TIMEOUT_MS).toBeGreaterThanOrEqual(240_000);
  });

  it("keeps default autonomy smoke timeout above slow model acknowledgement", () => {
    expect(DEFAULT_SMOKE_TIMEOUT_MS).toBeGreaterThanOrEqual(180_000);
    expect(readFileSync("scripts/docker/sidecars/signal-hub.cjs", "utf8")).toContain(
      "SWARM_SIGNAL_DISPATCH_ACK_RETRY_MS || 180000",
    );
  });

  it("retries Docker exec while sidecars are still becoming runnable", () => {
    expect(
      dockerCommandShouldRetry({
        ok: false,
        status: 1,
        stderr: "service openclaw-signal-hub is not running",
        stdout: "",
      }),
    ).toBe(true);
    expect(
      dockerCommandShouldRetry({
        ok: false,
        status: 1,
        stderr: "Error response from daemon: container is restarting",
        stdout: "",
      }),
    ).toBe(true);
  });

  it("parses Docker Compose JSON output across v2 output shapes", () => {
    expect(
      parseComposePsJson(
        [
          JSON.stringify({ Health: "healthy", Service: "openclaw-gateway", State: "running" }),
          JSON.stringify({ Health: "healthy", Service: "openclaw-sentinel", State: "running" }),
        ].join("\n"),
      ),
    ).toHaveLength(2);

    expect(
      parseComposePsJson(
        JSON.stringify([{ Health: "healthy", Service: "openclaw-gateway", State: "running" }]),
      ),
    ).toHaveLength(1);
  });

  it("parses Docker Compose published ports across host formats", () => {
    expect(parseComposePublishedPort("0.0.0.0:18889\n")).toBe("18889");
    expect(parseComposePublishedPort("[::]:18890\n")).toBe("18890");
    expect(parseComposePublishedPort("")).toBeNull();
  });

  it("requires the Sentinel model proof to echo the smoke token", () => {
    expect(
      evaluateSentinelModelProof({
        gateway: { ok: true, outputContainsSmokeToken: true },
        sentinel: { routed: true },
      }),
    ).toBe(true);
    expect(
      evaluateSentinelModelProof({
        gateway: { ok: true, outputContainsSmokeToken: false },
        sentinel: { routed: true },
      }),
    ).toBe(false);
  });

  it("requires all full-local services, Gateway readiness, Sentinel keys, and wiki status", () => {
    const proof = {
      compose: {
        services: FULL_LOCAL_SERVICES.map((service) => ({
          health: "healthy",
          name: service,
          service,
          state: "running",
        })),
      },
      endpoints: {
        gateway: { body: { ready: true }, ok: true, status: 200 },
        sentinel: { body: { keys: 68, ready: true }, ok: true, status: 200 },
      },
      wiki: {
        ok: true,
        summary: { bridgeEnabled: true, renderMode: "obsidian", vaultMode: "bridge" },
      },
    };

    expect(evaluateProof(proof).ok).toBe(true);

    const withoutKeys = {
      ...proof,
      endpoints: {
        ...proof.endpoints,
        sentinel: { body: { keys: 0, ready: false }, ok: false, status: 503 },
      },
    };
    expect(evaluateProof(withoutKeys).ok).toBe(false);

    const withoutBridge = {
      ...proof,
      wiki: {
        ok: false,
        summary: { bridgeEnabled: false, renderMode: "obsidian", vaultMode: "isolated" },
      },
    };
    expect(evaluateProof(withoutBridge).ok).toBe(false);
  });

  it("requires memory-wiki bridge plus Obsidian render mode for readiness", () => {
    expect(
      wikiSummaryReady({
        bridgeEnabled: true,
        renderMode: "obsidian",
        vaultMode: "bridge",
      }),
    ).toBe(true);
    expect(
      wikiSummaryReady({
        bridgeEnabled: true,
        renderMode: "native",
        vaultMode: "bridge",
      }),
    ).toBe(false);
    expect(
      wikiSummaryReady({
        bridgeEnabled: false,
        renderMode: "obsidian",
        vaultMode: "isolated",
      }),
    ).toBe(false);
  });

  it("retries transient readiness endpoint failures before reporting proof state", async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;

    try {
      globalThis.fetch = (async () => {
        calls += 1;
        if (calls === 1) {
          throw new Error("temporary gateway stall");
        }
        return new Response(JSON.stringify({ ready: true }), { status: 200 });
      }) as typeof fetch;

      const result = await fetchJsonWithRetries("http://127.0.0.1:18789/readyz", {
        attempts: 2,
        isReady: (value: { ok: boolean; status: number | null }) =>
          value.ok && value.status === 200,
        retryDelayMs: 0,
        timeoutMs: 50,
      });

      expect(result.status).toBe(200);
      expect(calls).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("exposes source-checkout one-command package shortcuts", () => {
    const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
      files: string[];
      scripts: Record<string, string>;
    };

    expect(packageJson.scripts["local:full"]).toBe("node scripts/docker/full-local.mjs up");
    expect(packageJson.scripts["local:full:bench"]).toBe(
      "node scripts/docker/full-local.mjs bench",
    );
    expect(packageJson.scripts["local:full:golden"]).toBe(
      "node scripts/docker/full-local.mjs golden",
    );
    expect(packageJson.scripts["local:full:memory"]).toBe(
      "node scripts/docker/full-local.mjs memory",
    );
    expect(packageJson.scripts["local:full:proof"]).toBe(
      "node scripts/docker/full-local.mjs proof",
    );
    expect(packageJson.scripts["local:full:sentinel"]).toBe(
      "node scripts/docker/full-local.mjs sentinel",
    );
    expect(packageJson.scripts["local:full:smoke"]).toBe(
      "node scripts/docker/full-local.mjs smoke",
    );
    expect(packageJson.files).toContain("scripts/docker/full-local.mjs");
    expect(packageJson.files).toContain("scripts/docker/sidecars/");
  });

  it("prints help before parsing a broken full-local config", () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "openclaw-full-local-help-"));
    try {
      const badConfig = path.join(homeDir, "openclaw.json");
      writeFileSync(badConfig, "{");

      const result = spawnSync(process.execPath, ["scripts/docker/full-local.mjs", "--help"], {
        cwd: path.resolve("."),
        encoding: "utf8",
        env: {
          ...process.env,
          OPENCLAW_CONFIG_PATH: badConfig,
        },
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Usage: node scripts/docker/full-local.mjs <command>");
    } finally {
      rmSync(homeDir, { force: true, recursive: true });
    }
  });

  it("stops the Compose stack before parsing a broken full-local config", () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "openclaw-full-local-down-"));
    const binDir = path.join(homeDir, "bin");
    try {
      mkdirSync(binDir, { recursive: true });
      const badConfig = path.join(homeDir, "openclaw.json");
      writeFileSync(badConfig, "{");
      const dockerStub = path.join(binDir, "docker-stub.cjs");
      writeFileSync(dockerStub, "process.exit(0);\n");

      const result = spawnSync(process.execPath, ["scripts/docker/full-local.mjs", "down"], {
        cwd: path.resolve("."),
        encoding: "utf8",
        env: {
          ...process.env,
          OPENCLAW_DOCKER_COMMAND: process.execPath,
          OPENCLAW_DOCKER_COMMAND_ARGS_JSON: JSON.stringify([dockerStub]),
          OPENCLAW_CONFIG_PATH: badConfig,
        },
      });

      expect(result.status, result.stderr).toBe(0);
    } finally {
      rmSync(homeDir, { force: true, recursive: true });
    }
  });
});
