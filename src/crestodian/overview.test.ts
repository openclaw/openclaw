// Crestodian overview tests cover summary output for rescue diagnostics.
import { describe, expect, it, vi } from "vitest";
import type { ConfigFileSnapshot, OpenClawConfig } from "../config/config.js";
import {
  formatCrestodianOverview,
  formatCrestodianStartupMessage,
  loadCrestodianOverview,
} from "./overview.js";

describe("loadCrestodianOverview", () => {
  it("probes configured SSH remote Gateways through a managed loopback tunnel", async () => {
    const runtimeConfig: OpenClawConfig = {
      gateway: {
        mode: "remote",
        remote: {
          url: "ws://203.0.113.10:18789",
          sshTarget: "user@gateway.example",
        },
      },
    };
    const snapshot: ConfigFileSnapshot = {
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
    const stopTunnel = vi.fn(async () => undefined);
    const buildGatewayConnectionDetails = vi.fn(
      (input: {
        config: OpenClawConfig;
        configPath: string;
        allowConfiguredSshTransport?: boolean;
      }) => {
        if (input.allowConfiguredSshTransport !== true) {
          throw new Error("missing configured SSH allowance");
        }
        return {
          url: "ws://203.0.113.10:18789",
          urlSource: "config gateway.remote.url",
        };
      },
    );
    const startGatewayRemoteSshTunnel = vi.fn(async () => ({
      url: "ws://127.0.0.1:41001",
      urlSource: "ssh tunnel",
      tunnel: {
        parsedTarget: { host: "gateway.example", port: 22, user: "user" },
        localPort: 41001,
        remotePort: 18789,
        pid: 12345,
        stderr: [],
        stop: stopTunnel,
      },
    }));
    const probeGatewayUrl = vi.fn(async (url: string) => ({ reachable: true, url }));

    const overview = await loadCrestodianOverview({
      env: { OPENCLAW_TEST_FAST: "1" },
      deps: {
        readConfigFileSnapshot: async () => snapshot,
        buildGatewayConnectionDetails,
        startGatewayRemoteSshTunnel,
        probeGatewayUrl,
        probeLocalCommand: async (command) => ({ command, found: false }),
      },
    });

    expect(buildGatewayConnectionDetails).toHaveBeenCalledWith({
      config: runtimeConfig,
      configPath: "/tmp/openclaw.json",
      allowConfiguredSshTransport: true,
    });
    expect(startGatewayRemoteSshTunnel).toHaveBeenCalledWith({
      config: runtimeConfig,
      url: "ws://203.0.113.10:18789",
      urlSource: "config gateway.remote.url",
    });
    expect(probeGatewayUrl).toHaveBeenCalledWith("ws://127.0.0.1:41001");
    expect(stopTunnel).toHaveBeenCalledTimes(1);
    expect(overview.gateway).toMatchObject({
      url: "ws://127.0.0.1:41001",
      source: "ssh tunnel",
      reachable: true,
    });
  });

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
    const snapshot: ConfigFileSnapshot = {
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
    const overview = await loadCrestodianOverview({
      env: { OPENCLAW_TEST_FAST: "1" },
      deps: {
        readConfigFileSnapshot: async () => snapshot,
        resolveConfigPath: () => "/tmp/openclaw.json",
        resolveGatewayPort: (cfg) => cfg?.gateway?.port ?? 8765,
        buildGatewayConnectionDetails: (input) => ({
          url: `ws://127.0.0.1:${input.config.gateway?.port ?? 8765}`,
          urlSource: "local loopback",
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
    expect(overview.gateway.url).toBe("ws://127.0.0.1:19001");
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
});
