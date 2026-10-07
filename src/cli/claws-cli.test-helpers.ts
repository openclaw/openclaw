import { mkdir, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { ClawRemovePlan, ClawRemoveResult } from "../claws/lifecycle-remove-contract.js";
import type { ClawUpdatePlan } from "../claws/update-plan-types.js";

export const minimalManifest = {
  schemaVersion: 1,
  agent: { id: "demo-agent", name: "Demo Agent" },
};

export const pluginSetupReadiness = {
  ready: false,
  requirements: [
    {
      kind: "plugin-setup" as const,
      plugin: "market-data",
      provider: "market-data",
      envVars: ["MARKET_DATA_TOKEN"],
      authMethods: ["token"],
    },
  ],
};

export async function canonicalFuturePath(target: string): Promise<string> {
  return join(await realpath(dirname(target)), basename(target));
}

export async function writeManifestFile(
  tempDirs: { make(prefix: string): string },
  value: unknown = minimalManifest,
): Promise<string> {
  const dir = tempDirs.make("openclaw-claws-cli-");
  const path = join(dir, "openclaw.claw.json");
  await writeFile(path, JSON.stringify(value), "utf8");
  return path;
}

export async function writePackageFixture(tempDirs: {
  make(prefix: string): string;
}): Promise<{ root: string; workspace: string }> {
  const root = tempDirs.make("openclaw-claws-cli-package-");
  await mkdir(join(root, "workspace"));
  await writeFile(join(root, "workspace", "AGENTS.md"), "# Demo\n", "utf8");
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      name: "@acme/demo-agent",
      version: "1.2.3",
      openclaw: { claw: "openclaw.claw.json" },
    }),
    "utf8",
  );
  await writeFile(
    join(root, "openclaw.claw.json"),
    JSON.stringify({
      schemaVersion: 1,
      agent: { id: "demo-agent", name: "Demo Agent" },
      workspace: {
        bootstrapFiles: { "AGENTS.md": { source: "workspace/AGENTS.md" } },
      },
      packages: [
        {
          kind: "skill",
          source: "clawhub",
          ref: "@acme/demo-skill",
          version: "1.0.0",
        },
      ],
    }),
    "utf8",
  );
  return { root, workspace: join(root, "target-workspace") };
}

export function createClawRemoveFixtures(): { plan: ClawRemovePlan; result: ClawRemoveResult } {
  return {
    plan: {
      schemaVersion: "openclaw.clawRemovePlan.v1",
      stability: "experimental",
      dryRun: true,
      mutationAllowed: false,
      planIntegrity: "sha256:remove-plan",
      target: "demo-agent",
      agentId: "demo-agent",
      actions: [
        {
          kind: "agent",
          id: "demo-agent",
          action: "remove",
          target: 'agents.entries["demo-agent"]',
          blocked: false,
        },
      ],
      blockers: [],
    },
    result: {
      schemaVersion: "openclaw.clawRemoveResult.v1",
      stability: "experimental",
      dryRun: false,
      status: "complete",
      agentId: "demo-agent",
      agentRemoved: true,
      workspaceFiles: [],
      packages: [],
      mcpServers: [],
      cronJobs: [],
      packageRefsReleased: 1,
    },
  };
}

export function createClawUpdateFixtures() {
  const plan: ClawUpdatePlan = {
    schemaVersion: "openclaw.clawUpdatePlan.v1",
    stability: "experimental",
    dryRun: true,
    mutationAllowed: false,
    planIntegrity: "sha256:update-plan",
    found: true,
    agentId: "demo-agent",
    currentClaw: { name: "@acme/demo-agent", version: "1.0.0", integrity: "sha256:old" },
    targetClaw: { name: "@acme/demo-agent", version: "1.2.3", integrity: "sha256:new" },
    summary: {
      totalActions: 1,
      added: 0,
      changed: 1,
      removed: 0,
      released: 0,
      unchanged: 0,
      manual: 0,
      blocked: 0,
      capabilityChanges: 1,
      capabilityEscalations: 1,
    },
    actions: [],
    capabilityChanges: [
      {
        kind: "agent",
        id: "demo-agent",
        path: "agent.sandbox.mode",
        action: "change",
        classification: "escalation",
        requiresDistinctConsent: true,
        reason: "Agent capability field sandbox.mode changes in the target manifest.",
        effect: { path: "sandbox.mode", current: "non-main", desired: "all" },
        current: { summary: "non-main", digest: "sha256:current" },
        desired: { summary: "all", digest: "sha256:desired" },
      },
    ],
    readiness: pluginSetupReadiness,
    blockers: [],
    diagnostics: [],
  };
  return {
    plan,
    result: {
      schemaVersion: "openclaw.clawUpdateResult.v1",
      stability: "experimental",
      dryRun: false,
      mutationAllowed: true,
      status: "complete",
      agentId: "demo-agent",
      previousClaw: { name: "@acme/demo-agent", version: "1.0.0", integrity: "sha256:old" },
      targetClaw: { name: "@acme/demo-agent", version: "1.2.3", integrity: "sha256:new" },
      appliedActions: [],
      installRecord: { agentId: "demo-agent" },
    },
  };
}

export function createClawExportFixture() {
  return {
    schemaVersion: "openclaw.clawExportResult.v1",
    stability: "experimental",
    agentId: "demo-agent",
    outputDirectory: "/tmp/exported",
    manifest: {
      schemaVersion: 1,
      agent: { id: "demo-agent" },
      workspace: { bootstrapFiles: {}, files: [] },
      packages: [],
      mcpServers: {},
      cronJobs: [],
    },
    filesWritten: ["package.json", "openclaw.claw.json"],
  };
}
