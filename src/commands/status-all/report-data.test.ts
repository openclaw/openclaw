import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createUpdateRunRecordFixture } from "../../infra/update-run-record.test-support.js";
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
};
function localOverview() {
  return {
    cfg: {},
    gatewaySnapshot: { ...localGatewaySnapshot },
    agentStatus: { agents: [], defaultId: null },
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
  it.each`
    history               | phase         | sentinel     | reference                                 | expected
    ${"completed"}        | ${"finished"} | ${null}      | ${null}                                   | ${[runLine]}
    ${"active"}           | ${"active"}   | ${null}      | ${null}                                   | ${["Update run: ⬆️ OpenClaw update in progress: verifying."]}
    ${"sentinel"}         | ${null}       | ${"ok"}      | ${null}                                   | ${[restartLine]}
    ${"none"}             | ${null}       | ${null}      | ${null}                                   | ${[]}
    ${"mixed-sentinel"}   | ${"finished"} | ${"error"}   | ${null}                                   | ${[runLine, "Update restart: ⚠️ OpenClaw update failed: restart-unhealthy."]}
    ${"same-run"}         | ${"finished"} | ${"ok"}      | ${"same"}                                 | ${[runLine]}
    ${"different-run"}    | ${"finished"} | ${"ok"}      | ${"1e36e13e-8cbf-4c33-bd2b-03adbd8f7a64"} | ${[runLine, restartLine]}
    ${"same-prose"}       | ${"finished"} | ${"ok"}      | ${null}                                   | ${[runLine, restartLine]}
    ${"generic-sentinel"} | ${"finished"} | ${"restart"} | ${null}                                   | ${[runLine]}
    ${"failed-healthy"}   | ${"failed"}   | ${null}      | ${null}                                   | ${["Update run: Last update run failed (post-update-failed) — Gateway is serving 2026.9.2; run `openclaw update` to clear the record."]}
  `(
    "keeps current availability alongside $history history without observing config",
    async ({ phase, sentinel, reference, expected }) => {
      const rows = await vi.importActual<typeof import("../status-overview-rows.ts")>(
        "../status-overview-rows.ts",
      );
      mocks.buildStatusAllOverviewRows.mockImplementationOnce(rows.buildStatusAllOverviewRows);
      const failed = phase === "failed";
      const completed = createUpdateRunRecordFixture("6631ecee-adbf-41e8-a0e3-1b88b28b0a59", {
        status: failed ? "failed" : "succeeded",
        reason: failed ? "post-update-failed" : null,
        before: { version: "2026.9.1" },
        after: { version: "2026.9.2" },
      });
      if (phase) {
        mocks.history.mockResolvedValue({
          lastRun: completed,
          activeRun:
            phase === "active"
              ? { ...completed, status: "running", phase: "verifying" }
              : undefined,
        });
        mocks.getUpdateRun.mockReturnValue(completed);
      }
      if (sentinel) {
        const runId = reference === "same" ? completed.runId : (reference ?? undefined);
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
      });
      const update = report.find((line) => line.startsWith("Update: "));
      expect(update).toContain("npm update 9999.1.1");
      expect(update).toContain("behind 2");
      expect(report.filter((line) => /^(Update run|Update restart): /.test(line))).toEqual(
        expected,
      );
      expect(mocks.readConfigFileSnapshot).toHaveBeenCalledWith({ observe: false });
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
    },
  );

  it("renders the system agent's unfiltered readiness and refreshes installed binaries", async () => {
    const workspaceDir = tempDirs.make("status-readiness-beta-");
    const missingBin = "openclaw-readiness-fixture-bin";
    for (const name of ["ready", "missing"]) {
      await writeSkill({
        dir: path.join(workspaceDir, "skills", name),
        name,
        description: name,
        metadata: JSON.stringify({
          openclaw: { requires: { bins: name === "missing" ? [missingBin] : [] } },
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
      {
        OPENCLAW_BUNDLED_SKILLS_DIR: path.join(workspaceDir, "bundled"),
        PATH: workspaceDir,
        PATHEXT: ".CMD",
      },
      async () => {
        expect(await runStatusAllReport(params)).toContain(
          "! Skills: 1 eligible · 1 missing · " + workspaceDir,
        );
        await fs.writeFile(
          path.join(workspaceDir, process.platform === "win32" ? missingBin + ".CMD" : missingBin),
          "",
          { mode: 0o755 },
        );
        expect(await runStatusAllReport(params)).toContain(
          "✓ Skills: 2 eligible · 0 missing · " + workspaceDir,
        );
        mocks.buildWorkspaceSkillReadiness.mockImplementationOnce(() => {
          throw new Error("Synthetic discovery failure");
        });
        const partial = await runStatusAllReport(params);
        expect(partial.some((line) => line.includes("Skills:"))).toBe(false);
        expect(partial).toContain("Diagnosis (read-only)");
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
    });

    expect(mocks.resolveNodeExecEligibility).not.toHaveBeenCalled();
    expect(mocks.buildWorkspaceSkillReadiness).not.toHaveBeenCalled();
  });

  it("prepares detail and agent rows before rendering and prefixes config diagnostics", async () => {
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
              columns: ["Status"],
              rows: [
                {
                  get Status() {
                    renderingEvents.push("prepare detail");
                    return "OK";
                  },
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
              ...scan.agentStatus.agents[0]!,
              get bootstrapPending() {
                renderingEvents.push("prepare agent");
                return true;
              },
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
    expect(output.indexOf("Diagnosis (read-only)")).toBeLessThan(
      output.indexOf("Gateway connection details:"),
    );
    expect(output).toContain("Support: https://community.openclaw.ai/");
  });
});
