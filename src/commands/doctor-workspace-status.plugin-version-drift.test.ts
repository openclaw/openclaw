// Focused QA evidence for official plugin drift through doctor diagnostics.
import { describe, expect, it, vi } from "vitest";
import * as noteModule from "../../packages/terminal-core/src/note.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { fetchClawHubPackageDetail } from "../infra/clawhub-packages.js";
import {
  detectPluginVersionDrift,
  resolvePluginVersionDriftTargets,
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

const config: OpenClawConfig = {
  plugins: {
    entries: {
      codex: { enabled: true },
    },
  },
};

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

describe("official Codex plugin version drift doctor evidence", () => {
  it("reports an unresolved post-restart target instead of silently omitting readiness", () => {
    const readiness = {
      status: "unresolved" as const,
      reason: "Gateway service package version is unavailable.",
      runningGatewayVersion: "2026.5.30",
    };

    expect(
      collectWorkspaceStatusHealthFindings(config, { pluginVersionReadiness: readiness }),
    ).toEqual([
      expect.objectContaining({
        requirement: "plugin-version-restart-readiness",
        message: expect.stringContaining("Gateway service package version is unavailable"),
      }),
    ]);

    const noteSpy = vi.spyOn(noteModule, "note").mockImplementation(() => {});
    try {
      noteWorkspaceStatus(config, { pluginVersionReadiness: readiness });
      expect(noteSpy).toHaveBeenCalledWith(
        expect.stringContaining("Running Gateway: OpenClaw 2026.5.30"),
        "Plugin restart readiness",
      );
    } finally {
      noteSpy.mockRestore();
    }
  });

  it("reports when compatible plugins still need the older running Gateway restarted", () => {
    const restartVersion = "2026.6.1";
    const runningGatewayVersion = "2026.5.30";
    const readiness = {
      status: "resolved" as const,
      runningGatewayVersion,
      report: detectCodexDrift(restartVersion, restartVersion),
    };

    expect(
      collectWorkspaceStatusHealthFindings(config, { pluginVersionReadiness: readiness }),
    ).toEqual([
      expect.objectContaining({
        requirement: "plugin-version-gateway-restart",
        message: expect.stringContaining(`running Gateway is ${runningGatewayVersion}`),
        fixHint: "openclaw gateway restart",
      }),
    ]);

    const noteSpy = vi.spyOn(noteModule, "note").mockImplementation(() => {});
    try {
      noteWorkspaceStatus(config, { pluginVersionReadiness: readiness });
      expect(noteSpy).toHaveBeenCalledWith(
        expect.stringContaining(`Running Gateway: OpenClaw ${runningGatewayVersion}`),
        "Plugin restart readiness",
      );
    } finally {
      noteSpy.mockRestore();
    }
  });

  it("reports older and newer pins as advisory drift while accepting correction suffixes", () => {
    const gatewayVersion = "2026.6.1";

    for (const installedVersion of ["2026.5.30", "2026.6.2"]) {
      const report = detectCodexDrift(installedVersion, gatewayVersion);
      expect(report).toEqual({
        gatewayVersion,
        drifts: [
          {
            pluginId: "codex",
            installedVersion,
            gatewayVersion,
            source: "npm",
            packageName: "@openclaw/codex",
            spec: `@openclaw/codex@${installedVersion}`,
            targetResolution: {
              status: "resolved",
              packageName: "@openclaw/codex",
              requestedTarget: gatewayVersion,
              version: gatewayVersion,
            },
          },
        ],
      });

      expect(
        collectWorkspaceStatusHealthFindings(config, {
          pluginVersionReadiness: { status: "resolved", report },
        }),
      ).toEqual([
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

      const noteSpy = vi.spyOn(noteModule, "note").mockImplementation(() => {});
      try {
        noteWorkspaceStatus(config, {
          pluginVersionReadiness: { status: "resolved", report },
        });
        const driftNotes = noteSpy.mock.calls.filter(
          ([, title]) => title === "Plugin restart readiness",
        );
        expect(driftNotes).toHaveLength(1);
        expect(driftNotes[0]?.[0]).toContain(
          `1 active official plugin not on post-restart OpenClaw ${gatewayVersion}`,
        );
        expect(driftNotes[0]?.[0]).toContain(
          `codex: ${installedVersion} (npm) -> expected ${gatewayVersion}`,
        );
        expect(driftNotes[0]?.[0]).toContain("openclaw plugins update @openclaw/codex@2026.6.1");
        expect(driftNotes[0]?.[0]).toContain("openclaw gateway restart");
      } finally {
        noteSpy.mockRestore();
      }
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
});

describe("ClawHub plugin version drift doctor evidence", () => {
  it.each([
    {
      installedVersion: "2026.9.2",
      pluginApiRange: ">=2026.9.3",
      result: "resolved",
      latestVersion: "2026.9.3",
    },
    {
      installedVersion: "2026.9.3",
      pluginApiRange: ">=2026.9.3",
      result: "current",
      latestVersion: "2026.9.3",
    },
    {
      installedVersion: "2026.9.3",
      pluginApiRange: ">=2026.10.1",
      result: "unresolved",
      latestVersion: "2026.9.3",
    },
    {
      installedVersion: "2026.9.3",
      pluginApiRange: ">=2026.9.3",
      result: "resolved",
      latestVersion: "2026.9.3-1",
    },
  ])(
    "renders $result ClawHub targets consistently",
    async ({ installedVersion, pluginApiRange, result, latestVersion }) => {
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
      const readiness = { status: "resolved" as const, report };
      const findings = collectWorkspaceStatusHealthFindings(
        {},
        { pluginVersionReadiness: readiness },
      );
      const noteSpy = vi.spyOn(noteModule, "note").mockImplementation(() => {});
      try {
        noteWorkspaceStatus({}, { pluginVersionReadiness: readiness });
        expect(findings).toHaveLength(1);
        expect(noteSpy).toHaveBeenCalledOnce();
        const output = String(noteSpy.mock.calls[0]?.[0]);
        if (result === "current") {
          // Registry lag stays visible, but as an explanation with no repair command.
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
      } finally {
        noteSpy.mockRestore();
      }
    },
  );
});
