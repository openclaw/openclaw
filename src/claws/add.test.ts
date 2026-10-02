import { access, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/config.js";
import { resetConfigOverrides, setConfigOverride } from "../config/runtime-overrides.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { applyClawAddPlan, ClawAddMutationError } from "./add.js";
import { readClawStatus } from "./lifecycle-state.js";
import { buildClawAddPlan } from "./lifecycle.js";
import { persistClawInstallRecord, readClawInstallRecord } from "./provenance.js";
import { makeProvenancePlan, stateEnv } from "./provenance.test-helpers.js";
import type { ClawOpenClawProfile } from "./types.js";
import { applyClawUpdatePlan } from "./update-apply.js";
import { consent, manifest, source } from "./update-apply.test-helpers.js";
import { buildClawUpdatePlan } from "./update-plan.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  resetConfigOverrides();
  closeOpenClawStateDatabaseForTest();
});

describe("Claw add lifecycle", () => {
  it("leaves operator model and delegation settings alone across add and update", async () => {
    const root = tempDirs.make("openclaw-claw-update-profile-");
    const env = { OPENCLAW_STATE_DIR: join(root, "state") };
    const localSource = { ...source, packageRoot: root };
    const initial = await buildClawAddPlan({
      manifest,
      source: localSource,
      openClawProfile: { schemaVersion: 1, agent: {} },
      context: { workspace: join(root, "workspace") },
    });
    let config: OpenClawConfig = {
      agents: {
        defaults: {
          model: { primary: "acme/default" },
          subagents: { allowAgents: ["researcher"] },
        },
        entries: { researcher: {} },
      },
    };
    const commitConfig = async (
      transform: (current: OpenClawConfig, runtime: OpenClawConfig) => OpenClawConfig,
    ) => {
      config = transform(config, config);
    };
    await applyClawAddPlan(initial, {
      env,
      commitConfig,
      consentPlanIntegrity: initial.planIntegrity,
    });
    expect(config.agents?.defaults?.model).toEqual({ primary: "acme/default" });
    expect(config.agents?.defaults?.subagents).toEqual({ allowAgents: ["researcher"] });
    expect(config.agents?.entries?.researcher).toEqual({});
    expect(config.agents?.entries?.worker).not.toHaveProperty("model");
    expect(config.agents?.entries?.worker).not.toHaveProperty("subagents");

    const worker = config.agents!.entries!.worker!;
    worker.model = { primary: "acme/operator" };
    worker.subagents = { allowAgents: ["researcher"], delegationMode: "prefer" };
    await expect(readClawStatus("worker", { env, config })).resolves.toMatchObject({
      records: [{ agentState: "present" }],
    });
    const targetProfiles: ClawOpenClawProfile["agent"][] = [
      { groupChat: { mentionPatterns: ["@worker"] } },
      { groupChat: { mentionPatterns: ["@assistant"] } },
    ];
    for (const [index, agent] of targetProfiles.entries()) {
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
      const capabilityPaths = update.capabilityChanges.map((change) => change.path);
      expect(capabilityPaths).not.toContain("agent.model");
      expect(capabilityPaths).not.toContain("agent.subagents.allowAgents");
      expect(capabilityPaths).not.toContain("agent.subagents.delegationMode");
      if (index === 0) {
        config.agents!.entries!.worker!.model = { primary: "acme/changed-after-plan" };
        config.agents!.entries!.worker!.subagents = { allowAgents: [], delegationMode: "suggest" };
      }
      await expect(
        applyClawUpdatePlan(update, target, {
          env,
          config,
          commitConfig,
          ...consent(update),
        }),
      ).resolves.toMatchObject({ status: "complete" });
      expect(config.agents?.entries?.worker?.model).toEqual({
        primary: "acme/changed-after-plan",
      });
      expect(config.agents?.entries?.worker?.subagents).toEqual({
        allowAgents: [],
        delegationMode: "suggest",
      });
      expect(config.agents?.entries?.worker?.groupChat).toEqual(agent.groupChat);
      await expect(readClawStatus("worker", { env, config })).resolves.toMatchObject({
        records: [{ agentState: "present" }],
      });
    }

    config.agents!.entries!.worker!.model = { primary: "acme/later-operator-choice" };
    const unchanged = await buildClawUpdatePlan({
      agentId: "worker",
      targetManifest: manifest,
      targetSource: localSource,
      targetOpenClawProfile: { schemaVersion: 1, agent: targetProfiles[1]! },
      config,
      sourceMcpServers: {},
      stateOptions: { env },
    });
    expect(unchanged.blockers).toEqual([]);
    expect(unchanged.actions).toContainEqual(
      expect.objectContaining({ kind: "agent", action: "unchanged" }),
    );
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

  it("checks the reviewed access against the config read for the final commit", async () => {
    const root = tempDirs.make("openclaw-claw-add-access-drift-");
    const env = stateEnv(root);
    const { plan } = await makeProvenancePlan(root, {
      schemaVersion: 1,
      agent: { id: "worker" },
    });
    let diskConfig: OpenClawConfig = {};
    const assertReviewedConfig = vi.fn((current: OpenClawConfig) => {
      if (current.tools?.deny?.includes("web_fetch")) {
        throw new ClawAddMutationError(
          "reviewed_access_changed",
          "The effective Claw access changed since review. Preview it again.",
        );
      }
    });

    const result = await applyClawAddPlan(plan, {
      consentPlanIntegrity: plan.planIntegrity,
      env,
      seedPackageBootstrap: async () => {
        diskConfig = { tools: { deny: ["web_fetch"] } };
      },
      commitConfig: async (transform) => {
        diskConfig = transform(diskConfig);
      },
      assertReviewedConfig,
    });

    expect(assertReviewedConfig).toHaveBeenCalledWith(
      { tools: { deny: ["web_fetch"] } },
      undefined,
    );
    expect(result).toMatchObject({
      status: "partial",
      configCommitted: false,
      error: { code: "reviewed_access_changed" },
    });
    expect(diskConfig.agents?.entries?.worker).toBeUndefined();
    expect(readClawInstallRecord("worker", { env })?.status).toBe("partial");
  });

  it("stops before workspace mutation when access drifts after the first state write", async () => {
    const root = tempDirs.make("openclaw-claw-add-early-access-drift-");
    const env = stateEnv(root);
    const { plan } = await makeProvenancePlan(root, {
      schemaVersion: 1,
      agent: { id: "worker" },
    });
    let config: OpenClawConfig = {};
    const seedPackageBootstrap = vi.fn(async () => undefined);

    await expect(
      applyClawAddPlan(plan, {
        consentPlanIntegrity: plan.planIntegrity,
        env,
        getCurrentConfig: () => config,
        assertReviewedConfig: (current) => {
          if (current.tools?.deny?.includes("web_fetch")) {
            throw new ClawAddMutationError("reviewed_access_changed", "Access changed.");
          }
        },
        persistRecord: async (...args) => {
          const record = persistClawInstallRecord(...args);
          config = { tools: { deny: ["web_fetch"] } };
          return record;
        },
        seedPackageBootstrap,
      }),
    ).rejects.toMatchObject({ code: "reviewed_access_changed" });

    expect(seedPackageBootstrap).not.toHaveBeenCalled();
    await expect(access(plan.agent.workspace)).rejects.toThrow();
  });

  it("rechecks access after the agent commit before writing workspace resources", async () => {
    const root = tempDirs.make("openclaw-claw-add-post-commit-access-drift-");
    const env = stateEnv(root);
    const { plan } = await makeProvenancePlan(root, {
      schemaVersion: 1,
      agent: { id: "worker" },
    });
    let config: OpenClawConfig = {};
    const createWorkspaceFiles = vi.fn(async () => []);

    const result = await applyClawAddPlan(plan, {
      consentPlanIntegrity: plan.planIntegrity,
      env,
      getCurrentConfig: () => config,
      assertReviewedConfig: (current, phase) => {
        if (phase === "after-agent-commit" && current.tools?.deny?.includes("web_fetch")) {
          throw new ClawAddMutationError("reviewed_access_changed", "Access changed.");
        }
      },
      commitConfig: async (transform) => {
        config = transform(config, config);
        config = { ...config, tools: { deny: ["web_fetch"] } };
      },
      createWorkspaceFiles,
    });

    expect(result).toMatchObject({
      status: "partial",
      configCommitted: true,
      error: { code: "reviewed_access_changed" },
    });
    expect(createWorkspaceFiles).not.toHaveBeenCalled();
    expect(readClawInstallRecord("worker", { env })?.status).toBe("config_committed");
  });

  it("passes the reviewed guard to a nested forward mutation", async () => {
    const root = tempDirs.make("openclaw-claw-add-nested-access-drift-");
    const env = stateEnv(root);
    const { plan } = await makeProvenancePlan(root, {
      schemaVersion: 1,
      agent: { id: "worker" },
    });
    let config: OpenClawConfig = {};
    const forwardMutation = vi.fn();
    const installCronJobs = vi.fn(async () => []);

    const result = await applyClawAddPlan(plan, {
      consentPlanIntegrity: plan.planIntegrity,
      env,
      getCurrentConfig: () => config,
      assertReviewedConfig: (current, phase) => {
        if (phase === "after-agent-commit" && current.tools?.deny?.includes("web_fetch")) {
          throw new ClawAddMutationError("reviewed_access_changed", "Access changed.");
        }
      },
      commitConfig: async (transform) => {
        config = transform(config, config);
      },
      installMcpServers: async (_plan, stageOptions) => {
        config = { ...config, tools: { deny: ["web_fetch"] } };
        if (!stageOptions) {
          throw new Error("Missing MCP mutation options");
        }
        stageOptions.assertForwardCurrent?.();
        forwardMutation();
        return [];
      },
      installCronJobs,
    });

    expect(result).toMatchObject({ status: "partial", error: { code: "mcp_install_failed" } });
    expect(forwardMutation).not.toHaveBeenCalled();
    expect(installCronJobs).not.toHaveBeenCalled();
  });

  it("checks materialized runtime config and active overrides at the agent write", async () => {
    const root = tempDirs.make("openclaw-claw-add-runtime-access-");
    const env = stateEnv(root);
    const { plan } = await makeProvenancePlan(root, {
      schemaVersion: 1,
      agent: { id: "worker" },
    });
    const sourceConfig: OpenClawConfig = {};
    const runtimeConfig: OpenClawConfig = { tools: { allow: ["read"] } };
    expect(setConfigOverride("tools.deny", ["web_fetch"]).ok).toBe(true);
    const assertReviewedConfig = vi.fn((current: OpenClawConfig) => {
      if (!current.tools?.allow?.includes("read") || !current.tools?.deny?.includes("web_fetch")) {
        throw new ClawAddMutationError("reviewed_access_changed", "Access changed.");
      }
    });
    let writtenConfig: OpenClawConfig | undefined;

    const result = await applyClawAddPlan(plan, {
      consentPlanIntegrity: plan.planIntegrity,
      env,
      assertReviewedConfig,
      commitConfig: async (transform) => {
        writtenConfig = transform(sourceConfig, runtimeConfig);
      },
    });

    expect(result.status).toBe("complete");
    expect(assertReviewedConfig).toHaveBeenCalledWith(
      { tools: { allow: ["read"], deny: ["web_fetch"] } },
      undefined,
    );
    expect(writtenConfig?.tools).toBeUndefined();
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
