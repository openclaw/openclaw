import { describe, expect, it, vi } from "vitest";
import { applyClawPackageUpdate } from "./package-update.js";
import { CLAW_PACKAGE_REF_SCHEMA_VERSION, type PersistedClawPackageRef } from "./provenance.js";
import { CLAW_OUTPUT_STABILITY, type ClawAddPlan, type ClawManifest } from "./types.js";
import { CLAW_UPDATE_PLAN_SCHEMA_VERSION, type ClawUpdatePlan } from "./update-plan.js";

function ref(kind: "skill" | "plugin", name: string, version: string): PersistedClawPackageRef {
  return {
    schemaVersion: CLAW_PACKAGE_REF_SCHEMA_VERSION,
    agentId: "worker",
    clawName: "@acme/worker",
    kind,
    source: "clawhub",
    ref: name,
    version,
    status: "complete",
    ownership: "claw-installed",
    installedAtMs: 10,
  };
}

function plan(actions: ClawUpdatePlan["actions"]): ClawUpdatePlan {
  return {
    schemaVersion: CLAW_UPDATE_PLAN_SCHEMA_VERSION,
    stability: CLAW_OUTPUT_STABILITY,
    dryRun: true,
    mutationAllowed: false,
    found: true,
    agentId: "worker",
    currentClaw: { name: "@acme/worker", version: "1.0.0", integrity: "sha256:old" },
    targetClaw: { name: "@acme/worker", version: "2.0.0", integrity: "sha256:new" },
    summary: {
      totalActions: actions.length,
      added: actions.filter((action) => action.action === "add").length,
      changed: actions.filter((action) => action.action === "change").length,
      removed: actions.filter((action) => action.action === "remove").length,
      unchanged: 0,
      manual: 0,
      blocked: 0,
    },
    actions,
    blockers: [],
    diagnostics: [],
  };
}

const manifest: ClawManifest = {
  schemaVersion: 1,
  agent: { id: "worker" },
  workspace: { bootstrapFiles: {}, files: [] },
  packages: [
    { kind: "skill", source: "clawhub", ref: "triage", version: "2.0.0" },
    { kind: "plugin", source: "clawhub", ref: "audit", version: "1.0.0" },
  ],
  mcpServers: {},
  cronJobs: [],
};

const addPlan: ClawAddPlan = {
  schemaVersion: "openclaw.clawAddPlan.v1",
  stability: CLAW_OUTPUT_STABILITY,
  dryRun: true,
  mutationAllowed: false,
  claw: {
    kind: "package",
    name: "@acme/worker",
    version: "2.0.0",
    packageRoot: "/tmp/claw",
    manifestPath: "/tmp/claw/openclaw.claw.json",
    integrity: "sha256:new",
  },
  agent: {
    requestedId: "worker",
    finalId: "worker",
    workspace: "/tmp/worker",
    config: { id: "worker", workspace: "/tmp/worker" },
  },
  summary: {
    totalActions: 2,
    agentActions: 0,
    workspaceActions: 0,
    packageActions: 2,
    mcpServerActions: 0,
    cronJobActions: 0,
    blockedActions: 0,
  },
  actions: manifest.packages.map((pkg) => ({
    kind: "package",
    id: `${pkg.kind}:${pkg.ref}`,
    action: "install",
    target: `clawhub:${pkg.ref}@${pkg.version}`,
    details: pkg,
    blocked: false,
  })),
  blockers: [],
  diagnostics: [],
};

