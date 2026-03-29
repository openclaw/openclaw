import { describe, expect, it, vi } from "vitest";
import type { ProgressReporter } from "../../cli/progress.js";

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
  };
}

describe("status-all diagnosis port checks", () => {
  it("treats same-process dual-stack loopback listeners as healthy", async () => {
    const params = createBaseParams([
      { pid: 5001, commandLine: "openclaw-gateway", address: "127.0.0.1:18789" },
      { pid: 5001, commandLine: "openclaw-gateway", address: "[::1]:18789" },
    ]);

    await appendStatusAllDiagnosis(params);

    const output = params.lines.join("\n");
    expect(output).toContain("✓ Port 18789");
    expect(output).toContain("Detected dual-stack loopback listeners");
    expect(output).not.toContain("Port 18789 is already in use.");
  });

  it("keeps warning for multi-process listener conflicts", async () => {
    const params = createBaseParams([
      { pid: 5001, commandLine: "openclaw-gateway", address: "127.0.0.1:18789" },
      { pid: 5002, commandLine: "openclaw-gateway", address: "[::1]:18789" },
    ]);

    await appendStatusAllDiagnosis(params);

    const output = params.lines.join("\n");
    expect(output).toContain("! Port 18789");
    expect(output).toContain("Port 18789 is already in use.");
  });
});
