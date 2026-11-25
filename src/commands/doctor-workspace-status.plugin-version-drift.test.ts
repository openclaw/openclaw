import { expect, it, vi } from "vitest";
import { recordDoctorHealthWarnings } from "../flows/doctor-health-contribution.js";
import {
  updateRunStepsFromResultStep,
  updateRunWarningMessages,
} from "../infra/update-run-step.js";
import type {
  PluginVersionDriftReport,
  PluginVersionRestartReadiness,
} from "../plugins/plugin-version-drift.js";
import { collectWorkspaceStatusHealthFindings } from "./doctor-workspace-status.js";

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

function findings(pluginVersionReadiness: PluginVersionRestartReadiness, env?: NodeJS.ProcessEnv) {
  return collectWorkspaceStatusHealthFindings({}, { pluginVersionReadiness, env });
}

it("reports unresolved restart readiness", () => {
  expect(
    findings({ status: "unresolved", reason: "Gateway service package version is unavailable." }),
  ).toEqual([
    expect.objectContaining({
      requirement: "plugin-version-restart-readiness",
      message: expect.stringContaining("Gateway service package version is unavailable"),
    }),
  ]);
});

it.each([
  ["2026.5.30", "plugin-version-gateway-restart"],
  ["2026.6.1-1", undefined],
] as const)(
  "reports restart readiness for running Gateway %s",
  (runningGatewayVersion, requirement) => {
    const result = findings({
      status: "resolved",
      runningGatewayVersion,
      report: { gatewayVersion: "2026.6.1", drifts: [] },
    });
    expect(result).toEqual(
      requirement
        ? [
            expect.objectContaining({
              requirement,
              message: expect.stringContaining("running Gateway is 2026.5.30"),
              fixHint: "openclaw gateway restart",
            }),
          ]
        : [],
    );
  },
);

type Drift = PluginVersionDriftReport["drifts"][number];
const gatewayVersion = "2026.9.4";
const packageName = "@openclaw/whatsapp";
const target = { packageName, requestedTarget: gatewayVersion };
function report(
  source: Drift["source"],
  targetResolution: Drift["targetResolution"],
  env?: NodeJS.ProcessEnv,
) {
  return findings(
    {
      status: "resolved",
      report: {
        gatewayVersion,
        drifts: [
          {
            pluginId: "whatsapp",
            installedVersion:
              targetResolution?.status === "registry-current"
                ? targetResolution.version
                : "2026.9.2",
            gatewayVersion,
            source,
            packageName,
            spec:
              source === "npm"
                ? targetResolution === undefined
                  ? "@openclaw/whatsapp"
                  : "@openclaw/whatsapp@2026.9.2"
                : "clawhub:@openclaw/whatsapp",
            targetResolution,
          },
        ],
      },
    },
    env,
  );
}

const packageSwapEnv = {
  OPENCLAW_UPDATE_IN_PROGRESS: "1",
  OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE: "1",
};
const convergenceEnv = {
  ...packageSwapEnv,
  OPENCLAW_UPDATE_POST_CORE_CONVERGENCE: "1",
};

it.each([
  undefined,
  { ...target, status: "resolved", version: gatewayVersion },
  { ...target, status: "unresolved", error: "target unavailable" },
] as const)(
  "keeps a pending npm cohort upgrade out of the completed update's warning list (%s)",
  (targetResolution) => {
    const ctx = { updateWarnings: ["Unrelated advisory"] };
    const beforeConvergence = report("npm", targetResolution, packageSwapEnv);
    recordDoctorHealthWarnings(ctx, beforeConvergence);
    expect(beforeConvergence).toEqual([
      expect.objectContaining({
        severity: "info",
        requirement: "plugin-version-drift",
        message: expect.stringContaining("post-core plugin convergence"),
      }),
    ]);
    expect(beforeConvergence[0]?.fixHint).toBeUndefined();
    recordDoctorHealthWarnings(
      ctx,
      findings(
        {
          status: "resolved",
          report: { gatewayVersion, drifts: [] },
          runningGatewayVersion: gatewayVersion,
        },
        convergenceEnv,
      ),
    );
    const steps = updateRunStepsFromResultStep({
      name: "post-install doctor",
      exitCode: 0,
      warnings: ctx.updateWarnings,
    });
    expect(updateRunWarningMessages(steps)).toEqual(["Unrelated advisory"]);
  },
);

it.each([
  ["ordinary Doctor", {}, "npm", "resolved"],
  ["post-core convergence", convergenceEnv, "npm", "resolved"],
  ["update without a convergence promise", { OPENCLAW_UPDATE_IN_PROGRESS: "1" }, "npm", "resolved"],
  ["target lookup failure after convergence", convergenceEnv, "npm", "unresolved"],
  ["ClawHub drift", packageSwapEnv, "clawhub", "resolved"],
] as const)("retains actionable version drift during %s", (_name, env, source, status) => {
  const ctx = { updateWarnings: [] as string[] };
  const result = report(
    source,
    status === "resolved"
      ? { ...target, status, version: gatewayVersion }
      : { ...target, status, error: "target unavailable" },
    env,
  );
  expect(result).toEqual([expect.objectContaining({ severity: "warning" })]);
  recordDoctorHealthWarnings(ctx, result);
  expect(ctx.updateWarnings).toEqual([expect.stringContaining("Plugin whatsapp is")]);
});

// Detection, correction cohorts, and registry compatibility belong to plugin-version-drift.test.ts.
it.each(["npm", "clawhub"] as const)("renders confirmed %s repair targets", (source) => {
  expect(report(source, { ...target, status: "resolved", version: gatewayVersion })).toEqual([
    expect.objectContaining({
      severity: "warning",
      requirement: "plugin-version-drift",
      path: "plugins.entries.whatsapp",
      target: "whatsapp",
      message: expect.stringContaining("confirmed plugin target is 2026.9.4"),
      fixHint:
        source === "npm"
          ? "openclaw plugins update @openclaw/whatsapp@2026.9.4 && openclaw gateway restart"
          : "openclaw plugins update whatsapp && openclaw gateway restart",
    }),
  ]);
});

it("explains registry lag without offering an unavailable update", () => {
  const result = report("clawhub", { ...target, status: "registry-current", version: "2026.9.3" });
  expect(result).toHaveLength(1);
  expect(result[0]?.severity).toBe("info");
  expect(result[0]?.message).toContain("registry version 2026.9.3");
  expect(result[0]?.message).toContain("No plugin update can reach 2026.9.4");
  expect(result[0]?.fixHint).toContain("No plugin repair is available");
});

it("reports incompatible targets without an install command", () => {
  const result = report("clawhub", {
    ...target,
    status: "unresolved",
    error: "requires plugin API >=2026.10.1",
  });
  expect(result).toHaveLength(1);
  expect(result[0]?.message).toContain("requires plugin API >=2026.10.1");
  expect(result[0]?.fixHint).not.toContain("openclaw plugins update");
});
