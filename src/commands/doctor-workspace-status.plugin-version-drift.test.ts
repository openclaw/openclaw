import { afterEach, expect, it, vi } from "vitest";
import * as noteModule from "../../packages/terminal-core/src/note.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { fetchClawHubPackageDetail } from "../infra/clawhub-packages.js";
import {
  detectPluginVersionDrift,
  resolvePluginVersionDriftTargets,
  type PluginVersionRestartReadiness,
} from "../plugins/plugin-version-drift.js";
import {
  collectWorkspaceStatusHealthFindings,
  noteWorkspaceStatus,
} from "./doctor-workspace-status.js";

vi.mock("../infra/clawhub-packages.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/clawhub-packages.js")>()),
  fetchClawHubPackageDetail: vi.fn(),
}));

vi.mock("../agents/agent-scope.js", () => ({
  listAgentIds: () => [],
  resolveAgentWorkspaceDir: () => {
    throw new Error("plugin drift evidence must not inspect agent workspaces");
  },
  tryResolveDefaultAgentId: () => undefined,
}));

vi.mock("../plugins/status.js", () => ({
  buildPluginCompatibilityWarnings: () => {
    throw new Error("plugin drift evidence must not use compatibility warnings");
  },
  buildPluginRegistrySnapshotReport: () => {
    throw new Error("plugin drift evidence must not use registry diagnostics");
  },
}));

const config: OpenClawConfig = { plugins: { entries: { codex: { enabled: true } } } };

afterEach(() => vi.restoreAllMocks());
function inspect(readiness: PluginVersionRestartReadiness, cfg: OpenClawConfig = config) {
  const findings = collectWorkspaceStatusHealthFindings(cfg, { pluginVersionReadiness: readiness });
  const noteSpy = vi.spyOn(noteModule, "note").mockImplementation(() => {});
  noteSpy.mockClear();
  noteWorkspaceStatus(cfg, { pluginVersionReadiness: readiness });
  return { findings, noteSpy };
}

function detectCodexDrift(installedVersion: string, gatewayVersion: string) {
  const report = detectPluginVersionDrift({
    gatewayVersion,
    installRecords: {
      codex: {
        source: "npm",
        spec: `@openclaw/codex@${installedVersion}`,
        resolvedName: "@openclaw/codex",
        resolvedVersion: installedVersion,
      },
    },
    config,
  });
  for (const entry of report.drifts) {
    entry.targetResolution = {
      status: "resolved",
      packageName: "@openclaw/codex",
      requestedTarget: gatewayVersion,
      version: gatewayVersion,
    };
  }
  return report;
}

it.each(["unresolved", "restart"] as const)("reports %s Gateway readiness", (state) => {
  const unresolved = state === "unresolved";
  const runningGatewayVersion = "2026.5.30";
  const { findings, noteSpy } = inspect(
    unresolved
      ? {
          status: "unresolved",
          reason: "Gateway service package version is unavailable.",
          runningGatewayVersion,
        }
      : {
          status: "resolved",
          runningGatewayVersion,
          report: detectCodexDrift("2026.6.1", "2026.6.1"),
        },
  );
  expect(findings).toMatchObject([
    {
      requirement: `plugin-version-${unresolved ? "restart-readiness" : "gateway-restart"}`,
      message: expect.stringContaining(
        unresolved
          ? "Gateway service package version is unavailable"
          : `running Gateway is ${runningGatewayVersion}`,
      ),
      ...(!unresolved ? { fixHint: "openclaw gateway restart" } : {}),
    },
  ]);
  expect(noteSpy).toHaveBeenCalledWith(
    expect.stringContaining(`Running Gateway: OpenClaw ${runningGatewayVersion}`),
    "Plugin restart readiness",
  );
});

