import { access, mkdir, rename, rmdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { applyClawAddPlan } from "./add.js";
import { emptyPluginPlanEvidence } from "./packages.test-support.js";
import { persistClawPackageRef, readClawInstallRecord, readClawPackageRefs } from "./provenance.js";
import { makeProvenancePlan, stateEnv } from "./provenance.test-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeStateDatabaseForTest();
    cleanup();
  }),
);

describe("Claw Add recovery", () => {
  it("keeps the original path error and pending record when cleanup is refused", async () => {
    const root = tempDirs.make("claw-add-path-recovery-");
    const env = stateEnv(root);
    const parent = join(root, "canonical");
    const alternate = join(root, "alternate");
    await mkdir(parent);
    await mkdir(alternate);
    const { plan } = await makeProvenancePlan(
      root,
      { schemaVersion: 1, agent: { id: "worker" } },
      { workspace: join(parent, "workspace") },
    );
    await rmdir(parent);
    await symlink(alternate, parent, process.platform === "win32" ? "junction" : "dir");

    const result = await applyClawAddPlan(plan, {
      env,
      consentPlanIntegrity: plan.planIntegrity,
      deleteRecord: () => {
        throw new Error("Synthetic cleanup refusal");
      },
    });

    expect(result).toMatchObject({
      status: "partial",
      workspaceCreated: false,
      configCommitted: false,
      installRecord: { status: "pending" },
      error: { code: "workspace_path_changed" },
    });
    expect(result.error?.message).not.toContain("cleanup refusal");
    expect(readClawInstallRecord("worker", { env })?.status).toBe("pending");
    await expect(access(join(alternate, "workspace"))).rejects.toThrow();
  });

  it("preserves a committed config in an early retry recovery result", async () => {
    const root = tempDirs.make("claw-add-retry-recovery-");
    const env = stateEnv(root);
    const parent = join(root, "parent");
    await mkdir(parent);
    const { plan } = await makeProvenancePlan(
      root,
      { schemaVersion: 1, agent: { id: "worker" } },
      { workspace: join(parent, "workspace") },
    );
    const options = {
      env,
      consentPlanIntegrity: plan.planIntegrity,
      commitConfig: async () => {},
    };
    const first = await applyClawAddPlan(plan, {
      ...options,
      createWorkspaceFiles: async () => {
        throw new Error("Synthetic workspace-file failure");
      },
    });
    expect(first).toMatchObject({
      status: "partial",
      configCommitted: true,
      installRecord: { status: "config_committed" },
    });

    await rename(parent, join(root, "saved-parent"));
    await writeFile(parent, "not a directory");
    const retry = await applyClawAddPlan(plan, {
      ...options,
      resumeRecord: readClawInstallRecord("worker", { env }),
    });

    expect(retry).toMatchObject({
      status: "partial",
      configCommitted: true,
      installRecord: { status: "config_committed" },
      error: { code: "workspace_parent_failed" },
    });
    expect(readClawInstallRecord("worker", { env })?.status).toBe("config_committed");
  });

  it("reports a created workspace when phase recording and rollback are refused", async () => {
    const root = tempDirs.make("claw-add-phase-recovery-");
    const env = stateEnv(root);
    const { plan } = await makeProvenancePlan(root, {
      schemaVersion: 1,
      agent: { id: "worker" },
    });
    let retired = false;

    const result = await applyClawAddPlan(plan, {
      env,
      consentPlanIntegrity: plan.planIntegrity,
      assertCurrent: () => {
        if (retired) {
          throw new Error("Synthetic authority retired");
        }
      },
      updateRecord: () => {
        retired = true;
        throw new Error("Synthetic phase write refused");
      },
    });

    expect(result).toMatchObject({
      status: "partial",
      workspaceCreated: true,
      configCommitted: false,
      installRecord: { status: "pending" },
      error: { code: "provenance_failed", message: "Synthetic phase write refused" },
    });
    expect(readClawInstallRecord("worker", { env })?.status).toBe("pending");
    await expect(access(plan.agent.workspace)).resolves.toBeUndefined();
  });

  it("retains plugin ownership when workspace phase recording fails after installation", async () => {
    const root = tempDirs.make("claw-add-plugin-phase-recovery-");
    const env = stateEnv(root);
    const pkg = {
      kind: "plugin" as const,
      source: "clawhub" as const,
      ref: "@acme/audit",
      version: "1.0.0",
      integrity: `sha256:${"a".repeat(64)}`,
    };
    const { plan } = await makeProvenancePlan(
      root,
      {
        schemaVersion: 1,
        agent: { id: "worker" },
        packages: [{ kind: pkg.kind, source: pkg.source, ref: pkg.ref, version: pkg.version }],
      },
      {
        packagePreflight: async () => ({
          ok: true,
          action: "install",
          integrity: pkg.integrity,
          installId: "audit",
          ...emptyPluginPlanEvidence,
        }),
      },
    );
    expect(plan.blockers).toEqual([]);

    const result = await applyClawAddPlan(plan, {
      env,
      consentPlanIntegrity: plan.planIntegrity,
      installPackages: async () => [
        persistClawPackageRef(plan, pkg, { env, relationship: "managed" }),
      ],
      updateRecord: () => {
        throw new Error("Synthetic phase write refused");
      },
    });

    expect(result).toMatchObject({
      status: "partial",
      workspaceCreated: false,
      configCommitted: false,
      packages: [{ ref: pkg.ref, status: "complete" }],
      installRecord: { status: "pending" },
      error: { code: "provenance_failed", message: "Synthetic phase write refused" },
    });
    expect(readClawInstallRecord("worker", { env })?.status).toBe("pending");
    expect(readClawPackageRefs({ env, agentId: "worker" })).toMatchObject([
      { ref: pkg.ref, status: "complete" },
    ]);
    await expect(access(plan.agent.workspace)).rejects.toThrow();
  });

  it("keeps a workspace collision primary when recording partial status fails", async () => {
    const root = tempDirs.make("claw-add-collision-recovery-");
    const env = stateEnv(root);
    const { plan } = await makeProvenancePlan(root, {
      schemaVersion: 1,
      agent: { id: "worker" },
    });
    await mkdir(plan.agent.workspace, { recursive: true });

    const result = await applyClawAddPlan(plan, {
      env,
      consentPlanIntegrity: plan.planIntegrity,
      updateRecord: () => {
        throw new Error("Synthetic status write refusal");
      },
    });

    expect(result).toMatchObject({
      status: "partial",
      workspaceCreated: false,
      configCommitted: false,
      installRecord: { status: "pending" },
      error: { code: "workspace_collision" },
    });
    expect(result.error?.message).not.toContain("status write refusal");
    expect(readClawInstallRecord("worker", { env })?.status).toBe("pending");
    await expect(access(plan.agent.workspace)).resolves.toBeUndefined();
  });
});
