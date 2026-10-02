import { link, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { loadConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { quiescentClawMonitorGateway } from "./lifecycle-remove.test-support.js";
import { applyClawRemovePlan, buildClawRemovePlan, readClawStatus } from "./lifecycle-state.js";
import { createClawRemoveTestFixtures } from "./lifecycle-state.test-helpers.js";
import {
  persistClawInstallRecord,
  persistClawPackageRef,
  readClawPackageRefs,
} from "./provenance.js";

let state: OpenClawTestState;
beforeEach(async () => {
  state = await createOpenClawTestState({ prefix: "claw-remove-config-" });
  await state.writeConfig({});
});
afterEach(async () => {
  closeOpenClawStateDatabaseForTest();
  await state.cleanup();
});
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const { fixture, addFixture } = createClawRemoveTestFixtures(tempDirs, () => state);

function removeOptions(
  current: Awaited<ReturnType<typeof addFixture>>,
  plan: Parameters<typeof applyClawRemovePlan>[0],
  config = current.getConfig(),
) {
  return {
    monitorGateway: quiescentClawMonitorGateway,
    trashPath: async () => true,
    consentPlanIntegrity: plan.planIntegrity,
    env: current.env,
    config,
  };
}

const packageIntegrity = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

describe("Claw remove cleanup and provenance", () => {
  it("preserves a workspace containing operator-created files", async () => {
    const current = await addFixture({ withFile: true });
    const operatorFile = join(current.plan.agent.workspace, "operator-notes.md");
    await writeFile(operatorFile, "keep me\n", "utf8");
    const config = current.getConfig();
    const plan = await buildClawRemovePlan("worker", { env: current.env, config });
    expect(plan.actions).toContainEqual(
      expect.objectContaining({ kind: "workspace", action: "retain" }),
    );
    const trashPath = vi.fn().mockResolvedValue(true);

    await expect(
      applyClawRemovePlan(plan, {
        monitorGateway: quiescentClawMonitorGateway,
        env: current.env,
        config,
        consentPlanIntegrity: plan.planIntegrity,
        purgeSessions: async () => undefined,
        trashPath,
      }),
    ).resolves.toMatchObject({ status: "complete" });
    await expect(readFile(operatorFile, "utf8")).resolves.toBe("keep me\n");
    expect(trashPath).not.toHaveBeenCalledWith(current.plan.agent.workspace, expect.anything());
  });

  it("retains a replacement introduced after planning instead of deleting it", async () => {
    const current = await addFixture({ withFile: true });
    const target = join(current.plan.agent.workspace, "SOUL.md");
    const plan = await buildClawRemovePlan("worker", {
      env: current.env,
      config: current.getConfig(),
    });
    const config = current.getConfig();

    const result = await applyClawRemovePlan(plan, {
      monitorGateway: {
        ...quiescentClawMonitorGateway,
        drain: async () => {
          expect(loadConfig().agents?.entries?.worker).toBeUndefined();
          await writeFile(target, "replacement\n", "utf8");
        },
      },
      trashPath: async () => true,
      consentPlanIntegrity: plan.planIntegrity,
      env: current.env,
      config,
    });

    expect(result).toMatchObject({
      status: "complete",
      workspaceFiles: [{ path: "SOUL.md", action: "retainedModified" }],
    });
    await expect(readFile(target, "utf8")).resolves.toBe("replacement\n");
  });
  it("keeps the install ledger when workspace cleanup becomes unsafe after config commit", async () => {
    const current = await addFixture({ withFile: true });
    const target = join(current.plan.agent.workspace, "SOUL.md");
    const plan = await buildClawRemovePlan("worker", {
      env: current.env,
      config: current.getConfig(),
    });
    const config = current.getConfig();

    const result = await applyClawRemovePlan(plan, {
      monitorGateway: {
        ...quiescentClawMonitorGateway,
        drain: async () => {
          expect(loadConfig().agents?.entries?.worker).toBeUndefined();
          await rm(target);
          await link(join(current.root, "SOUL.md"), target);
        },
      },
      trashPath: async () => true,
      consentPlanIntegrity: plan.planIntegrity,
      env: current.env,
      config,
    });

    expect(result).toMatchObject({
      status: "partial",
      agentRemoved: true,
      workspaceFiles: [{ path: "SOUL.md", action: "error" }],
      error: { code: "workspace_cleanup_failed" },
    });
    await expect(
      readClawStatus("worker", { env: current.env, config: loadConfig() }),
    ).resolves.toMatchObject({
      summary: { claws: 1, missingAgents: 1 },
      records: [{ install: { status: "partial" }, workspaceFiles: [{ state: "unsafe" }] }],
    });
  });

  it("purges session indexes and keeps provenance when canonical trash cleanup fails", async () => {
    const current = await addFixture();
    const config = current.getConfig();
    const plan = await buildClawRemovePlan("worker", { env: current.env, config });
    let purgedAgentId: string | undefined;

    const result = await applyClawRemovePlan(plan, {
      monitorGateway: quiescentClawMonitorGateway,
      consentPlanIntegrity: plan.planIntegrity,
      env: current.env,
      config,
      purgeSessions: async (_cfg, agentId) => {
        purgedAgentId = agentId;
      },
      trashPath: async () => false,
    });

    expect(purgedAgentId).toBe("worker");
    expect(result).toMatchObject({
      status: "partial",
      agentRemoved: true,
      error: { code: "workspace_cleanup_failed" },
    });
    await expect(
      readClawStatus("worker", { env: current.env, config: loadConfig() }),
    ).resolves.toMatchObject({ records: [{ install: { status: "partial" } }] });
  });

  it("releases global plugin references without uninstalling the plugin", async () => {
    const current = await addFixture();
    persistClawPackageRef(
      current.plan,
      {
        kind: "plugin",
        source: "clawhub",
        ref: "audit",
        version: "1.0.0",
        integrity: packageIntegrity,
      },
      {
        env: current.env,
        relationship: "referenced",
        origin: "claw-introduced",
        independentOwner: false,
      },
    );
    const config = current.getConfig();
    const resolvePlugin = vi.fn().mockResolvedValue({
      status: "found",
      pluginId: "audit",
      record: { source: "clawhub", integrity: packageIntegrity },
      installedVersion: "1.0.0",
    });
    const packageDeps = {
      resolvePlugin,
    };
    const plan = await buildClawRemovePlan("worker", {
      env: current.env,
      config,
      packageDeps,
    });
    expect(plan.actions).toContainEqual(
      expect.objectContaining({
        kind: "packageRef",
        action: "release",
        reason: expect.stringContaining("Claw add introduced this shared requirement"),
        details: expect.objectContaining({ introducedByClawAdd: true }),
      }),
    );

    await expect(
      applyClawRemovePlan(plan, {
        ...removeOptions(current, plan, config),
        packageDeps,
      }),
    ).resolves.toMatchObject({ status: "complete", agentRemoved: true });
  });

  it("blocks removal when the created agent config changed", async () => {
    const current = await addFixture();
    const config = current.getConfig();
    const agent = config.agents!.entries!.worker!;
    config.agents!.entries!.worker = { ...agent, name: "Operator edit" };
    const plan = await buildClawRemovePlan("worker", { env: current.env, config });
    expect(plan.blockers).toContainEqual(expect.objectContaining({ code: "agent_modified" }));
    await expect(
      applyClawRemovePlan(plan, {
        ...removeOptions(current, plan, config),
      }),
    ).rejects.toMatchObject({
      code: "remove_blocked",
    });
  });

  it("rejects removal consent for a different plan identity", async () => {
    const current = await addFixture();
    const config = current.getConfig();
    const plan = await buildClawRemovePlan("worker", { env: current.env, config });

    await expect(
      applyClawRemovePlan(plan, {
        monitorGateway: quiescentClawMonitorGateway,
        trashPath: async () => true,
        env: current.env,
        config,
        consentPlanIntegrity: "sha256:stale",
      }),
    ).rejects.toMatchObject({ code: "plan_integrity_mismatch" });
  });

  it("requires an agent id when a package identity has multiple installs", async () => {
    const first = await fixture({ id: "worker-a", name: "@acme/shared" });
    const second = await fixture({ id: "worker-b", name: "@acme/shared" });
    persistClawInstallRecord(first.plan, { env: first.env });
    persistClawInstallRecord(second.plan, { env: first.env });
    const plan = await buildClawRemovePlan("@acme/shared", { env: first.env, config: {} });
    expect(plan.blockers).toContainEqual(expect.objectContaining({ code: "claw_ambiguous" }));
  });

  it("keeps Claw-introduced plugin origin on every surviving Claw reference", async () => {
    const first = await fixture({ id: "worker-a", name: "@acme/first" });
    const second = await fixture({ id: "worker-b", name: "@acme/second" });
    persistClawInstallRecord(first.plan, { env: first.env, nowMs: 1 });
    persistClawInstallRecord(second.plan, { env: first.env, nowMs: 2 });
    const plugin = {
      kind: "plugin",
      source: "clawhub",
      ref: "audit",
      version: "1.0.0",
      integrity: packageIntegrity,
    } as const;
    persistClawPackageRef(first.plan, plugin, {
      env: first.env,
      nowMs: 1,
      relationship: "referenced",
      origin: "claw-introduced",
      independentOwner: false,
    });
    persistClawPackageRef(second.plan, plugin, {
      env: first.env,
      nowMs: 2,
      relationship: "referenced",
      origin: "claw-introduced",
      independentOwner: false,
    });
    const { id: firstId, ...firstConfig } = first.plan.agent.config;
    const { id: secondId, ...secondConfig } = second.plan.agent.config;
    const config: OpenClawConfig = {
      agents: { entries: { [firstId]: firstConfig, [secondId]: secondConfig } },
    };
    await state.writeConfig(config);
    const remove = await buildClawRemovePlan("worker-a", { env: first.env, config });
    await applyClawRemovePlan(remove, {
      monitorGateway: quiescentClawMonitorGateway,
      trashPath: async () => true,
      consentPlanIntegrity: remove.planIntegrity,
      env: first.env,
      config,
    });

    expect(readClawPackageRefs({ env: first.env, agentId: "worker-b" })).toMatchObject([
      {
        ref: "audit",
        relationship: "referenced",
        origin: "claw-introduced",
        independentOwner: false,
      },
    ]);
  });
});
