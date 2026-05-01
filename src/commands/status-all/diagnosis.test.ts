import { describe, expect, it, vi } from "vitest";
import type { ProgressReporter } from "../../cli/progress.js";

vi.mock("../../daemon/restart-logs.js", () => ({
  resolveGatewayLogPaths: () => {
    throw new Error("skip log tail");
  },
  resolveGatewayRestartLogPath: () => "/tmp/gateway-restart.log",
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
    deliveryDiagnostics: null,
    gatewayReachable: false,
    health: null,
    nodeOnlyGateway: null,
  };
}

describe("status-all diagnosis port checks", () => {
  it("labels OpenClaw Tailscale exposure separately from daemon state", async () => {
    const params = createBaseParams([]);
    params.tailscale.backendState = "Running";
    params.tailscale.dnsName = "box.tail.ts.net";

    await appendStatusAllDiagnosis(params);

    const output = params.lines.join("\n");
    expect(output).toContain("✓ Tailscale exposure: off · daemon Running · box.tail.ts.net");
    expect(output).not.toContain("Tailscale: off");
  });

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
    expect(output).toContain("2 OpenClaw gateway processes appear to be listening on port 18789");
    expect(output).toContain("Port 18789 is already in use.");
  });

  it("emits a soft warning when no agent sessions were active in the last 30m", async () => {
    const params = createBaseParams([]);
    params.agentStatus = {
      totalSessions: 2,
      agents: [
        { id: "main", lastActiveAgeMs: 31 * 60_000 },
        { id: "worker", lastActiveAgeMs: null },
      ],
    };

    await appendStatusAllDiagnosis(params);

    const output = params.lines.join("\n");
    expect(output).toContain("! Agent activity: 0 active in 30m · 2 sessions");
    expect(output).toContain("verify inbound dispatch and turn creation");
  });

  it("keeps agent activity healthy when a session was recently updated", async () => {
    const params = createBaseParams([]);
    params.agentStatus = {
      totalSessions: 2,
      agents: [
        { id: "main", lastActiveAgeMs: 5 * 60_000 },
        { id: "worker", lastActiveAgeMs: 45 * 60_000 },
      ],
    };

    await appendStatusAllDiagnosis(params);

    const output = params.lines.join("\n");
    expect(output).toContain("✓ Agent activity: 1 active in 30m · 2 sessions");
    expect(output).not.toContain("verify inbound dispatch and turn creation");
  });

  it("summarizes inbound delivery telemetry proof counters", async () => {
    const params = createBaseParams([]);
    params.gatewayReachable = true;
    params.deliveryDiagnostics = {
      summary: {
        byType: {
          "message.received": 2,
          "message.dispatch.started": 2,
          "message.dispatch.completed": 2,
          "session.turn.created": 2,
          "message.processed": 2,
        },
      },
      events: [{ type: "session.turn.created", ts: Date.now() - 60_000 }],
    };

    await appendStatusAllDiagnosis(params);

    const output = params.lines.join("\n");
    expect(output).toContain(
      "✓ Inbound delivery telemetry: received 2 · dispatch 2/2 · turns 2 · processed 2",
    );
    expect(output).toContain("latest delivery event:");
  });

  it("warns when received messages never reach agent turn creation", async () => {
    const params = createBaseParams([]);
    params.gatewayReachable = true;
    params.deliveryDiagnostics = {
      summary: {
        byType: {
          "message.received": 3,
          "message.dispatch.started": 3,
          "message.dispatch.completed": 1,
          "session.turn.created": 0,
          "message.processed": 1,
        },
      },
      events: [{ type: "message.dispatch.started", ts: Date.now() - 120_000 }],
    };

    await appendStatusAllDiagnosis(params);

    const output = params.lines.join("\n");
    expect(output).toContain(
      "! Inbound delivery telemetry: received 3 · dispatch 3/1 · turns 0 · processed 1",
    );
    expect(output).toContain("Gateway dispatch started, but no agent turn was created");
    expect(output).toContain("Multiple gateway dispatches have not completed yet");
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
    params.gatewayReachable = true;

    await appendStatusAllDiagnosis(params);

    const output = params.lines.join("\n");
    expect(output).toContain("Node-only mode detected");
    expect(output).toContain(
      "Channel issues skipped (node-only mode; query gateway.example.com:19000)",
    );
    expect(output).not.toContain("Channel issues skipped (gateway unreachable)");
    expect(output).not.toContain("Gateway health:");
    expect(output).not.toContain("Inbound delivery telemetry: unavailable");
  });
});
