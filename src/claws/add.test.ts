import { access, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/config.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { applyClawAddPlan, ClawAddMutationError } from "./add.js";
import { readClawStatus } from "./lifecycle-state.js";
import { buildClawAddPlan } from "./lifecycle.js";
import { persistClawInstallRecord, readClawInstallRecord } from "./provenance.js";
import { makeProvenancePlan, stateEnv } from "./provenance.test-helpers.js";
import { manifest, source } from "./update-apply.test-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

describe("Claw add lifecycle", () => {
  it("leaves operator model and delegation settings alone on add", async () => {
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
    const commitConfig = async (transform: (current: OpenClawConfig) => OpenClawConfig) => {
      config = transform(config);
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

    expect(assertReviewedConfig).toHaveBeenCalledWith({ tools: { deny: ["web_fetch"] } });
    expect(result).toMatchObject({
      status: "partial",
      configCommitted: false,
      error: { code: "reviewed_access_changed" },
    });
    expect(diskConfig.agents?.entries?.worker).toBeUndefined();
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
