import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { UpdateRunRecord } from "../../infra/update-run-record.js";
import { writeSkill } from "../../skills/test-support/e2e-test-helpers.js";
import { withEnvAsync } from "../../test-utils/env.js";
import {
  baseStatusGatewaySnapshot,
  baseStatusOverviewSurface,
  createStatusScanResultFixture,
  createStatusHealth,
} from "../status.test-support.ts";
import { createTestConfigSnapshot } from "../test-runtime-config-helpers.js";
import {
  mocks,
  runStatusAllReport,
  reportText,
  expectReport,
  setupStatusAllReportTest,
} from "./report-data.test-support.js";

const localGatewaySnapshot = {
  gatewayReachable: false,
  gatewayProbe: null,
  gatewayCallOverrides: undefined,
  gatewayConnection: {},
  remoteUrlMissing: false,
};
function localOverview() {
  return {
    cfg: {},
    gatewaySnapshot: { ...localGatewaySnapshot },
    tailscaleMode: "off",
    tailscaleDns: null,
    agentStatus: { agents: [], defaultId: null },
    osSummary: { label: "test" },
  };
}

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

setupStatusAllReportTest();

describe("statusAllCommand report data", () => {
  it("reconciles runtime secret owners and local diagnostics in the complete report", async () => {
    const rows = await vi.importActual<typeof import("../status-overview-rows.ts")>(
      "../status-overview-rows.ts",
    );
    mocks.buildStatusAllOverviewRows.mockImplementationOnce(rows.buildStatusAllOverviewRows);
    const output = await reportText({
      overview: {
        runtimeDegradation: {
          degradedSecretOwners: [
            {
              ownerKind: "capability",
              ownerId: "tts",
              state: "unavailable",
              degradationState: "cold",
              paths: ["tts.providers.elevenlabs.apiKey"],
              reason: "secret reference was not found",
            },
            {
              ownerKind: "provider",
              ownerId: "openai",
              state: "unavailable",
              degradationState: "stale",
              paths: ["models.providers.openai.apiKey"],
              reason: "secret provider failed",
            },
          ],
          degradedPlugins: [],
        },
        secretDiagnostics: [
          "status --all: tts.providers.elevenlabs.apiKey is unavailable in this command path; continuing with degraded read-only config.",
          "channels.discord.accounts.ops.token: token=synthetic-secret",
        ],
      },
    });
    expectReport(
      output,
      [
        "Secrets: 3 diagnostics",
        "! Secret diagnostics (3)",
        "cold capability:tts (tts.providers.elevenlabs.apiKey): secret reference was not found",
        "stale provider:openai (models.providers.openai.apiKey): secret provider failed",
        "channels.discord.accounts.ops.token: ***",
        "Retry: openclaw secrets reload",
        "Gateway service: gateway not installed",
        "Node service: gateway not installed",
      ],
      ["synthetic-secret", "✓ Secret diagnostics (0)"],
    );
  });

  const success = "✅ OpenClaw updated to 2026.9.2 (from 2026.9.1).";
  const runLine = `Update run: ${success}`,
    restartLine = `Update restart: ${success}`;
  it.each([
    ["completed", "finished", null, null, [runLine]],
    ["active", "active", null, null, ["Update run: ⬆️ OpenClaw update in progress: verifying."]],
    ["sentinel", null, "ok", null, [restartLine]],
    ["none", null, null, null, []],
    [
      "mixed-sentinel",
      "finished",
      "error",
      null,
      [runLine, "Update restart: ⚠️ OpenClaw update failed: restart-unhealthy."],
    ],
    ["same-run", "finished", "ok", "same", [runLine]],
    ["different-run", "finished", "ok", "different", [runLine, restartLine]],
    ["same-prose", "finished", "ok", null, [runLine, restartLine]],
    ["generic-sentinel", "finished", "restart", null, [runLine]],
    [
      "failed-healthy",
      "failed",
      null,
      null,
      [
        "Update run: Last update run failed (post-update-failed) — Gateway is serving 2026.9.2; run `openclaw update` to clear the record.",
      ],
    ],
  ] as const)(
    "keeps current availability alongside %s history without observing config",
    async (_history, phase, sentinel, reference, expected) => {
      const rows = await vi.importActual<typeof import("../status-overview-rows.ts")>(
        "../status-overview-rows.ts",
      );
      mocks.buildStatusAllOverviewRows.mockImplementationOnce(rows.buildStatusAllOverviewRows);
      const failed = phase === "failed";
      const completed: UpdateRunRecord = {
        runId: "6631ecee-adbf-41e8-a0e3-1b88b28b0a59",
        createdAtMs: 1,
        updatedAtMs: 2,
        trigger: "cli",
        phase: "finished",
        status: failed ? "failed" : "succeeded",
        reason: failed ? "post-update-failed" : null,
        origin: {},
        target: {},
        before: { version: "2026.9.1" },
        after: { version: "2026.9.2" },
        steps: [],
        verification: {},
        repair: [],
        confirmedAtMs: null,
        finishedAtMs: 2,
        downtimeMs: null,
      };
      if (phase) {
        mocks.history.mockResolvedValue({
          lastRun: completed,
          ...(phase === "active"
            ? {
                activeRun: {
                  ...completed,
                  status: "running" as const,
                  phase: "verifying" as const,
                },
              }
            : {}),
        });
        mocks.getUpdateRun.mockReturnValue(completed);
      }
      if (sentinel) {
        const runId =
          reference === "different"
            ? "1e36e13e-8cbf-4c33-bd2b-03adbd8f7a64"
            : reference === "same"
              ? completed.runId
              : undefined;
        if (runId) {
          mocks.getUpdateRun.mockReturnValue({ ...completed, runId });
        }
        mocks.readRestartSentinelReadOnly.mockResolvedValue({
          payload: {
            kind: sentinel === "restart" ? "restart" : "update",
            status: sentinel === "error" ? "error" : "ok",
            ts: 3,
            stats: {
              before: completed.before,
              after: completed.after,
              ...(sentinel === "error" ? { reason: "restart-unhealthy" } : {}),
              ...(runId ? { runId } : {}),
            },
          },
        });
      }
      const report = await runStatusAllReport({
        overview: {
          ...localOverview(),
          update: { ...baseStatusOverviewSurface.update, registry: { latestVersion: "9999.1.1" } },
          gatewaySnapshot: {
            ...baseStatusGatewaySnapshot,
            gatewayReachable: false,
            gatewayProbe: failed
              ? { server: { version: "2026.9.2", buildId: "fixture-build" } }
              : null,
            gatewayCallOverrides: undefined,
            remoteUrlMissing: false,
            localGatewayHealthy: failed,
          },
          agentStatus: { agents: [], defaultId: null, totalSessions: 0, bootstrapPendingCount: 0 },
        } as never,
        daemon: baseStatusOverviewSurface.gatewayService as never,
        nodeService: baseStatusOverviewSurface.nodeService as never,
      });
      const update = report.find((line) => line.startsWith("Update: "));
      expect(update).toContain("npm update 9999.1.1");
      expect(update).toContain("behind 2");
      expect(report.filter((line) => /^(Update run|Update restart): /.test(line))).toEqual(
        expected,
      );
      expect(mocks.readConfigFileSnapshot).toHaveBeenCalledOnce();
      expect(mocks.readConfigFileSnapshot).toHaveBeenCalledWith({ observe: false });
      expect(mocks.resolveGatewayBindHost).toHaveBeenCalledWith("loopback", undefined);
      expect(mocks.inspectPortUsage).toHaveBeenCalledWith(18789, { probeHosts: ["127.0.0.1"] });
      expect(mocks.resolveStatusSummaryFromOverview).toHaveBeenCalledOnce();
    },
  );

  it.each([false, true])(
    "collects stability projections only after readiness (starting: %s)",
    async (starting) => {
      const report = await runStatusAllReport({
        overview: {
          ...localOverview(),
          gatewaySnapshot: {
            ...localGatewaySnapshot,
            gatewayReachable: !starting,
            gatewayProbe: { error: null, ...(starting ? { startupPhase: "plugins" } : {}) },
          },
          runtimeDegradation: { degradedSecretOwners: [], degradedPlugins: [] },
        } as never,
      });

      if (starting) {
        expect(mocks.resolveStatusGatewayDiagnosticsSafe).not.toHaveBeenCalled();
        expect(mocks.resolveStatusGatewayHealthSafe).not.toHaveBeenCalled();
        expect(report.join("\n")).toContain("gateway still starting (phase plugins)");
        expect(report.join("\n")).not.toContain("Gateway health:");
        return;
      }

      expect(mocks.resolveStatusGatewayDiagnosticsSafe.mock.calls).toEqual([
        [expect.objectContaining({ gatewayReachable: true, gatewayProbeDeadlineMs: 60_000 })],
        [
          expect.objectContaining({
            gatewayReachable: true,
            gatewayProbeDeadlineMs: 60_000,
            type: "telemetry.exporter",
          }),
        ],
      ]);
      expect(mocks.resolveStatusSummaryFromOverview).not.toHaveBeenCalled();
    },
  );

  it("renders the system agent's unfiltered readiness and refreshes newly installed binaries", async () => {
    const rootDir = tempDirs.make("openclaw-status-readiness-");
    const workspaceDir = path.join(rootDir, "beta");
    const bundledDir = path.join(rootDir, "bundled");
    const binDir = path.join(rootDir, "bin");
    await fs.mkdir(binDir);
    const missingBin = "openclaw-readiness-fixture-bin";
    for (const name of ["agent-excluded", "missing"]) {
      await writeSkill({
        dir: path.join(workspaceDir, "skills", name),
        name,
        description: "Synthetic status readiness fixture",
        metadata: JSON.stringify({
          openclaw: {
            requires: { bins: name === "missing" ? [missingBin] : [] },
          },
        }),
      });
    }
    const actual = await vi.importActual<typeof import("../../skills/discovery/status.js")>(
      "../../skills/discovery/status.js",
    );
    mocks.buildWorkspaceSkillReadiness.mockImplementation(actual.buildWorkspaceSkillReadiness);
    const params = {
      overview: {
        ...localOverview(),
        cfg: {
          plugins: { enabled: false },
          agents: {
            ownership: "explicit",
            defaults: { systemAgent: { agentId: "beta" } },
            entries: {
              alpha: { workspace: "/tmp/alpha" },
              beta: { workspace: workspaceDir, skills: [] },
            },
          },
        },
        agentStatus: {
          agents: [{ id: "alpha", sessionsCount: 0, sessionsPath: "/tmp/alpha/sessions.json" }],
          defaultId: null,
        },
      } as never,
    };
    await withEnvAsync(
      { OPENCLAW_BUNDLED_SKILLS_DIR: bundledDir, PATH: binDir, PATHEXT: ".CMD" },
      async () => {
        const before = await runStatusAllReport(params);
        expect(before.find((line) => line.includes("Skills:"))).toBe(
          `! Skills: 1 eligible · 1 missing · ${workspaceDir}`,
        );
        await fs.writeFile(
          path.join(binDir, process.platform === "win32" ? `${missingBin}.CMD` : missingBin),
          "",
          { mode: 0o755 },
        );
        const after = await runStatusAllReport(params);
        expect(after.find((line) => line.includes("Skills:"))).toBe(
          `✓ Skills: 2 eligible · 0 missing · ${workspaceDir}`,
        );
        mocks.buildWorkspaceSkillReadiness.mockImplementationOnce(() => {
          throw new Error("Synthetic discovery failure");
        });
        const partialLines = await runStatusAllReport(params);
        expect(partialLines.some((line) => line.includes("Skills:"))).toBe(false);
        expect(partialLines.some((line) => line.includes("Diagnosis (read-only)"))).toBe(true);
      },
    );

    expect(mocks.resolveNodeExecEligibility).toHaveBeenCalledWith({
      cfg: expect.any(Object),
      execApprovals: { version: 1, agents: {} },
      agentId: "beta",
    });
    expect(mocks.buildWorkspaceSkillReadiness).toHaveBeenCalledWith(
      workspaceDir,
      expect.objectContaining({ agentId: "beta" }),
    );
  });

  it("does not inspect the first workspace when an explicit fleet has no owner", async () => {
    await runStatusAllReport({
      overview: {
        ...localOverview(),
        cfg: {
          agents: {
            ownership: "explicit",
            entries: { alpha: { workspace: "/tmp/alpha" }, beta: { workspace: "/tmp/beta" } },
          },
        },
      } as never,
      nodeOnlyGateway: {} as never,
    });

    expect(mocks.resolveNodeExecEligibility).not.toHaveBeenCalled();
    expect(mocks.buildWorkspaceSkillReadiness).not.toHaveBeenCalled();
  });

  it("renders bootstrap state and invalid config diagnostics through status --all", async () => {
    const renderingEvents: string[] = [];
    const actual = await vi.importActual<
      typeof import("../../../packages/terminal-core/src/table.js")
    >("../../../packages/terminal-core/src/table.js");
    mocks.renderTable.mockImplementation(actual.renderTable);
    mocks.buildStatusAllOverviewRows.mockReturnValueOnce([
      {
        get Item() {
          renderingEvents.push("render Overview");
          return "Gateway";
        },
        Value: "ok",
      },
    ]);
    const scan = createStatusScanResultFixture();
    const lines = await runStatusAllReport({
      overview: {
        configDiagnostics: {
          path: "/tmp/openclaw.json",
          issues: [{ path: "gateway.port", message: "invalid" }],
        },
        channels: {
          rows: [
            { id: "discord", label: "Discord", enabled: true, state: "ok", detail: "connected" },
          ],
          details: [
            {
              title: "Discord accounts",
              columns: ["Account", "Status", "Notes"],
              rows: [
                {
                  Account: "default",
                  get Status() {
                    renderingEvents.push("prepare detail");
                    return "OK";
                  },
                  Notes: "ready",
                },
              ],
            },
            { title: "Empty accounts", columns: ["Account", "Status"], rows: [] },
          ],
        },
        channelIssues: [
          {
            channel: "discord",
            accountId: "default",
            kind: "runtime",
            message: `${"x".repeat(89)}🚀tail`,
          },
        ],
        agentStatus: {
          ...scan.agentStatus,
          agents: [
            {
              id: "main",
              workspaceDir: null,
              lastUpdatedAt: null,
              get bootstrapPending() {
                renderingEvents.push("prepare agent");
                return true;
              },
              sessionsCount: 1,
              lastActiveAgeMs: 12_000,
              sessionsPath: "/tmp/main-sessions.json",
            },
            {
              id: "ops",
              workspaceDir: null,
              lastUpdatedAt: null,
              bootstrapPending: false,
              sessionsCount: 0,
              lastActiveAgeMs: null,
              sessionsPath: "/tmp/ops-sessions.json",
            },
          ],
        },
      },
    });

    expect(renderingEvents.filter((event, index) => event !== renderingEvents[index - 1])).toEqual([
      "prepare detail",
      "prepare agent",
      "render Overview",
    ]);
    const output = lines.join("\n");
    expectReport(output, [
      "Bootstrap file",
      "PRESENT",
      "ABSENT",
      "Config diagnostics:",
      "Config file is invalid: /tmp/openclaw.json",
      "gateway.port: invalid",
      "Fix: openclaw doctor --fix",
    ]);
    expect(output.indexOf("Config diagnostics:")).toBeLessThan(
      output.indexOf("OpenClaw status --all"),
    );
    expect(output).not.toContain(`${String.fromCharCode(0xd83d)}…`);
    expect(
      lines.filter((line) =>
        /^(Overview|Channels|Discord accounts|Empty accounts|Agents|Diagnosis \(read-only\))$/.test(
          line,
        ),
      ),
    ).toEqual([
      "Overview",
      "Channels",
      "Discord accounts",
      "Empty accounts",
      "Agents",
      "Diagnosis (read-only)",
    ]);
    expect(output.indexOf("Agents")).toBeLessThan(output.indexOf("Diagnosis (read-only)"));
    expect(output.indexOf("Diagnosis (read-only)")).toBeLessThan(
      output.indexOf("Gateway connection details:"),
    );
    expect(output).toContain("✓ Secret diagnostics (0)");
    expect(lines.slice(-5)).toEqual([
      "",
      "Pasteable debug report. Auth tokens redacted.",
      "Troubleshooting: https://docs.openclaw.ai/troubleshooting",
      "Support: https://community.openclaw.ai/",
      "",
    ]);
  });
});

function availableDiagnostics(value: unknown) {
  return { ok: true as const, value };
}

describe("statusAllCommand diagnosis", () => {
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