describe("applyClawPackageUpdate", () => {
  it("updates exact references but reports retained artifacts on rollback", async () => {
    const oldSkill = ref("skill", "triage", "1.0.0");
    const legacy = ref("plugin", "legacy", "1.0.0");
    const installPackages = vi.fn(async (current: ClawAddPlan) => {
      const details = current.actions[0]?.details as {
        kind: "skill" | "plugin";
        ref: string;
        version: string;
      };
      return [ref(details.kind, details.ref, details.version)];
    });
    const replaceExpected = vi.fn();
    const execution = await applyClawPackageUpdate(
      plan([
        {
          kind: "package",
          id: "skill:triage",
          action: "change",
          target: "clawhub:triage@2.0.0",
          blocked: false,
          reason: "changed",
        },
        {
          kind: "package",
          id: "plugin:audit",
          action: "add",
          target: "clawhub:audit@1.0.0",
          blocked: false,
          reason: "added",
        },
        {
          kind: "package",
          id: "plugin:legacy",
          action: "remove",
          target: "clawhub:legacy@1.0.0",
          blocked: false,
          reason: "removed",
        },
      ]),
      manifest,
      addPlan,
      {
        installPackages,
        readRefs: () => [oldSkill, legacy],
        replaceExpected,
      },
    );

    expect(execution.appliedIds).toEqual(["skill:triage", "plugin:audit", "plugin:legacy"]);
    expect(installPackages).toHaveBeenCalledTimes(2);
    expect(replaceExpected).toHaveBeenCalledWith(
      oldSkill,
      expect.objectContaining({ version: "2.0.0", status: "pending" }),
      expect.any(Object),
    );
    expect(replaceExpected).toHaveBeenCalledWith(legacy, undefined, expect.any(Object));

    await expect(execution.rollback()).rejects.toMatchObject({ partial: true });
    expect(replaceExpected).toHaveBeenCalledWith(undefined, legacy, expect.any(Object));
    expect(replaceExpected).toHaveBeenCalledWith(
      expect.objectContaining({ version: "2.0.0", status: "complete" }),
      oldSkill,
      expect.any(Object),
    );
  });

  it("reverses reference-only removal without uninstalling or reporting partial state", async () => {
    const legacy = ref("plugin", "legacy", "1.0.0");
    const replaceExpected = vi.fn();
    const execution = await applyClawPackageUpdate(
      plan([
        {
          kind: "package",
          id: "plugin:legacy",
          action: "remove",
          target: "clawhub:legacy@1.0.0",
          blocked: false,
          reason: "removed",
        },
      ]),
      { ...manifest, packages: [] },
      { ...addPlan, actions: [] },
      { readRefs: () => [legacy], replaceExpected },
    );

    await expect(execution.rollback()).resolves.toBeUndefined();
    expect(replaceExpected).toHaveBeenNthCalledWith(1, legacy, undefined, expect.any(Object));
    expect(replaceExpected).toHaveBeenNthCalledWith(2, undefined, legacy, expect.any(Object));
  });

  it("does not replace a shared plugin pinned by another Claw", async () => {
    const installPackages = vi.fn();
    const otherOwner = { ...ref("plugin", "audit", "0.9.0"), agentId: "other" };
    await expect(
      applyClawPackageUpdate(
        plan([
          {
            kind: "package",
            id: "plugin:audit",
            action: "add",
            target: "clawhub:audit@1.0.0",
            blocked: false,
            reason: "added",
          },
        ]),
        manifest,
        addPlan,
        {
          installPackages,
          readRefs: (options) => (options?.agentId ? [] : [otherOwner]),
        },
      ),
    ).rejects.toMatchObject({ partial: false });
    expect(installPackages).not.toHaveBeenCalled();
  });

  it("does not invoke an installer when package ownership changes after planning", async () => {
    const oldSkill = ref("skill", "triage", "1.0.0");
    const installPackages = vi.fn();
    const replaceExpected = vi.fn(() => {
      throw new Error('Package reference "skill:triage" changed after planning.');
    });

    await expect(
      applyClawPackageUpdate(
        plan([
          {
            kind: "package",
            id: "skill:triage",
            action: "change",
            target: "clawhub:triage@2.0.0",
            blocked: false,
            reason: "changed",
          },
        ]),
        manifest,
        addPlan,
        { installPackages, readRefs: () => [oldSkill], replaceExpected },
      ),
    ).rejects.toMatchObject({ partial: false });
    expect(installPackages).not.toHaveBeenCalled();
  });
});
