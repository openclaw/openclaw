import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { readClawStatus } from "./lifecycle-status.js";
import { applyClawMigrationPlan, buildClawMigrationPlan } from "./migrate.js";
import { readClawInstallRecord } from "./provenance.js";
import { applyClawUpdatePlan } from "./update-apply.js";
import { buildClawUpdatePlan } from "./update-plan.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(closeOpenClawStateDatabaseForTest);

async function fixture() {
  const root = tempDirs.make("openclaw-adopted-update-");
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const env = { OPENCLAW_STATE_DIR: join(root, "state") };
  const config: OpenClawConfig = {
    agents: {
      defaults: { model: "provider/inherited" },
      entries: { worker: { name: "Worker", workspace: `${workspace}/.` } },
    },
  };
  const migration = await buildClawMigrationPlan({
    agentId: "worker",
    config,
    options: { env },
  });
  await applyClawMigrationPlan({ migration, config, options: { env } });
  const installed = readClawInstallRecord("worker", { env });
  const target = {
    targetManifest: {
      ...migration.manifest,
      agent: { ...migration.manifest.agent, name: "Worker v2" },
    },
    // The updated package continues to inherit the host model.
    targetOpenClawProfile: { schemaVersion: 1 as const, agent: {} },
    targetSource: { ...migration.addPlan.claw, version: "2.0.0", integrity: "sha256:updated" },
  };
  const plan = await buildClawUpdatePlan({
    agentId: "worker",
    ...target,
    config,
    sourceMcpServers: {},
    stateOptions: { env },
  });
  expect(plan.blockers).toEqual([]);
  expect(plan.actions).toContainEqual(
    expect.objectContaining({ kind: "agent", action: "change", blocked: false }),
  );
  return { config, env, installed, plan, target, workspace: migration.plan.workspace };
}

describe("updating an adopted agent", () => {
  it("keeps operator-owned model and delegation changes outside Claw drift", async () => {
    const current = await fixture();
    const config: OpenClawConfig = {
      ...current.config,
      agents: {
        ...current.config.agents,
        defaults: {
          model: "provider/operator-change",
          subagents: { allowAgents: ["researcher"] },
        },
      },
    };

    await expect(
      readClawStatus("worker", { config, env: current.env, sourceMcpServers: {} }),
    ).resolves.toMatchObject({ records: [{ agentState: "present" }] });
    const plan = await buildClawUpdatePlan({
      agentId: "worker",
      ...current.target,
      config,
      sourceMcpServers: {},
      stateOptions: { env: current.env },
    });
    expect(plan.blockers).toEqual([]);
  });

  it("updates a present agent with inherited settings and keeps status consistent", async () => {
    const current = await fixture();
    let config = current.config;

    await expect(
      applyClawUpdatePlan(current.plan, current.target, {
        config,
        env: current.env,
        sourceMcpServers: {},
        consentPlanIntegrity: current.plan.planIntegrity,
        commitConfig: async (transform) => {
          config = transform(config, config);
        },
      }),
    ).resolves.toMatchObject({ status: "complete", installRecord: { agentOrigin: "adopted" } });

    expect(config.agents?.entries?.worker).toEqual({
      name: "Worker v2",
      workspace: current.workspace,
    });
    expect(config.agents?.defaults).toEqual(current.config.agents?.defaults);
    await expect(
      readClawStatus("worker", { config, env: current.env, sourceMcpServers: {} }),
    ).resolves.toMatchObject({ records: [{ agentState: "present" }] });
  });

  it("restores the original authored entry when a later update step fails", async () => {
    const current = await fixture();
    let config = current.config;
    let reachedCron = false;

    await expect(
      applyClawUpdatePlan(current.plan, current.target, {
        config,
        env: current.env,
        sourceMcpServers: {},
        consentPlanIntegrity: current.plan.planIntegrity,
        commitConfig: async (transform) => {
          config = transform(config, config);
        },
        applyCron: async () => {
          reachedCron = true;
          expect(config.agents?.entries?.worker?.name).toBe("Worker v2");
          throw new Error("cron unavailable");
        },
      }),
    ).rejects.toMatchObject({ code: "cron_update_failed" });

    expect(reachedCron).toBe(true);
    expect(config).toEqual(current.config);
    expect(readClawInstallRecord("worker", { env: current.env })).toEqual(current.installed);
    await expect(
      readClawStatus("worker", { config, env: current.env, sourceMcpServers: {} }),
    ).resolves.toMatchObject({ records: [{ agentState: "present" }] });
  });

  it("preserves an operator model change while rolling back owned fields", async () => {
    const current = await fixture();
    let config = current.config;

    await expect(
      applyClawUpdatePlan(current.plan, current.target, {
        config,
        env: current.env,
        sourceMcpServers: {},
        consentPlanIntegrity: current.plan.planIntegrity,
        commitConfig: async (transform) => {
          config = transform(config, config);
        },
        applyCron: async () => {
          config = {
            ...config,
            agents: { ...config.agents, defaults: { model: "provider/operator-change" } },
          };
          throw new Error("cron unavailable");
        },
      }),
    ).rejects.toMatchObject({ code: "cron_update_failed" });

    expect(config.agents?.defaults?.model).toBe("provider/operator-change");
    expect(config.agents?.entries?.worker?.name).toBe("Worker");
    expect(readClawInstallRecord("worker", { env: current.env })).toEqual(current.installed);
  });
});
