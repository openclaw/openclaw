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
} from "../status.test-support.ts";
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

describe("statusAllCommand report data", () => {
  setupStatusAllReportTest();

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
    for (const name of [
      "ready",
      "missing",
      "disabled",
      "always",
      "agent-excluded",
      "unsupported-os",
      "blocked",
    ]) {
      await writeSkill({
        dir: path.join(name === "blocked" ? bundledDir : path.join(workspaceDir, "skills"), name),
        name,
        description: "Synthetic status readiness fixture",
        metadata: JSON.stringify({
          openclaw: {
            always: name === "always",
            requires: {
              bins: ["missing", "disabled", "always"].includes(name) ? [missingBin] : [],
            },
            ...(name === "unsupported-os" ? { os: ["openclaw-fixture-unsupported"] } : {}),
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
          skills: { allowBundled: ["other"], entries: { disabled: { enabled: false } } },
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
          `! Skills: 3 eligible · 2 missing · ${workspaceDir}`,
        );
        await fs.writeFile(
          path.join(binDir, process.platform === "win32" ? `${missingBin}.CMD` : missingBin),
          "",
          { mode: 0o755 },
        );
        const after = await runStatusAllReport(params);
        expect(after.find((line) => line.includes("Skills:"))).toBe(
          `! Skills: 4 eligible · 1 missing · ${workspaceDir}`,
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