it("reports older and newer pins as advisory drift while accepting correction suffixes", () => {
  const gatewayVersion = "2026.6.1";

  for (const installedVersion of ["2026.5.30", "2026.6.2"]) {
    const report = detectCodexDrift(installedVersion, gatewayVersion);
    const { findings, noteSpy } = inspect({ status: "resolved", report });
    expect(findings).toEqual([
      {
        checkId: "core/doctor/workspace-status",
        severity: "warning",
        message: `Plugin codex is ${installedVersion}, but a Gateway restart will load OpenClaw ${gatewayVersion}. The confirmed plugin target is ${gatewayVersion}.`,
        path: "plugins.entries.codex",
        target: "codex",
        requirement: "plugin-version-drift",
        fixHint: "openclaw plugins update @openclaw/codex@2026.6.1 && openclaw gateway restart",
      },
    ]);

    const driftNotes = noteSpy.mock.calls.filter(
      ([, title]) => title === "Plugin restart readiness",
    );
    expect(driftNotes).toHaveLength(1);
    const output = driftNotes[0]?.[0];
    for (const text of [
      `1 active official plugin not on post-restart OpenClaw ${gatewayVersion}`,
      `codex: ${installedVersion} (npm) -> expected ${gatewayVersion}`,
      "openclaw plugins update @openclaw/codex@2026.6.1",
      "openclaw gateway restart",
    ]) {
      expect(output).toContain(text);
    }
    expect(output).not.toContain("openclaw plugins update codex");
  }

  for (const [installedVersion, correctionGatewayVersion] of [
    ["2026.6.1", "2026.6.1-1"],
    ["2026.6.1-1", "2026.6.1"],
  ] as const) {
    const report = detectCodexDrift(installedVersion, correctionGatewayVersion);
    expect(report.drifts).toEqual([]);
    expect(
      collectWorkspaceStatusHealthFindings(config, {
        pluginVersionReadiness: {
          status: "resolved",
          report,
          runningGatewayVersion: installedVersion,
        },
      }),
    ).toEqual([]);
  }
});

it.each([
  ["resolved", "2026.9.2", ">=2026.9.3", "2026.9.3"],
  ["current", "2026.9.3", ">=2026.9.3", "2026.9.3"],
  ["unresolved", "2026.9.3", ">=2026.10.1", "2026.9.3"],
  ["resolved", "2026.9.3", ">=2026.9.3", "2026.9.3-1"],
])(
  "renders %s ClawHub targets consistently (%s, %s, %s)",
  async (result, installedVersion, pluginApiRange, latestVersion) => {
    vi.mocked(fetchClawHubPackageDetail).mockResolvedValueOnce({
      package: {
        name: "@openclaw/whatsapp",
        displayName: "WhatsApp",
        family: "code-plugin",
        channel: "official",
        isOfficial: true,
        createdAt: 0,
        updatedAt: 0,
        latestVersion,
        compatibility: { pluginApiRange },
      },
    });
    const report = await resolvePluginVersionDriftTargets(
      detectPluginVersionDrift({
        gatewayVersion: "2026.9.4",
        installRecords: {
          whatsapp: {
            source: "clawhub",
            spec: "clawhub:@openclaw/whatsapp",
            clawhubPackage: "@openclaw/whatsapp",
            resolvedVersion: installedVersion,
          },
        },
      }),
    );
    const { findings, noteSpy } = inspect({ status: "resolved", report }, {});
    expect(findings).toHaveLength(1);
    expect(noteSpy).toHaveBeenCalledOnce();
    const output = String(noteSpy.mock.calls[0]?.[0]);
    if (result === "current") {
      expect(findings[0]?.severity).toBe("info");
      expect(findings[0]?.message).toContain("registry version 2026.9.3");
      expect(findings[0]?.message).toContain("No plugin update can reach 2026.9.4");
      expect(findings[0]?.fixHint).toBeUndefined();
      expect(output).toContain("already holds registry version 2026.9.3");
      expect(output).toContain("whatsapp: 2026.9.3 (clawhub) -> expected 2026.9.4");
      expect(output).not.toContain("openclaw plugins update");
      expect(output).not.toContain("No install command generated");
    } else if (result === "resolved") {
      expect(findings[0]?.message).toContain(`confirmed plugin target is ${latestVersion}`);
      expect(output).toContain(
        `whatsapp: ${installedVersion} (clawhub) -> expected ${latestVersion}`,
      );
      expect(output).not.toContain("expected 2026.9.4");
      expect(findings[0]?.fixHint).toBe(
        "openclaw plugins update whatsapp && openclaw gateway restart",
      );
      expect(output).toContain(findings[0]?.fixHint);
    } else {
      expect(findings[0]?.message).toContain("requires plugin API >=2026.10.1");
      expect(output).toContain("requires plugin API >=2026.10.1");
      expect(output).toContain("No install command generated");
      expect(output).not.toContain("openclaw plugins update");
      expect(findings[0]?.fixHint).not.toContain("openclaw plugins update");
    }
  },
);
