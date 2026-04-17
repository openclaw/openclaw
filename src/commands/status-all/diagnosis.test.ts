import { describe, expect, it, vi } from "vitest";
import type { ProgressReporter } from "../../cli/progress.js";
import type { UpdateCheckResult } from "../../infra/update-check.js";

vi.mock("../../daemon/launchd.js", () => ({
  resolveGatewayLogPaths: () => {
    throw new Error("skip log tail");
  },
}));

vi.mock("./gateway.js", () => ({
  readFileTailLines: vi.fn(async () => []),
  summarizeLogTail: vi.fn(() => []),
}));

import { appendStatusAllDiagnosis } from "./diagnosis.js";

type DiagnosisParams = Parameters<typeof appendStatusAllDiagnosis>[0];

function createProgressReporter(): ProgressReporter {
  return {
    setLabel: () => {},
    setPercent: () => {},
    tick: () => {},
    done: () => {},
  };
}

function createBaseUpdate(partial?: Partial<UpdateCheckResult>): UpdateCheckResult {
  return {
    root: "/usr/local/lib/node_modules/openclaw",
    installKind: "package",
    packageManager: "pnpm",
    ...partial,
  };
}

function createBaseParams(
  listeners: NonNullable<DiagnosisParams["portUsage"]>["listeners"],
): DiagnosisParams {
  return {
    lines: [] as string[],
    progress: createProgressReporter(),
    muted: (text: string) => text,
    ok: (text: string) => text,
    warn: (text: string) => text,
    fail: (text: string) => text,
    connectionDetailsForReport: "ws://127.0.0.1:18789",
    snap: null,
    remoteUrlMissing: false,
    update: createBaseUpdate(),
    gatewayService: {
      label: "LaunchAgent",
      packageRoot: "/usr/local/lib/node_modules/openclaw",
      sourcePath: "/Users/test/Library/LaunchAgents/ai.openclaw.gateway.plist",
    },
    secretDiagnostics: [],
    sentinel: null,
    lastErr: null,
    port: 18789,
    portUsage: { port: 18789, status: "busy", listeners, hints: [] },
    tailscaleMode: "off",
    tailscale: {
      backendState: null,
      dnsName: null,
      ips: [],
      error: null,
    },
    tailscaleHttpsUrl: null,
    skillStatus: null,
    pluginCompatibility: [],
    channelsStatus: null,
    channelIssues: [],
    gatewayReachable: false,
    health: null,
    nodeOnlyGateway: null,
  };
}

describe("status-all diagnosis install-state checks", () => {
  it("surfaces suspicious runtime roots and service mismatches", async () => {
    const params = createBaseParams([]);
    params.update = createBaseUpdate({
      root: "/Users/test/workspace/tmp/openclaw-src",
      installKind: "git",
      installState: {
        activeRoot: "/Users/test/workspace/tmp/openclaw-src",
        resolvedRoot: "/Users/test/workspace/tmp/openclaw-src",
        rootIsSymlink: false,
        suspicious: true,
        reasons: ["active package root resolves into a restore/tmp-like path"],
        recoveryHint:
          "Reinstall or relink to the intended package root, restart the gateway service, then rerun status.",
      },
    });

    await appendStatusAllDiagnosis(params);

    const output = params.lines.join("\n");
    expect(output).toContain("! Install state integrity");
    expect(output).toContain("active root: /Users/test/workspace/tmp/openclaw-src");
    expect(output).toContain("LaunchAgent package root: /usr/local/lib/node_modules/openclaw");
    expect(output).toContain(
      "drift risk: active package root resolves into a restore/tmp-like path",
    );
    expect(output).toContain("drift risk: service package root does not match active runtime root");
    expect(output).toContain("Reinstall or relink to the intended package root");
  });

  it("keeps install state healthy when runtime and service roots agree", async () => {
    const params = createBaseParams([]);

    await appendStatusAllDiagnosis(params);

    const output = params.lines.join("\n");
    expect(output).toContain("✓ Install state integrity");
    expect(output).not.toContain("drift risk:");
  });
});

describe("status-all diagnosis port checks", () => {
  it("treats gateway-owned local listeners as healthy", async () => {
    const params = createBaseParams([
      { pid: 5001, commandLine: "openclaw-gateway", address: "127.0.0.1:18789" },
      { pid: 5001, commandLine: "openclaw-gateway", address: "[::1]:18789" },
    ]);

    await appendStatusAllDiagnosis(params);

    const output = params.lines.join("\n");
    expect(output).toContain("✓ Port 18789");
    expect(output).toContain(
      "Detected the local OpenClaw gateway listening on its configured port.",
    );
    expect(output).not.toContain("Port 18789 is already in use.");
  });

  it("keeps warning for multi-process listener conflicts", async () => {
    const params = createBaseParams([
      { pid: 5001, commandLine: "python -m http.server", address: "127.0.0.1:18789" },
      { pid: 5002, commandLine: "nc -lk 18789", address: "[::1]:18789" },
    ]);

    await appendStatusAllDiagnosis(params);

    const output = params.lines.join("\n");
    expect(output).toContain("! Port 18789");
    expect(output).toContain("Port 18789 is already in use.");
  });

  it("keeps warning for multi-process gateway listener conflicts", async () => {
    const params = createBaseParams([
      { pid: 5001, commandLine: "openclaw-gateway", address: "127.0.0.1:18789" },
      { pid: 5002, commandLine: "openclaw-gateway", address: "[::1]:18789" },
    ]);

    await appendStatusAllDiagnosis(params);

    const output = params.lines.join("\n");
    expect(output).toContain("! Port 18789");
    expect(output).toContain("Port 18789 is already in use.");
    expect(output).not.toContain(
      "Detected the local OpenClaw gateway listening on its configured port.",
    );
  });

  it("avoids unreachable gateway diagnosis in node-only mode", async () => {
    const params = createBaseParams([]);
    params.connectionDetailsForReport = [
      "Node-only mode detected",
      "Local gateway: not expected on this machine",
      "Remote gateway target: gateway.example.com:19000",
    ].join("\n");
    params.tailscale.backendState = "Running";
    params.health = undefined;
    params.nodeOnlyGateway = {
      gatewayTarget: "gateway.example.com:19000",
      gatewayValue: "node → gateway.example.com:19000 · no local gateway",
      connectionDetails: [
        "Node-only mode detected",
        "Local gateway: not expected on this machine",
        "Remote gateway target: gateway.example.com:19000",
        "Inspect the remote gateway host for live channel and health details.",
      ].join("\n"),
    };

    await appendStatusAllDiagnosis(params);

    const output = params.lines.join("\n");
    expect(output).toContain("Node-only mode detected");
    expect(output).toContain(
      "Channel issues skipped (node-only mode; query gateway.example.com:19000)",
    );
    expect(output).not.toContain("Channel issues skipped (gateway unreachable)");
    expect(output).not.toContain("Gateway health:");
  });
});
