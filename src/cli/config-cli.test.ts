import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfigFileSnapshot, OpenClawConfig } from "../config/types.js";

/**
 * Test for issue #6070:
 * `openclaw config set/unset` must update snapshot.resolved (user config after $include/${ENV},
 * but before runtime defaults), so runtime defaults don't leak into the written config.
 */

const mockReadConfigFileSnapshot = vi.fn<[], Promise<ConfigFileSnapshot>>();
const mockWriteConfigFile = vi.fn<[OpenClawConfig], Promise<void>>(async () => {});

vi.mock("../config/config.js", () => ({
  readConfigFileSnapshot: () => mockReadConfigFileSnapshot(),
  writeConfigFile: (cfg: OpenClawConfig) => mockWriteConfigFile(cfg),
}));

const mockLog = vi.fn();
const mockError = vi.fn();
const mockExit = vi.fn((code: number) => {
  const errorMessages = mockError.mock.calls.map((c) => c.join(" ")).join("; ");
  throw new Error(`__exit__:${code} - ${errorMessages}`);
});

vi.mock("../runtime.js", () => ({
  defaultRuntime: {
    log: (...args: unknown[]) => mockLog(...args),
    error: (...args: unknown[]) => mockError(...args),
    exit: (code: number) => mockExit(code),
  },
}));

function buildSnapshot(params: {
  resolved: OpenClawConfig;
  config: OpenClawConfig;
}): ConfigFileSnapshot {
  return {
    path: "/tmp/openclaw.json",
    exists: true,
    raw: JSON.stringify(params.resolved),
    parsed: params.resolved,
    resolved: params.resolved,
    valid: true,
    config: params.config,
    issues: [],
    warnings: [],
    legacyIssues: [],
  };
}

describe("config cli", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("config set - issue #6070", () => {
    it("preserves existing config keys when setting a new value", async () => {
      const resolved: OpenClawConfig = {
        agents: {
          list: [{ id: "main" }, { id: "oracle", workspace: "~/oracle-workspace" }],
        },
        gateway: { port: 18789 },
        tools: { allow: ["group:fs"] },
        logging: { level: "debug" },
      };
      const runtimeMerged: OpenClawConfig = {
        ...resolved,
        agents: {
          ...resolved.agents,
          defaults: {
            model: "gpt-5.2",
          } as never,
        } as never,
      };
      mockReadConfigFileSnapshot.mockResolvedValueOnce(
        buildSnapshot({ resolved, config: runtimeMerged }),
      );

      const { registerConfigCli } = await import("./config-cli.js");
      const program = new Command();
      program.exitOverride();
      registerConfigCli(program);

      await program.parseAsync(["config", "set", "gateway.auth.mode", "token"], { from: "user" });

      expect(mockWriteConfigFile).toHaveBeenCalledTimes(1);
      const written = mockWriteConfigFile.mock.calls[0]?.[0];
      expect(written.gateway?.auth).toEqual({ mode: "token" });
      expect(written.gateway?.port).toBe(18789);
      expect(written.agents).toEqual(resolved.agents);
      expect(written.tools).toEqual(resolved.tools);
      expect(written.logging).toEqual(resolved.logging);
      expect(written.agents).not.toHaveProperty("defaults");
    });

    it("does not inject runtime defaults into the written config", async () => {
      const resolved: OpenClawConfig = {
        gateway: { port: 18789 },
      };
      const runtimeMerged: OpenClawConfig = {
        ...resolved,
        agents: {
          defaults: {
            model: "gpt-5.2",
            contextWindow: 128_000,
            maxTokens: 16_000,
          },
        } as never,
        messages: { ackReaction: "✅" } as never,
        sessions: { persistence: { enabled: true } } as never,
      };
      mockReadConfigFileSnapshot.mockResolvedValueOnce(
        buildSnapshot({ resolved, config: runtimeMerged }),
      );

      const { registerConfigCli } = await import("./config-cli.js");
      const program = new Command();
      program.exitOverride();
      registerConfigCli(program);

      await program.parseAsync(["config", "set", "gateway.auth.mode", "token"], { from: "user" });

      expect(mockWriteConfigFile).toHaveBeenCalledTimes(1);
      const written = mockWriteConfigFile.mock.calls[0]?.[0];
      expect(written).not.toHaveProperty("agents.defaults.model");
      expect(written).not.toHaveProperty("agents.defaults.contextWindow");
      expect(written).not.toHaveProperty("agents.defaults.maxTokens");
      expect(written).not.toHaveProperty("messages.ackReaction");
      expect(written).not.toHaveProperty("sessions.persistence");
      expect(written.gateway?.port).toBe(18789);
      expect(written.gateway?.auth).toEqual({ mode: "token" });
    });
  });

  describe("config unset - issue #6070", () => {
    it("preserves existing config keys when unsetting a value", async () => {
      const resolved: OpenClawConfig = {
        agents: { list: [{ id: "main" }] },
        gateway: { port: 18789 },
        tools: {
          profile: "coding",
          alsoAllow: ["agents_list"],
        },
        logging: { level: "debug" },
      };
      const runtimeMerged: OpenClawConfig = {
        ...resolved,
        agents: {
          ...resolved.agents,
          defaults: {
            model: "gpt-5.2",
          },
        } as never,
      };
      mockReadConfigFileSnapshot.mockResolvedValueOnce(
        buildSnapshot({ resolved, config: runtimeMerged }),
      );

      const { registerConfigCli } = await import("./config-cli.js");
      const program = new Command();
      program.exitOverride();
      registerConfigCli(program);

      await program.parseAsync(["config", "unset", "tools.alsoAllow"], { from: "user" });

      expect(mockWriteConfigFile).toHaveBeenCalledTimes(1);
      const written = mockWriteConfigFile.mock.calls[0]?.[0];
      expect(written.tools).not.toHaveProperty("alsoAllow");
      expect(written.agents).not.toHaveProperty("defaults");
      expect(written.agents?.list).toEqual(resolved.agents?.list);
      expect(written.gateway).toEqual(resolved.gateway);
      expect(written.tools?.profile).toBe("coding");
      expect(written.logging).toEqual(resolved.logging);
    });
  });
});
