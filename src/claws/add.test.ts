import { access, mkdir, rmdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/config.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { applyClawAddPlan } from "./add.js";
import { readClawStatus } from "./lifecycle-state.js";
import { buildClawAddPlan } from "./lifecycle.js";
import { persistClawInstallRecord, readClawInstallRecord } from "./provenance.js";
import { makeProvenancePlan, readInstallRow, stateEnv } from "./provenance.test-helpers.js";
import type { ClawOpenClawProfile } from "./types.js";
import { applyClawUpdatePlan } from "./update-apply.js";
import { consent, manifest, source } from "./update-apply.test-helpers.js";
import { buildClawUpdatePlan } from "./update-plan.js";
import { readClawWorkspaceFiles } from "./workspace.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    cleanup();
  }),
);

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe("Claw add lifecycle", () => {
  it("applies, tracks drift, updates, and removes profile model and delegation settings", async () => {
    const root = tempDirs.make("openclaw-claw-update-profile-");
    const env = { OPENCLAW_STATE_DIR: join(root, "state") };
    const localSource = { ...source, packageRoot: root };
    const agentProfile: ClawOpenClawProfile["agent"] = {
      model: { primary: "acme/primary", fallbacks: ["acme/fallback"] },
      subagents: { allowAgents: ["researcher"], delegationMode: "prefer" },
    };
    const initial = await buildClawAddPlan({
      manifest,
      source: localSource,
      openClawProfile: { schemaVersion: 1, agent: agentProfile },
      context: { workspace: join(root, "workspace") },
    });
    let config: OpenClawConfig = {};
    const commitConfig = async (transform: (current: OpenClawConfig) => OpenClawConfig) => {
      config = transform(config);
    };
    await applyClawAddPlan(initial, {
      env,
      commitConfig,
      consentPlanIntegrity: initial.planIntegrity,
    });
    expect(config.agents?.entries?.worker).toMatchObject(agentProfile);
    await expect(readClawStatus("worker", { env, config })).resolves.toMatchObject({
      records: [{ agentState: "present" }],
    });
    for (const change of [
      { model: { primary: "acme/operator" } },
      { subagents: { allowAgents: [] } },
    ]) {
      const modified = structuredClone(config);
      Object.assign(modified.agents!.entries!.worker!, change);
      await expect(readClawStatus("worker", { env, config: modified })).resolves.toMatchObject({
        records: [{ agentState: "modified" }],
      });
    }
    const targetProfiles: ClawOpenClawProfile["agent"][] = [
      {
        model: { primary: "acme/replacement", fallbacks: [] },
        subagents: { allowAgents: [], delegationMode: "suggest" },
      },
      {},
    ];
    for (const agent of targetProfiles) {
      const target = {
        targetManifest: manifest,
        targetSource: localSource,
        targetOpenClawProfile: { schemaVersion: 1 as const, agent },
      };
      const update = await buildClawUpdatePlan({
        ...target,
        agentId: "worker",
        config,
        sourceMcpServers: {},
        stateOptions: { env },
      });
      expect(update.blockers).toEqual([]);
      expect(update.actions).toContainEqual(
        expect.objectContaining({ kind: "agent", action: "change" }),
      );
      expect(update.capabilityChanges.map((change) => change.path)).toEqual(
        expect.arrayContaining([
          "agent.model",
          "agent.subagents.allowAgents",
          "agent.subagents.delegationMode",
        ]),
      );
      await expect(
        applyClawUpdatePlan(update, target, {
          env,
          config,
          commitConfig,
          ...consent(update),
        }),
      ).resolves.toMatchObject({ status: "complete" });
      expect(config.agents?.entries?.worker?.model).toEqual(agent.model);
      expect(config.agents?.entries?.worker?.subagents).toEqual(agent.subagents);
      await expect(readClawStatus("worker", { env, config })).resolves.toMatchObject({
        records: [{ agentState: "present" }],
      });
    }
  });

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
      installRecord: { status: "config_committed" },
      error: { message: "injected v1 promotion failure" },
    });
    expect(config.agents?.entries?.worker).toMatchObject({
      tools: { profile: "full", allow: ["read"] },
    });
    expect(readClawInstallRecord("worker", { env })).toMatchObject({
      schemaVersion: "openclaw.clawInstallRecord.v1",
      planIntegrity: legacyPlan.planIntegrity,
      status: "config_committed",
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
  it("keeps a second same-agent apply outside ownership while the first lease is live", async () => {
    const root = tempDirs.make("openclaw-claw-add-lease-");
    const parent = join(root, "parent");
    await mkdir(parent, { recursive: true });
    const { plan } = await makeProvenancePlan(
      root,
      { schemaVersion: 1, agent: { id: "worker" } },
      { workspace: join(parent, "workspace") },
    );
    const env = stateEnv(root);
    const firstEntered = deferred();
    const releaseFirst = deferred();
    const first = applyClawAddPlan(plan, {
      consentPlanIntegrity: plan.planIntegrity,
      env,
      readConfigForApply: async () => {
        firstEntered.resolve();
        await releaseFirst.promise;
        return { agents: { entries: { other: { workspace: parent } } } };
      },
    });
    await firstEntered.promise;

    const secondController = new AbortController();
    const secondPersist = vi.fn<typeof persistClawInstallRecord>((...args) =>
      persistClawInstallRecord(...args),
    );
    const second = applyClawAddPlan(plan, {
      consentPlanIntegrity: plan.planIntegrity,
      env,
      signal: secondController.signal,
      persistRecord: secondPersist,
    });
    await Promise.resolve();
    secondController.abort(new Error("stop waiting for the first apply"));

    await expect(second).rejects.toMatchObject({ code: "apply_lease_failed" });
    expect(secondPersist).not.toHaveBeenCalled();

    releaseFirst.resolve();
    await expect(first).rejects.toMatchObject({ code: "workspace_collision" });
    expect(readClawInstallRecord("worker", { env })).toBeUndefined();

    await expect(
      applyClawAddPlan(plan, {
        consentPlanIntegrity: plan.planIntegrity,
        env,
        commitConfig: async (transform) => {
          transform({});
        },
        seedPackageBootstrap: async () => undefined,
        createWorkspaceFiles: async () => [],
        installPackages: async () => [],
        installMcpServers: async () => [],
        installCronJobs: async () => [],
      }),
    ).resolves.toMatchObject({ status: "complete" });
    expect(readClawInstallRecord("worker", { env })?.status).toBe("complete");
  });

  it("clears a fresh install record when bootstrap publication preparation fails", async () => {
    const root = tempDirs.make("openclaw-claw-bootstrap-prepare-fresh-");
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const { plan } = await makeProvenancePlan(
      root,
      { schemaVersion: 1, agent: { id: "worker" } },
      { workspace, adoptExistingWorkspace: true },
    );
    const env = stateEnv(root);

    await expect(
      applyClawAddPlan(plan, {
        consentPlanIntegrity: plan.planIntegrity,
        env,
        prepareBootstrapPublication: () => {
          throw new Error("injected publication preparation failure");
        },
      }),
    ).rejects.toMatchObject({
      code: "bootstrap_prepare_failed",
      message: "injected publication preparation failure",
    });

    expect(readClawInstallRecord("worker", { env })).toBeUndefined();
  });

  it("preserves a reused install record when bootstrap publication preparation fails", async () => {
    const root = tempDirs.make("openclaw-claw-bootstrap-prepare-resume-");
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const { plan } = await makeProvenancePlan(
      root,
      { schemaVersion: 1, agent: { id: "worker" } },
      { workspace, adoptExistingWorkspace: true },
    );
    const env = stateEnv(root);
    const existingRecord = persistClawInstallRecord(plan, { env, status: "partial", nowMs: 1 });

    await expect(
      applyClawAddPlan(plan, {
        consentPlanIntegrity: plan.planIntegrity,
        env,
        prepareBootstrapPublication: () => {
          throw new Error("injected publication preparation failure");
        },
      }),
    ).rejects.toMatchObject({ code: "bootstrap_prepare_failed" });

    expect(readClawInstallRecord("worker", { env })).toEqual(existingRecord);
  });

  it("does not claim an exact agent that appears during fresh workspace adoption", async () => {
    const root = tempDirs.make("openclaw-claw-workspace-agent-race-");
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const { plan } = await makeProvenancePlan(
      root,
      { schemaVersion: 1, agent: { id: "worker" } },
      { workspace, adoptExistingWorkspace: true },
    );
    const env = stateEnv(root);
    const { id, ...entry } = plan.agent.config;
    const commitConfig = vi.fn();

    await expect(
      applyClawAddPlan(plan, {
        consentPlanIntegrity: plan.planIntegrity,
        env,
        readConfigForApply: async () => ({ agents: { entries: { [id]: entry } } }),
        commitConfig,
      }),
    ).resolves.toMatchObject({
      status: "partial",
      configCommitted: false,
      error: { code: "agent_id_collision" },
    });

    expect(commitConfig).not.toHaveBeenCalled();
    expect(readClawInstallRecord("worker", { env })).toMatchObject({
      schemaVersion: "openclaw.clawInstallRecord.v3",
      status: "workspace_ready",
      agentOrigin: "adopted",
      agentClaimed: false,
    });
  });

  it.each(["partial", "workspace_ready"] as const)(
    "does not claim an independently created exact agent from a preexisting %s record",
    async (status) => {
      const root = tempDirs.make(`openclaw-claw-${status}-agent-race-`);
      const { plan } = await makeProvenancePlan(root, {
        schemaVersion: 1,
        agent: { id: "worker" },
      });
      const env = stateEnv(root);
      if (status === "workspace_ready") {
        await mkdir(plan.agent.workspace, { recursive: true });
      }
      persistClawInstallRecord(plan, { env, status, nowMs: 1 });
      const { id, ...entry } = plan.agent.config;
      const commitConfig = vi.fn();

      await expect(
        applyClawAddPlan(plan, {
          consentPlanIntegrity: plan.planIntegrity,
          env,
          readConfigForApply: async () => ({ agents: { entries: { [id]: entry } } }),
          commitConfig,
        }),
      ).resolves.toMatchObject({
        status: "partial",
        configCommitted: false,
        error: { code: "agent_id_collision" },
      });

      expect(commitConfig).not.toHaveBeenCalled();
      expect(readClawInstallRecord("worker", { env })).toMatchObject({
        schemaVersion: "openclaw.clawInstallRecord.v3",
        status,
        agentOrigin: "adopted",
        agentClaimed: false,
      });
    },
  );

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
    // directory. readConfigForApply supplies the fresh admission config for that race.
    await expect(
      applyClawAddPlan(plan, {
        consentPlanIntegrity: plan.planIntegrity,
        env,
        readConfigForApply: async () => ({ agents: { entries: { other: { workspace: parent } } } }),
      }),
    ).rejects.toMatchObject({ code: "workspace_collision" });

    expect(readInstallRow("worker", root)).toBeUndefined();
    expect(readClawWorkspaceFiles("worker", { env })).toEqual([]);
    await expect(access(plan.agent.workspace)).rejects.toThrow();
  });

  it("preserves an implicitly resumed partial record when live config gains an overlap", async () => {
    const root = tempDirs.make("openclaw-claw-resume-config-collision-");
    const parent = join(root, "parent");
    await mkdir(parent, { recursive: true });
    const { plan } = await makeProvenancePlan(
      root,
      { schemaVersion: 1, agent: { id: "worker" } },
      { workspace: join(parent, "child") },
    );
    const env = stateEnv(root);
    const existingRecord = persistClawInstallRecord(plan, { env, status: "partial", nowMs: 1 });

    await expect(
      applyClawAddPlan(plan, {
        consentPlanIntegrity: plan.planIntegrity,
        env,
        readConfigForApply: async () => ({ agents: { entries: { other: { workspace: parent } } } }),
      }),
    ).rejects.toMatchObject({ code: "workspace_collision" });

    expect(readClawInstallRecord("worker", { env })).toEqual(existingRecord);
    await expect(access(plan.agent.workspace)).rejects.toThrow();
  });

  it("preserves a workspace-ready record when workspace ancestry changes", async () => {
    const root = tempDirs.make("openclaw-claw-workspace-resume-swap-");
    const canonicalParent = join(root, "canonical");
    const alternateParent = join(root, "alternate");
    await mkdir(canonicalParent);
    await mkdir(alternateParent);
    const { root: planRoot, plan } = await makeProvenancePlan(
      root,
      { schemaVersion: 1, agent: { id: "worker" } },
      { workspace: join(canonicalParent, "workspace-worker") },
    );
    persistClawInstallRecord(plan, {
      env: stateEnv(planRoot),
      status: "workspace_ready",
      nowMs: 1,
    });
    await rmdir(canonicalParent);
    await symlink(
      alternateParent,
      canonicalParent,
      process.platform === "win32" ? "junction" : "dir",
    );

    await expect(
      applyClawAddPlan(plan, {
        consentPlanIntegrity: plan.planIntegrity,
        env: stateEnv(planRoot),
      }),
    ).rejects.toMatchObject({ code: "workspace_path_changed" });
    expect(readClawInstallRecord("worker", { env: stateEnv(planRoot) })?.status).toBe(
      "workspace_ready",
    );
  });

  it("preserves an implicitly resumed partial record when workspace ancestry changes", async () => {
    const root = tempDirs.make("openclaw-claw-partial-workspace-swap-");
    const canonicalParent = join(root, "canonical");
    const alternateParent = join(root, "alternate");
    await mkdir(canonicalParent);
    await mkdir(alternateParent);
    const { root: planRoot, plan } = await makeProvenancePlan(
      root,
      { schemaVersion: 1, agent: { id: "worker" } },
      { workspace: join(canonicalParent, "workspace-worker") },
    );
    const env = stateEnv(planRoot);
    const existingRecord = persistClawInstallRecord(plan, { env, status: "partial", nowMs: 1 });
    await rmdir(canonicalParent);
    await symlink(
      alternateParent,
      canonicalParent,
      process.platform === "win32" ? "junction" : "dir",
    );

    await expect(
      applyClawAddPlan(plan, { consentPlanIntegrity: plan.planIntegrity, env }),
    ).rejects.toMatchObject({ code: "workspace_path_changed" });
    expect(readClawInstallRecord("worker", { env })).toEqual(existingRecord);
  });

  it("preserves an implicitly resumed partial record when workspace phase persistence fails", async () => {
    const root = tempDirs.make("openclaw-claw-partial-phase-failure-");
    const { plan } = await makeProvenancePlan(root, {
      schemaVersion: 1,
      agent: { id: "worker" },
    });
    const env = stateEnv(root);
    const existingRecord = persistClawInstallRecord(plan, { env, status: "partial", nowMs: 1 });

    await expect(
      applyClawAddPlan(plan, {
        consentPlanIntegrity: plan.planIntegrity,
        env,
        updateRecord: () => {
          throw new Error("database unavailable");
        },
      }),
    ).rejects.toMatchObject({ code: "provenance_failed" });

    await expect(access(plan.agent.workspace)).rejects.toThrow();
    expect(readClawInstallRecord("worker", { env })).toEqual(existingRecord);
  });
});
