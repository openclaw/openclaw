import type { ClawAddPlan, ResolvedClawPackage } from "./types.js";

export function packageInstallPlan(
  packages: ResolvedClawPackage[],
  ownerAction: "install" | "reuse" = "install",
): ClawAddPlan {
  return {
    schemaVersion: "openclaw.clawAddPlan.v1",
    manifestSchemaVersion: 1,
    stability: "experimental",
    dryRun: true,
    mutationAllowed: false,
    planIntegrity: "sha256:plan",
    claw: {
      kind: "package",
      name: "incident-claw",
      version: "1.0.0",
      packageRoot: "/tmp/claw",
      manifestPath: "/tmp/claw/claw.json",
      integrityKind: "artifact",
      integrity: "sha256:claw",
      byteLength: 123,
    },
    agent: {
      requestedId: "incident",
      finalId: "incident-2",
      workspace: "/tmp/incident-2",
      config: { id: "incident-2", workspace: "/tmp/incident-2" },
    },
    summary: {
      totalActions: packages.length,
      agentActions: 0,
      workspaceActions: 0,
      packageActions: packages.length,
      mcpServerActions: 0,
      cronJobActions: 0,
      blockedActions: 0,
      capabilityEscalations: 0,
    },
    capabilityChanges: [],
    actions: packages.map((pkg) => ({
      kind: "package",
      id: `${pkg.kind}:${pkg.ref}`,
      action: "install",
      target: `${pkg.source}:${pkg.ref}@${pkg.version}`,
      details: {
        ...pkg,
        ownerAction,
        ...(pkg.kind === "plugin" ? { installId: pkg.ref.split("/").at(-1) } : {}),
      },
      blocked: false,
    })),
    readiness: { ready: true, requirements: [] },
    blockers: [],
    diagnostics: [],
  };
}
