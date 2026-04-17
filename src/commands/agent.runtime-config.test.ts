import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withTempHome as withTempHomeBase } from "../../test/helpers/temp-home.js";
import { resolveAgentRuntimeConfig } from "../agents/agent-runtime-config.js";
import { resolveSession } from "../agents/command/session.js";
import * as commandConfigResolutionRuntimeModule from "../cli/command-config-resolution.runtime.js";
import * as configIoModule from "../config/io.js";
import * as runtimeSnapshotModule from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { RuntimeEnv } from "../runtime.js";

const runtime: RuntimeEnv = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(() => {
    throw new Error("exit");
  }),
};

const configSpy = vi.spyOn(configIoModule, "loadConfig");
const readConfigFileSnapshotForWriteSpy = vi.spyOn(
  configIoModule,
  "readConfigFileSnapshotForWrite",
);

async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  return withTempHomeBase(fn, { prefix: "openclaw-agent-" });
}

function mockConfig(home: string, storePath: string): OpenClawConfig {
  const cfg = {
    agents: {
      defaults: {
        model: { primary: "anthropic/claude-opus-4-6" },
        models: { "anthropic/claude-opus-4-6": {} },
        workspace: path.join(home, "openclaw"),
      },
    },
    session: { store: storePath, mainKey: "main" },
  } as OpenClawConfig;
  configSpy.mockReturnValue(cfg);
  return cfg;
}

beforeEach(() => {
  vi.clearAllMocks();
  runtimeSnapshotModule.clearRuntimeConfigSnapshot();
  readConfigFileSnapshotForWriteSpy.mockResolvedValue({
    snapshot: { valid: false, resolved: {} as OpenClawConfig },
    writeOptions: {},
  } as Awaited<ReturnType<typeof configIoModule.readConfigFileSnapshotForWrite>>);
});

describe("agentCommand runtime config", () => {
  it("sets runtime snapshots from source config before embedded agent run", async () => {
    await withTempHome(async (home) => {
      const setRuntimeConfigSnapshotSpy = vi.spyOn(
        runtimeSnapshotModule,
        "setRuntimeConfigSnapshot",
      );

      const store = path.join(home, "sessions.json");
      const loadedConfig = {
        agents: {
          defaults: {
            model: { primary: "anthropic/claude-opus-4-6" },
            models: { "anthropic/claude-opus-4-6": {} },
            workspace: path.join(home, "openclaw"),
          },
        },
        session: { store, mainKey: "main" },
        models: {
          providers: {
            openai: {
              baseUrl: "https://api.openai.com/v1",
              apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" }, // pragma: allowlist secret
              models: [],
            },
          },
        },
      } as unknown as OpenClawConfig;
      const sourceConfig = {
        ...loadedConfig,
        models: {
          providers: {
            openai: {
              baseUrl: "https://api.openai.com/v1",
              apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" }, // pragma: allowlist secret
              models: [],
            },
          },
        },
      } as unknown as OpenClawConfig;
      const resolvedConfig = {
        ...loadedConfig,
        models: {
          providers: {
            openai: {
              baseUrl: "https://api.openai.com/v1",
              apiKey: "sk-resolved-runtime", // pragma: allowlist secret
              models: [],
            },
          },
        },
      } as unknown as OpenClawConfig;

      configSpy.mockReturnValue(loadedConfig);
      readConfigFileSnapshotForWriteSpy.mockResolvedValue({
        snapshot: { valid: true, resolved: sourceConfig },
        writeOptions: {},
      } as Awaited<ReturnType<typeof configIoModule.readConfigFileSnapshotForWrite>>);
      const resolveConfigWithSecretsSpy = vi
        .spyOn(commandConfigResolutionRuntimeModule, "resolveCommandConfigWithSecrets")
        .mockResolvedValueOnce({
          resolvedConfig,
          effectiveConfig: resolvedConfig,
          diagnostics: [],
        });

      const prepared = await resolveAgentRuntimeConfig(runtime);

      expect(resolveConfigWithSecretsSpy).toHaveBeenCalledWith({
        config: loadedConfig,
        commandName: "agent",
        targetIds: expect.objectContaining({
          has: expect.any(Function),
        }),
        runtime,
      });
      const targetIds = resolveConfigWithSecretsSpy.mock.calls[0]?.[0].targetIds;
      expect(targetIds.has("models.providers.*.apiKey")).toBe(true);
      expect(targetIds.has("channels.telegram.botToken")).toBe(false);
      expect(setRuntimeConfigSnapshotSpy).toHaveBeenCalledWith(resolvedConfig, sourceConfig);
      expect(prepared.cfg).toBe(resolvedConfig);
    });
  });

  it("includes channel secret targets when delivery is requested", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      const loadedConfig = mockConfig(home, store);
      loadedConfig.channels = {
        telegram: {
          botToken: { source: "env", provider: "default", id: "TELEGRAM_BOT_TOKEN" },
        },
      } as unknown as OpenClawConfig["channels"];
      const resolveConfigWithSecretsSpy = vi
        .spyOn(commandConfigResolutionRuntimeModule, "resolveCommandConfigWithSecrets")
        .mockResolvedValueOnce({
          resolvedConfig: loadedConfig,
          effectiveConfig: loadedConfig,
          diagnostics: [],
        });

      await resolveAgentRuntimeConfig(runtime, {
        runtimeTargetsChannelSecrets: true,
      });

      const targetIds = resolveConfigWithSecretsSpy.mock.calls[0]?.[0].targetIds;
      expect(targetIds.has("channels.telegram.botToken")).toBe(true);
    });
  });

  it("skips command secret resolution when no relevant SecretRef values exist", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      const loadedConfig = mockConfig(home, store);
      const resolveConfigWithSecretsSpy = vi.spyOn(
        commandConfigResolutionRuntimeModule,
        "resolveCommandConfigWithSecrets",
      );

      const prepared = await resolveAgentRuntimeConfig(runtime);

      expect(resolveConfigWithSecretsSpy).not.toHaveBeenCalled();
      expect(prepared.cfg).toBe(loadedConfig);
    });
  });

  it("derives a fresh session from --to", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      const cfg = mockConfig(home, store);

      const resolved = resolveSession({ cfg, to: "+1555" });

      expect(resolved.storePath).toBe(store);
      expect(resolved.sessionKey).toBeTruthy();
      expect(resolved.sessionId).toBeTruthy();
      expect(resolved.isNewSession).toBe(true);
    });
  });
});
