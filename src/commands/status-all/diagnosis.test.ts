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

const availableDiagnostics = (value: unknown) => ({ ok: true as const, value });
const portConflict = "Port 18789 is already in use.";
const expectedListener = "Detected OpenClaw Gateway listener on the configured port.";
const noDispatch = "Messages were received, but no gateway dispatch started";
const noTurn = "Gateway dispatch started, but no agent turn was created";
const dispatchGap = "Multiple gateway dispatches have not completed yet";
const logPaths = (logDir: string) => ({
  logDir,
  stdoutPath: `${logDir}/gateway.log`,
  stderrPath: `${logDir}/gateway.err.log`,
});

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

    expectReport(await reportText(), [
      "Delivery queue: warning",
      "outbound: 2",
      "inbound telegram/ops: 1 pressured lane, 2 pending, 0 claimed, 1 blocked",
    ]);
  });

  it("keeps a failed health request visible in the complete report", async () => {
    mocks.resolveStatusGatewayHealthSafe.mockResolvedValueOnce({
      error: "health request timed out",
    });

    expectReport(await reportText(), [
      "Gateway health:\n  health request timed out",
      "Pasteable debug report. Auth tokens redacted.",
    ]);
  });

  it("strips terminal controls from channel issues in the diagnostic report", async () => {
    const output = await reportText({
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

  it.each<{
    name: string;
    listeners: [number, string][];
    status: "busy" | "unknown";
    icon: string;
    contains: string[];
    excludes: string[];
  }>`
    name                                                        | listeners                                             | status       | icon   | contains                                                                               | excludes
    ${"same-process dual-stack loopback"}                       | ${[[5001, "127.0.0.1:18789"], [5001, "[::1]:18789"]]} | ${"busy"}    | ${"✓"} | ${["Detected dual-stack loopback listeners"]}                                          | ${[portConflict]}
    ${"single wildcard Gateway"}                                | ${[[5001, "0.0.0.0:18789"]]}                          | ${"busy"}    | ${"✓"} | ${[expectedListener]}                                                                  | ${[portConflict]}
    ${"multi-process conflict"}                                 | ${[[5001, "127.0.0.1:18789"], [5002, "[::1]:18789"]]} | ${"busy"}    | ${"!"} | ${["2 OpenClaw gateway processes appear to be listening on port 18789", portConflict]} | ${[]}
    ${"indeterminate availability despite attributed listener"} | ${[[5001, "127.0.0.1:18789"]]}                        | ${"unknown"} | ${"!"} | ${["Port 18789 availability could not be determined."]}                                | ${["Detected OpenClaw Gateway listener"]}
  `("diagnoses $name", async ({ listeners, status, icon, contains, excludes }) => {
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

  it.each<{
    status: "error" | "skipped";
    reason: string;
    headline: string;
    hint: string;
  }>`
    status       | reason                              | headline                                                        | hint
    ${"error"}   | ${"managed-service-handoff-failed"} | ${"⚠️ OpenClaw update failed: managed-service-handoff-failed."} | ${"Run openclaw triage to diagnose and repair the failed update."}
    ${"skipped"} | ${"restart-health-pending"}         | ${"⬆️ OpenClaw update in progress: restarting."}                | ${"Check progress with openclaw update status."}
  `("reports $status update sentinel", async ({ status, reason, headline, hint }) => {
    mocks.readRestartSentinelReadOnly.mockResolvedValueOnce({
      payload: {
        kind: "update",
        status,
        ts: Date.now() - 60_000,
        stats: { mode: "npm", reason, steps: [] },
      },
    });
    expectReport(
      await reportText(),
      [`Update restart: ${headline}`, hint],
      ["run openclaw gateway restart"],
    );
  });

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

  it.each<{
    counts: [number, number, number, number, number];
    event: string;
    age: number;
    icon: string;
    contains: string[];
    excludes: string[];
  }>`
    counts             | event                         | age        | icon   | contains                      | excludes
    ${[2, 2, 2, 2, 2]} | ${"session.turn.created"}     | ${60_000}  | ${"✓"} | ${["latest delivery event:"]} | ${[]}
    ${[1, 0, 0, 0, 1]} | ${"message.processed"}        | ${30_000}  | ${"✓"} | ${[]}                         | ${[noDispatch]}
    ${[1, 1, 1, 0, 1]} | ${"message.processed"}        | ${30_000}  | ${"✓"} | ${[]}                         | ${[noTurn]}
    ${[3, 3, 1, 0, 1]} | ${"message.dispatch.started"} | ${120_000} | ${"!"} | ${[noTurn, dispatchGap]}      | ${[]}
  `(
    "reports delivery counters $counts",
    async ({ counts, event, age, icon, contains, excludes }) => {
      const [received, started, completed, turns, processed] = counts;
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

    expectReport(
      await reportText(),
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
    const connectionDetails = [
      "Node-only mode detected",
      "Local gateway: not expected on this machine",
      "Remote gateway target: gateway.example.com:19000",
    ].join("\n");
    mocks.resolveStatusAllConnectionDetails.mockReturnValueOnce(connectionDetails);
    const nodeOnlyGateway = {
      gatewayTarget: "gateway.example.com:19000",
      gatewayValue: "node → gateway.example.com:19000 · no local gateway",
      connectionDetails: `${connectionDetails}\nInspect the remote gateway host for live channel and health details.`,
    };
    expectReport(
      await reportText({ nodeOnlyGateway }),
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
      const paths = logPaths("/synthetic-status-logs");
      mocks.resolveGatewayLogPaths.mockReturnValue(paths);
      mocks.resolveGatewaySupervisorLogPaths.mockReturnValue(paths);
      const actualGateway = await vi.importActual<typeof import("./gateway.js")>("./gateway.js");
      mocks.readFileTailLines.mockImplementation(actualGateway.readFileTailLines);
      vi.spyOn(fs, "open").mockRejectedValue(
        Object.assign(new Error("synthetic filesystem failure token=synthetic-private"), {
          code,
        }),
      );
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
    },
  );

  it("does not read or display stale stderr tails on Darwin", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin" });
    try {
      mocks.resolveGatewaySupervisorLogPaths.mockReturnValue(
        logPaths("/Users/test/Library/Logs/openclaw"),
      );
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
