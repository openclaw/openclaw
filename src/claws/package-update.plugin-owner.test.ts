import { describe, expect, it, vi } from "vitest";
import type { preflightPluginInstall } from "../plugins/plugin-install-preflight.js";
import { applyClawPackageUpdate } from "./package-update.js";
import type { installClawPackages } from "./packages.js";
import { CLAW_PACKAGE_REF_SCHEMA_VERSION, type PersistedClawPackageRef } from "./provenance.js";
import { createClawUpdatePlanFixture } from "./resource-update.test-helpers.js";
import type { ClawAddPlan } from "./types.js";

const previous: PersistedClawPackageRef = {
  schemaVersion: CLAW_PACKAGE_REF_SCHEMA_VERSION,
  agentId: "worker",
  clawName: "@acme/worker",
  kind: "plugin",
  source: "clawhub",
  ref: "audit",
  version: "0.9.0",
  integrity: `sha256:${"a".repeat(64)}`,
  status: "complete",
  relationship: "referenced",
  origin: "claw-introduced",
  independentOwner: false,
  installedAtMs: 5,
  updatedAtMs: 10,
};
const nextPackage = {
  kind: "plugin" as const,
  source: "clawhub" as const,
  ref: "audit",
  version: "1.0.0",
  integrity: `sha256:${"b".repeat(64)}`,
  ownerAction: "install" as const,
};
const targetPlan = {
  agent: { workspace: "/tmp/worker" },
  claw: { name: "@acme/worker" },
  actions: [{ kind: "package", id: "plugin:audit", details: nextPackage }],
} as unknown as ClawAddPlan;
const updatePlan = createClawUpdatePlanFixture([
  {
    kind: "package",
    id: "plugin:audit",
    action: "change",
    target: "clawhub:audit@1.0.0",
    blocked: false,
    reason: "owned upgrade",
  },
]);
const preflightParams = {
  clawhubPackage: "audit",
  rawSpec: "clawhub:audit@1.0.0",
  expectedVersion: "1.0.0",
};

function testDeps(installedAt: () => string) {
  return {
    preflightPlugin: vi.fn(async (_params: Parameters<typeof preflightPluginInstall>[0]) => ({
      ok: false as const,
      code: "plugin_version_conflict" as const,
      request: {} as never,
      installedVersion: "0.9.0",
      expectedVersion: "1.0.0",
    })),
    resolvePlugin: vi.fn(async () => ({
      status: "found" as const,
      pluginId: "audit",
      installedVersion: "0.9.0",
      record: {
        source: "clawhub" as const,
        clawhubPackage: "audit",
        version: "0.9.0",
        integrity: previous.integrity,
        installedAt: installedAt(),
      },
    })),
  };
}

describe("plugin Update ownership", () => {
  it("rejects a direct reinstall between review and package preflight", async () => {
    const deps = testDeps(() => new Date(previous.updatedAtMs + 100).toISOString());
    const installPackages = vi.fn(
      async (_plan: ClawAddPlan, options: Parameters<typeof installClawPackages>[1]) => {
        const preflight = await options?.deps?.preflightPlugin?.(preflightParams);
        if (!preflight?.ok) {
          throw new Error("plugin version conflict");
        }
        return [{ ...previous, version: "1.0.0" }];
      },
    );

    await expect(
      applyClawPackageUpdate(updatePlan, targetPlan, {
        installPackages,
        readRefs: () => [previous],
        replaceExpected: vi.fn(),
        packageDeps: deps,
      }),
    ).rejects.toMatchObject({ partial: false });
  });

  it("rejects a direct reinstall after preflight but before plugin artifact commit", async () => {
    let installedAt = new Date(1).toISOString();
    const deps = testDeps(() => installedAt);
    const installPackages = vi.fn(
      async (_plan: ClawAddPlan, options: Parameters<typeof installClawPackages>[1]) => {
        const preflight = await options?.deps?.preflightPlugin?.(preflightParams);
        if (!preflight?.ok) {
          throw new Error("plugin version conflict");
        }
        installedAt = new Date(previous.updatedAtMs + 100).toISOString();
        await (
          options as typeof options & { assertPluginOwnerCurrent?: () => Promise<void> }
        )?.assertPluginOwnerCurrent?.();
        return [{ ...previous, version: "1.0.0" }];
      },
    );

    await expect(
      applyClawPackageUpdate(updatePlan, targetPlan, {
        installPackages,
        readRefs: () => [previous],
        replaceExpected: vi.fn(),
        packageDeps: deps,
      }),
    ).rejects.toMatchObject({ partial: false });
  });
});
