import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConfigFileSnapshot, OpenClawConfig } from "../config/config.js";
import {
  formatCrestodianOverview,
  formatCrestodianStartupMessage,
  loadCrestodianOverview,
} from "./overview.js";

function buildConfigSnapshot(runtimeConfig: OpenClawConfig): ConfigFileSnapshot {
  return {
    path: "/tmp/openclaw.json",
    exists: true,
    raw: "{}",
    parsed: runtimeConfig,
    sourceConfig: runtimeConfig,
    resolved: runtimeConfig,
    valid: true,
    runtimeConfig,
    config: runtimeConfig,
    hash: "test-hash",
    issues: [],
    warnings: [],
    legacyIssues: [],
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("loadCrestodianOverview", () => {
  it("summarizes config, agents, model, tools, and gateway", async () => {
    const runtimeConfig: OpenClawConfig = {
      agents: {
        defaults: { model: { primary: "openai/gpt-5.2" } },
        list: [
          { id: "main", default: true },
          { id: "work", name: "Work" },
        ],
      },
      gateway: { port: 19001 },
    };
    const snapshot = buildConfigSnapshot(runtimeConfig);
    const overview = await loadCrestodianOverview({
      env: { OPENCLAW_TEST_FAST: "1" },
      deps: {
        readConfigFileSnapshot: async () => snapshot,
        resolveConfigPath: () => "/tmp/openclaw.json",
        resolveGatewayPort: (cfg) => cfg?.gateway?.port ?? 8765,
        buildGatewayConnectionDetails: (input) => ({
          url: `wss://gateway.example.test:${input.config.gateway?.port ?? 8765}`,
          urlSource: "remote config",
        }),
        probeLocalCommand: async (command) => ({
          command,
          found: command === "codex",
          version: command === "codex" ? "codex 1.0.0" : undefined,
        }),
        probeGatewayUrl: async (url) => ({ reachable: false, url, error: "offline" }),
      },
    });

    expect(overview.config.exists).toBe(true);
    expect(overview.config.valid).toBe(true);
    expect(overview.defaultAgentId).toBe("main");
    expect(overview.defaultModel).toBe("openai/gpt-5.2");
    expect(overview.agents.map((agent) => agent.id)).toEqual(["main", "work"]);
    expect(overview.tools.codex.found).toBe(true);
    expect(overview.tools.claude.found).toBe(false);
    expect(overview.gateway.url).toBe("wss://gateway.example.test:19001");
    expect(overview.gateway.reachable).toBe(false);
    expect(overview.references.docsPath).toMatch(/docs$/);
    expect(overview.references.sourceUrl).toBe("https://github.com/openclaw/openclaw");
    expect(formatCrestodianOverview(overview)).toContain(
      'Next: run "gateway status" or "restart gateway"',
    );
    const startup = formatCrestodianStartupMessage(overview);
    expect(startup).toContain("## Hi, I'm Crestodian.");
    expect(startup).toContain("Using: openai/gpt-5.2");
    expect(startup).toContain("Gateway: not reachable");
    expect(startup).toContain("I can start debugging with `gateway status`");
    expect(startup).not.toContain("Codex:");
    expect(startup).not.toContain("Claude Code:");
    expect(startup).not.toContain("API keys:");
  });

  it.each(["ws://127.0.0.1:19001", "ws://127.0.1.1:19001", "ws://[::ffff:127.0.0.1]:19001"])(
    "retries a local gateway startup probe before reporting the banner status for %s",
    async (gatewayUrl) => {
      vi.useFakeTimers();
      const runtimeConfig: OpenClawConfig = {
        agents: {
          defaults: { model: { primary: "openai/gpt-5.2" } },
          list: [{ id: "main", default: true }],
        },
        gateway: { port: 19001 },
      };
      const snapshot = buildConfigSnapshot(runtimeConfig);
      const probeGatewayUrl = vi
        .fn(
          async (
            url: string,
            _opts?: { timeoutMs?: number },
          ): Promise<{ reachable: boolean; url: string; error?: string }> => ({
            reachable: false,
            url,
            error: "starting",
          }),
        )
        .mockResolvedValueOnce({
          reachable: false,
          url: gatewayUrl,
          error: "This operation was aborted",
        })
        .mockResolvedValueOnce({ reachable: true, url: gatewayUrl });

      const overviewPromise = loadCrestodianOverview({
        env: { OPENCLAW_TEST_FAST: "1" },
        deps: {
          readConfigFileSnapshot: async () => snapshot,
          resolveConfigPath: () => "/tmp/openclaw.json",
          buildGatewayConnectionDetails: () => ({
            url: gatewayUrl,
            urlSource: "local loopback",
          }),
          probeLocalCommand: async (command) => ({
            command,
            found: true,
            version: `${command} 1.0.0`,
          }),
          probeGatewayUrl,
        },
      });

      await vi.advanceTimersByTimeAsync(1_000);
      const overview = await overviewPromise;

      expect(probeGatewayUrl).toHaveBeenCalledTimes(2);
      expect(probeGatewayUrl).toHaveBeenNthCalledWith(2, gatewayUrl, {
        timeoutMs: 1_500,
      });
      expect(overview.gateway.reachable).toBe(true);
      expect(formatCrestodianStartupMessage(overview)).toContain("Gateway: reachable");
    },
  );

  it("does not retry fast local gateway failures", async () => {
    const runtimeConfig: OpenClawConfig = {
      agents: {
        defaults: { model: { primary: "openai/gpt-5.2" } },
        list: [{ id: "main", default: true }],
      },
      gateway: { port: 19001 },
    };
    const snapshot = buildConfigSnapshot(runtimeConfig);
    const probeGatewayUrl = vi.fn(
      async (url: string): Promise<{ reachable: boolean; url: string; error?: string }> => ({
        reachable: false,
        url,
        error: "fetch failed",
      }),
    );

    const overview = await loadCrestodianOverview({
      env: { OPENCLAW_TEST_FAST: "1" },
      deps: {
        readConfigFileSnapshot: async () => snapshot,
        resolveConfigPath: () => "/tmp/openclaw.json",
        buildGatewayConnectionDetails: () => ({
          url: "ws://127.0.0.1:19001",
          urlSource: "local loopback",
        }),
        probeLocalCommand: async (command) => ({
          command,
          found: true,
          version: `${command} 1.0.0`,
        }),
        probeGatewayUrl,
      },
    });

    expect(probeGatewayUrl).toHaveBeenCalledTimes(1);
    expect(overview.gateway.reachable).toBe(false);
  });

  it("does not retry remote gateway probes", async () => {
    const runtimeConfig: OpenClawConfig = {
      agents: {
        defaults: { model: { primary: "openai/gpt-5.2" } },
        list: [{ id: "main", default: true }],
      },
      gateway: { port: 443 },
    };
    const snapshot = buildConfigSnapshot(runtimeConfig);
    const probeGatewayUrl = vi.fn(
      async (url: string): Promise<{ reachable: boolean; url: string; error?: string }> => ({
        reachable: false,
        url,
        error: "offline",
      }),
    );

    const overview = await loadCrestodianOverview({
      env: { OPENCLAW_TEST_FAST: "1" },
      deps: {
        readConfigFileSnapshot: async () => snapshot,
        resolveConfigPath: () => "/tmp/openclaw.json",
        buildGatewayConnectionDetails: () => ({
          url: "wss://gateway.example.test",
          urlSource: "remote config",
        }),
        probeLocalCommand: async (command) => ({
          command,
          found: true,
          version: `${command} 1.0.0`,
        }),
        probeGatewayUrl,
      },
    });

    expect(probeGatewayUrl).toHaveBeenCalledTimes(1);
    expect(overview.gateway.reachable).toBe(false);
  });
});
