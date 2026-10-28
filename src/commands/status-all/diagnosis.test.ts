import fs from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { createStatusHealth, createStatusScanResultFixture } from "../status.test-support.ts";
import { createTestConfigSnapshot } from "../test-runtime-config-helpers.js";
import {
  mocks,
  runStatusAllReport,
  reportText,
  expectReport,
  setupStatusAllReportTest,
} from "./report-data.test-support.js";

function availableDiagnostics(value: unknown) {
  return { ok: true as const, value };
}

describe("statusAllCommand diagnosis", () => {
  setupStatusAllReportTest();

  it("keeps first config issue locations and exact pairs before applying the display cap", async () => {
    const first = { path: "a", message: "b:c", sourceFile: "legacy.json", line: 7 };
    const repeated = { ...first, sourceFile: "current.json", line: 9 };
    const snapshot = {
      ...createTestConfigSnapshot({}),
      exists: true,
      valid: false,
      path: "config.json",
      legacyIssues: [first, { path: "a:b", message: "c" }, first],
      issues: [
        repeated,
        { path: "a", message: "different" },
        ...Array.from({ length: 11 }, (_, index) => ({
          path: `field${index}`,
          message: "invalid",
        })),
        repeated,
      ],
    };
    const original = structuredClone(snapshot);

    mocks.readConfigFileSnapshot.mockResolvedValueOnce(snapshot);
    const lines = await runStatusAllReport();

    const start = lines.indexOf("! Config: config.json");
    const end = lines.indexOf("✓ Secret diagnostics (0)");
    expect(lines.slice(start, end)).toEqual([
      "! Config: config.json",
      "  - legacy.json:7 — a: b:c",
      "  - a:b: c",
      "  - a: different",
      ...Array.from({ length: 9 }, (_, index) => `  - field${index}: invalid`),
      "  … +2 more",
    ]);
    expect(snapshot).toEqual(original);
  });

  it("retains queue warnings from a successful gateway health snapshot", async () => {
    mocks.resolveStatusGatewayHealthSafe.mockResolvedValueOnce({
      ...createStatusHealth(),
      deliveryQueues: {
        failed: [{ queueName: "outbound", count: 2 }],
        ingressPressure: [
          {
            channelId: "telegram",
            accountId: "ops",
            laneCount: 1,
            pendingCount: 2,
            claimedCount: 0,
            blockedCount: 1,
            oldestReceivedAt: Date.now(),
          },
        ],
      },
    });

    const output = await reportText();
    expectReport(output, [
      "Delivery queue: warning",
      "outbound: 2",
      "inbound telegram/ops: 1 pressured lane, 2 pending, 0 claimed, 1 blocked",
    ]);
  });

  it("keeps a failed health request visible in the complete report", async () => {
    mocks.resolveStatusGatewayHealthSafe.mockResolvedValueOnce({
      error: "health request timed out",
    });

    const output = await reportText();
    expectReport(output, [
      "Gateway health:\n  health request timed out",
      "Pasteable debug report. Auth tokens redacted.",
    ]);
  });

  it("strips terminal controls from channel issues in the diagnostic report", async () => {
    // Hostile channel runtime data must not reach the operator's Diagnosis line.
    const lines = await runStatusAllReport({
      overview: {
        channelsStatus: {},
        channelIssues: [
          {
            channel: "evil\u0007channel",
            accountId: "acct\u0007",
            kind: "runtime",
            message: "gateway\u0007 down",
            fix: "restart\u0007",
          },
        ],
      },
    });

    const output = lines.join("\n");
    expect(output).toContain("Channel issues (1)");
    // stripAnsi keeps BEL (0x07), so its absence proves the sanitizer ran.
    expect(output).not.toContain("\u0007");
    expect(output).toContain("evilchannel[acct] runtime: gateway down · fix: restart");
  });

  it("keeps DNS context while daemon state remains unobserved", async () => {
    const output = await reportText({ overview: { tailscaleDns: "box.tail.ts.net" } });
    expectReport(
      output,
      ["✓ Tailscale exposure: off · daemon unknown · box.tail.ts.net"],
      ["Tailscale: off"],
    );
  });

  it.each([
    {
      name: "same-process dual-stack loopback",
      listeners: [
        [5001, "127.0.0.1:18789"],
        [5001, "[::1]:18789"],
      ],
      status: "busy",
      icon: "✓",
      contains: ["Detected dual-stack loopback listeners"],
      excludes: ["Port 18789 is already in use."],
    },
    {
      name: "single wildcard Gateway",
      listeners: [[5001, "0.0.0.0:18789"]],
      status: "busy",
      icon: "✓",
      contains: ["Detected OpenClaw Gateway listener on the configured port."],
      excludes: ["Port 18789 is already in use."],
    },
    {
      name: "multi-process conflict",
      listeners: [
        [5001, "127.0.0.1:18789"],
        [5002, "[::1]:18789"],
      ],
      status: "busy",
      icon: "!",
      contains: [
        "2 OpenClaw gateway processes appear to be listening on port 18789",
        "Port 18789 is already in use.",
      ],
      excludes: [],
    },
    {
      name: "indeterminate availability despite attributed listener",
      listeners: [[5001, "127.0.0.1:18789"]],
      status: "unknown",
      icon: "!",
      contains: ["Port 18789 availability could not be determined."],
      excludes: ["Detected OpenClaw Gateway listener"],
    },
  ] as const)("diagnoses $name", async ({ listeners, status, icon, contains, excludes }) => {
    mocks.inspectPortUsage.mockResolvedValueOnce({
      port: 18789,
      status,
      hints: [],
      listeners: listeners.map(([pid, address]) => ({
        pid,
        address,
        commandLine: "openclaw-gateway",
      })),
    });
    expectReport(await reportText(), [`${icon} Port 18789`, ...contains], excludes);
  });

  it.each([
    {
      status: "error",
      reason: "managed-service-handoff-failed",
      headline: "⚠️ OpenClaw update failed: managed-service-handoff-failed.",
      hint: "Run openclaw triage to diagnose and repair the failed update.",
    },
    {
      status: "skipped",
      reason: "restart-health-pending",
      headline: "⬆️ OpenClaw update in progress: restarting.",
      hint: "Check progress with openclaw update status.",
    },
  ] as const)(
    "includes the shared update report for $status sentinels",
    async ({ status, reason, headline, hint }) => {
      mocks.readRestartSentinelReadOnly.mockResolvedValueOnce({
        payload: {
          kind: "update",
          status,
          ts: Date.now() - 60_000,
          stats: { mode: "npm", reason, steps: [] },
        },
      });
      const output = await reportText();
      expectReport(output, [`Update restart: ${headline}`, hint], ["run openclaw gateway restart"]);
    },
  );

  it.each([
    { ages: [31 * 60_000, null], active: 0, icon: "!", warning: true },
    { ages: [5 * 60_000, 45 * 60_000], active: 1, icon: "✓", warning: false },
  ])("reports $active active agents", async ({ ages, active, icon, warning }) => {
    const base = createStatusScanResultFixture().agentStatus;
    const output = await reportText({
      overview: {
        agentStatus: {
          ...base,
          totalSessions: 2,
          agents: ages.map((lastActiveAgeMs, index) => ({
            ...base.agents[0]!,
            id: index === 0 ? "main" : "worker",
            lastActiveAgeMs,
          })),
        },
      },
    });
    expect(output).toContain(`${icon} Agent activity: ${active} active in 30m · 2 sessions`);
    expect(output.includes("verify inbound dispatch and turn creation")).toBe(warning);
  });

  it.each([
    [[2, 2, 2, 2, 2], "session.turn.created", 60_000, "✓", ["latest delivery event:"], []],
    [
      [1, 0, 0, 0, 1],
      "message.processed",
      30_000,
      "✓",
      [],
      ["Messages were received, but no gateway dispatch started"],
    ],
    [
      [1, 1, 1, 0, 1],
      "message.processed",
      30_000,
      "✓",
      [],
      ["Gateway dispatch started, but no agent turn was created"],
    ],
    [
      [3, 3, 1, 0, 1],
      "message.dispatch.started",
      120_000,
      "!",
      [
        "Gateway dispatch started, but no agent turn was created",
        "Multiple gateway dispatches have not completed yet",
      ],
      [],
    ],
  ] as const)(
    "reports delivery counters %j",
    async (
      [received, started, completed, turns, processed],
      event,
      age,
      icon,
      contains,
      excludes,
    ) => {
      mocks.resolveStatusGatewayDiagnosticsSafe.mockResolvedValueOnce(
        availableDiagnostics({
          summary: {
            byType: {
              "message.received": received,
              "message.dispatch.started": started,
              "message.dispatch.completed": completed,
              "session.turn.created": turns,
              "message.processed": processed,
            },
          },
          events: [{ type: event, ts: Date.now() - age }],
        }),
      );
      expectReport(
        await reportText(),
        [
          `${icon} Inbound delivery telemetry: received ${received} · dispatch ${started}/${completed} · turns ${turns} · processed ${processed}`,
          ...contains,
        ],
        excludes,
      );
    },
  );

  it("renders the shared redacted telemetry exporter summary", async () => {
    mocks.resolveStatusGatewayDiagnosticsSafe.mockResolvedValueOnce({ ok: true, value: {} });
    mocks.resolveStatusGatewayDiagnosticsSafe.mockResolvedValueOnce(
      availableDiagnostics({
        events: [
          {
            seq: 1,
            type: "telemetry.exporter",
            source: "diagnostics-otel",
            target: "traces",
            transport: "otlp-http-protobuf",
            outcome: "failure",
            reason: "export_failed",
            mode: "configured",
            url: "https://collector.example/private",
            headers: { authorization: "secret" },
            error: "raw failure",
          },
        ],
      }),
    );
    expectReport(
      await reportText(),
      [
        "! Telemetry exporters",
        "diagnostics-otel · traces · failed · OTLP/HTTP protobuf (explicit endpoint) · export failed",
      ],
      ["collector.example", "secret", "raw failure"],
    );
  });

  it("renders failed diagnostics as unavailable instead of empty", async () => {
    const failedProbe = {
      ok: false as const,
      error:
        "Error: diagnostics probe timed out at wss://probe-user:probe-pass@gateway.example/socket?token=probe-secret",
    };
    mocks.resolveStatusGatewayDiagnosticsSafe.mockResolvedValueOnce(failedProbe);
    mocks.resolveStatusGatewayDiagnosticsSafe.mockResolvedValueOnce(failedProbe);

    const output = await reportText();
    expectReport(
      output,
      [
        "! Telemetry exporters: unavailable",
        "Exporter diagnostics failed: Error: diagnostics probe timed out at wss://***:***@gateway.example/socket?token=***",
        "Retry: openclaw gateway stability --type telemetry.exporter",
        "! Inbound delivery telemetry: unavailable",
        "Delivery diagnostics failed: Error: diagnostics probe timed out at wss://***:***@gateway.example/socket?token=***",
        "Retry: openclaw gateway stability",
      ],
      [
        "received 0 · dispatch 0/0 · turns 0 · processed 0",
        "probe-user",
        "probe-pass",
        "probe-secret",
      ],
    );
  });

  it("avoids unreachable gateway diagnosis in node-only mode", async () => {
    mocks.resolveStatusAllConnectionDetails.mockReturnValueOnce(
      [
        "Node-only mode detected",
        "Local gateway: not expected on this machine",
        "Remote gateway target: gateway.example.com:19000",
      ].join("\n"),
    );
    const nodeOnlyGateway = {
      gatewayTarget: "gateway.example.com:19000",
      gatewayValue: "node → gateway.example.com:19000 · no local gateway",
      connectionDetails: [
        "Node-only mode detected",
        "Local gateway: not expected on this machine",
        "Remote gateway target: gateway.example.com:19000",
        "Inspect the remote gateway host for live channel and health details.",
      ].join("\n"),
    };
    const output = await reportText({ nodeOnlyGateway });
    expectReport(
      output,
      [
        "Node-only mode detected",
        "Channel issues skipped (node-only mode; query gateway.example.com:19000)",
      ],
      [
        "Channel issues skipped (gateway unreachable)",
        "Gateway health:",
        "Inbound delivery telemetry: unavailable",
        "Telemetry exporters: unavailable",
        "Retry: openclaw gateway stability",
      ],
    );
  });

  it.each(["ENOENT", "EACCES"])(
    "distinguishes absent log tails from unavailable log reads (%s)",
    async (code) => {
      const logPaths = {
        logDir: "/synthetic-status-logs",
        stdoutPath: "/synthetic-status-logs/gateway.log",
        stderrPath: "/synthetic-status-logs/gateway.err.log",
      };
      mocks.resolveGatewayLogPaths.mockReturnValue(logPaths);
      mocks.resolveGatewaySupervisorLogPaths.mockReturnValue(logPaths);
      const actualGateway = await vi.importActual<typeof import("./gateway.js")>("./gateway.js");
      mocks.readFileTailLines.mockImplementation(actualGateway.readFileTailLines);
      const open = vi.spyOn(fs, "open").mockRejectedValue(
        Object.assign(new Error("synthetic filesystem failure token=synthetic-private"), {
          code,
        }),
      );
      try {
        const output = await reportText();
        if (code === "ENOENT") {
          expect(output).not.toContain("Log unavailable");
        } else {
          expectReport(output, [
            "# stdout: /synthetic-status-logs/gateway.log",
            "Log unavailable; check this file's path and permissions, then retry.",
            "Gateway restart attempts (tail): /tmp/fixture-restart.log",
          ]);
        }
        expectReport(
          output,
          ["Pasteable debug report. Auth tokens redacted."],
          ["synthetic-private"],
        );
      } finally {
        open.mockRestore();
      }
    },
  );

  it("does not read or display stale stderr tails on Darwin", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin" });
    try {
      mocks.resolveGatewaySupervisorLogPaths.mockReturnValue({
        logDir: "/Users/test/Library/Logs/openclaw",
        stdoutPath: "/Users/test/Library/Logs/openclaw/gateway.log",
        stderrPath: "/Users/test/Library/Logs/openclaw/gateway.err.log",
      });
      mocks.resolveGatewayRestartLogPath.mockReturnValue("/tmp/openclaw/logs/gateway-restart.log");
      mocks.readFileTailLines.mockImplementation(async (filePath: string) => {
        if (filePath.endsWith("gateway.log")) {
          return ["gateway stdout current"];
        }
        if (filePath.endsWith("gateway.err.log")) {
          return ["failed to bind gateway socket stale"];
        }
        return [];
      });

      const output = await reportText();
      expect(mocks.readFileTailLines).not.toHaveBeenCalledWith(
        "/Users/test/Library/Logs/openclaw/gateway.err.log",
        40,
      );
      expectReport(
        output,
        ["# stdout: /Users/test/Library/Logs/openclaw/gateway.log", "gateway stdout current"],
        ["# stderr:", "failed to bind gateway socket stale"],
      );
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });
});
