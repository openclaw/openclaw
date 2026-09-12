import { access, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/config.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { applyClawAddPlan } from "./add.js";
import { persistClawInstallRecord, readClawInstallRecord } from "./provenance.js";
import { makeProvenancePlan, readInstallRow, stateEnv } from "./provenance.test-helpers.js";
import { readClawWorkspaceFiles } from "./workspace.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

describe("Claw add legacy plan resume", () => {
  it("records a failed config commit only after persistence resolves", async () => {
    const root = tempDirs.make("openclaw-claw-add-commit-failure-");
    const env = stateEnv(root);
    const { plan } = await makeProvenancePlan(root, {
      schemaVersion: 1,
      agent: { id: "worker" },
    });

    const result = await applyClawAddPlan(plan, {
      consentPlanIntegrity: plan.planIntegrity,
      env,
      commitConfig: async (transform) => {
        transform({});
        throw new Error("config unavailable after transform");
      },
    });

    expect(result).toMatchObject({
      status: "partial",
      workspaceCreated: false,
      configCommitted: false,
      installRecord: { status: "partial" },
      error: { code: "config_commit_failed", message: "config unavailable after transform" },
    });
    await expect(access(plan.agent.workspace)).rejects.toThrow();
    expect(readClawInstallRecord("worker", { env })?.status).toBe("partial");
  });

  it("replaces committed legacy config before upgrading v1 plan identity", async () => {
    const root = tempDirs.make("openclaw-claw-add-v1-resume-");
    const env = stateEnv(root);
    const { plan } = await makeProvenancePlan(root, {
      schemaVersion: 1,
      agent: { id: "worker" },
    });
    const legacyPlan = {
      ...plan,
      planIntegrity: "sha256:legacy-plan",
      agent: {
        ...plan.agent,
        config: {
          ...plan.agent.config,
          tools: { profile: "coding" as const },
        },
      },
    };
    const boundedPlan = {
      ...plan,
      planIntegrity: "sha256:bounded-plan",
      agent: {
        ...plan.agent,
        config: {
          ...plan.agent.config,
          tools: { profile: "full" as const, allow: ["read"] },
        },
      },
    };
    await mkdir(boundedPlan.agent.workspace, { recursive: true });
    persistClawInstallRecord(legacyPlan, { env, status: "workspace_ready", nowMs: 1 });
    openOpenClawStateDatabase({ env })
      .db /* sqlite-allow-raw: test-only downgrade simulates an interrupted v1 add. */
      .prepare("UPDATE claw_installs SET schema_version = ? WHERE agent_id = ?")
      .run("openclaw.clawInstallRecord.v1", "worker");
    const legacyRecord = readClawInstallRecord("worker", { env });
    if (!legacyRecord) {
      throw new Error("expected legacy install record");
    }
    let config: OpenClawConfig = {
      agents: {
        entries: {
          worker: Object.fromEntries(
            Object.entries(legacyPlan.agent.config).filter(([key]) => key !== "id"),
          ),
        },
      },
    };

    const result = await applyClawAddPlan(boundedPlan, {
      env,
      consentPlanIntegrity: legacyPlan.planIntegrity,
      resumeRecord: legacyRecord,
      resumePlan: legacyPlan,
      commitConfig: async (transform) => {
        config = transform(config);
      },
      seedPackageBootstrap: async () => undefined,
      createWorkspaceFiles: async () => [],
      installPackages: async () => [],
      installMcpServers: async () => [],
      installCronJobs: async () => [],
    });

    expect(result.status).toBe("complete");
    expect(config.agents?.entries?.worker).toMatchObject({
      tools: { profile: "full", allow: ["read"] },
    });
    expect(readClawInstallRecord("worker", { env })).toMatchObject({
      schemaVersion: "openclaw.clawInstallRecord.v2",
      planIntegrity: boundedPlan.planIntegrity,
      status: "complete",
    });
  });

  it("retries after v1 promotion fails behind the bounded config commit", async () => {
    const root = tempDirs.make("openclaw-claw-add-v1-promotion-retry-");
    const env = stateEnv(root);
    const { plan } = await makeProvenancePlan(root, {
      schemaVersion: 1,
      agent: { id: "worker" },
    });
    const legacyPlan = {
      ...plan,
      planIntegrity: "sha256:legacy-plan",
      agent: {
        ...plan.agent,
        config: {
          ...plan.agent.config,
          tools: { profile: "coding" as const },
        },
      },
    };
    const boundedPlan = {
      ...plan,
      planIntegrity: "sha256:bounded-plan",
      agent: {
        ...plan.agent,
        config: {
          ...plan.agent.config,
          tools: { profile: "full" as const, allow: ["read"] },
        },
      },
    };
    await mkdir(boundedPlan.agent.workspace, { recursive: true });
    persistClawInstallRecord(legacyPlan, { env, status: "workspace_ready", nowMs: 1 });
    openOpenClawStateDatabase({ env })
      .db /* sqlite-allow-raw: test-only downgrade simulates an interrupted v1 add. */
      .prepare("UPDATE claw_installs SET schema_version = ? WHERE agent_id = ?")
      .run("openclaw.clawInstallRecord.v1", "worker");
    const legacyRecord = readClawInstallRecord("worker", { env });
    if (!legacyRecord) {
      throw new Error("expected legacy install record");
    }
    let config: OpenClawConfig = {
      agents: {
        entries: {
          worker: Object.fromEntries(
            Object.entries(legacyPlan.agent.config).filter(([key]) => key !== "id"),
          ),
        },
      },
    };
    const commitConfig = async (transform: (config: OpenClawConfig) => OpenClawConfig) => {
      config = transform(config);
    };
    const dependencies = {
      env,
      consentPlanIntegrity: legacyPlan.planIntegrity,
      resumeRecord: legacyRecord,
      resumePlan: legacyPlan,
      commitConfig,
      seedPackageBootstrap: async () => undefined,
      createWorkspaceFiles: async () => [],
      installPackages: async () => [],
      installMcpServers: async () => [],
      installCronJobs: async () => [],
    };
    const persistRecord = vi
      .fn<typeof persistClawInstallRecord>()
      .mockImplementationOnce((...args) => persistClawInstallRecord(...args))
      .mockImplementationOnce(() => {
        throw new Error("injected v1 promotion failure");
      });

    const first = await applyClawAddPlan(boundedPlan, { ...dependencies, persistRecord });

    expect(first).toMatchObject({
      status: "partial",
      configCommitted: true,
      error: { message: "injected v1 promotion failure" },
    });
    expect(config.agents?.entries?.worker).toMatchObject({
      tools: { profile: "full", allow: ["read"] },
    });
    expect(readClawInstallRecord("worker", { env })).toMatchObject({
      schemaVersion: "openclaw.clawInstallRecord.v1",
      planIntegrity: legacyPlan.planIntegrity,
      status: "workspace_ready",
    });

    const second = await applyClawAddPlan(boundedPlan, dependencies);

    expect(second.status).toBe("complete");
    expect(readClawInstallRecord("worker", { env })).toMatchObject({
      schemaVersion: "openclaw.clawInstallRecord.v2",
      planIntegrity: boundedPlan.planIntegrity,
      status: "complete",
    });
  });
});

describe("applyClawAddPlan workspace collision revalidation", () => {
  it("fails closed before any workspace effect when live config now has an overlapping agent", async () => {
    const root = tempDirs.make("openclaw-claw-loadconfig-collision-");
    const parent = join(root, "parent");
    await mkdir(parent, { recursive: true });
    // Nothing else is configured at plan time: the plan itself has no blockers.
    const { plan } = await makeProvenancePlan(
      root,
      { schemaVersion: 1, agent: { id: "worker" } },
      { workspace: join(parent, "child") },
    );
    expect(plan.blockers).toEqual([]);
    const env = stateEnv(root);

    // Between planning and applying, a different process configures "other" at the parent
    // directory. loadConfig stands in for a fresh (unpinned) disk read of that race.
    await expect(
      applyClawAddPlan(plan, {
        consentPlanIntegrity: plan.planIntegrity,
        env,
        loadConfig: async () => ({ agents: { entries: { other: { workspace: parent } } } }),
      }),
    ).rejects.toMatchObject({ code: "workspace_collision" });

    expect(readInstallRow("worker", root)).toBeUndefined();
    expect(readClawWorkspaceFiles("worker", { env })).toEqual([]);
    await expect(access(plan.agent.workspace)).rejects.toThrow();
  });
});
