// Removal coverage for historical state retained after configured-agent adoption.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { readSourceConfigBestEffort, resetConfigRuntimeState } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadExecApprovals, saveExecApprovals } from "../infra/exec-approvals.js";
import {
  listOpenClawRegisteredAgentDatabases,
  registerOpenClawAgentDatabase,
} from "../state/openclaw-agent-db-registry.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { applyClawAddPlan } from "./add.js";
import { quiescentClawMonitorGateway } from "./lifecycle-remove.test-support.js";
import { applyClawRemovePlan, buildClawRemovePlan, readClawStatus } from "./lifecycle-state.js";
import { buildClawAddPlan } from "./lifecycle.js";
import { parseClawManifest } from "./schema.js";
import type { ClawSourceIdentity } from "./types.js";

const envSnapshot = captureEnv(["OPENCLAW_CONFIG_PATH", "OPENCLAW_STATE_DIR"]);
const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(async () => {
    await closeOpenClawAgentDatabasesAsync();
    closeOpenClawAgentDatabasesForTest();
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    resetConfigRuntimeState();
    envSnapshot.restore();
    cleanup();
  });
});

async function adoptedAgentFixture() {
  const root = tempDirs.make("openclaw-claw-agent-adopt-remove-");
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const parsed = parseClawManifest({
    schemaVersion: 1,
    agent: { id: "worker", name: "Worker" },
  });
  if (!parsed.ok) {
    throw new Error(JSON.stringify(parsed.diagnostics));
  }
  const source: ClawSourceIdentity = {
    kind: "package",
    name: "@acme/worker",
    version: "1.0.0",
    packageRoot: root,
    manifestPath: join(root, "openclaw.claw.json"),
    integrityKind: "artifact",
    integrity: "sha256:manifest",
    byteLength: 1,
  };
  let config: OpenClawConfig = {
    agents: { entries: { worker: { name: "Worker", workspace } } },
  };
  const configPath = join(root, "openclaw.json");
  const stateDir = join(root, "state");
  setTestEnvValue("OPENCLAW_CONFIG_PATH", configPath);
  setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
  await writeFile(configPath, JSON.stringify(config), "utf8");
  resetConfigRuntimeState();
  const plan = await buildClawAddPlan({
    manifest: parsed.manifest,
    source,
    context: {
      workspace,
      adoptExistingAgent: true,
      existingAgents: [{ id: "worker", name: "Worker", workspace }],
    },
  });
  const env = { OPENCLAW_STATE_DIR: stateDir };
  await applyClawAddPlan(plan, {
    env,
    consentPlanIntegrity: plan.planIntegrity,
    readConfig: () => config,
    commitConfig: async (transform) => {
      config = transform(config);
    },
  });
  return {
    env,
    workspace,
    getConfig: () => config,
    setConfig: async (next: OpenClawConfig) => {
      config = next;
      await writeFile(configPath, JSON.stringify(config), "utf8");
      resetConfigRuntimeState();
    },
  };
}

describe("Claw remove after configured-agent adoption", () => {
  it("reports adopted agent origin in status", async () => {
    const current = await adoptedAgentFixture();
    const agent = current.getConfig().agents?.entries?.worker;
    if (!agent) {
      throw new Error("fixture agent missing");
    }
    await current.setConfig({ agents: { entries: { WORKER: agent } } });

    await expect(
      readClawStatus("worker", { env: current.env, config: current.getConfig() }),
    ).resolves.toMatchObject({ records: [{ agentOrigin: "adopted", agentState: "present" }] });
  });

  it("plans retention for the pre-existing agent and session state", async () => {
    const current = await adoptedAgentFixture();

    const plan = await buildClawRemovePlan("worker", {
      env: current.env,
      config: current.getConfig(),
    });

    expect(plan.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "agentState", action: "retain", blocked: false }),
        expect.objectContaining({ kind: "sessionIndex", action: "retain", blocked: false }),
        expect.objectContaining({ kind: "sessionTranscripts", action: "retain", blocked: false }),
        expect.objectContaining({ kind: "workspace", action: "retain", blocked: false }),
      ]),
    );
  });

  it("keeps durable database discovery for the retained adopted agent", async () => {
    const current = await adoptedAgentFixture();
    const agent = current.getConfig().agents?.entries?.worker;
    if (!agent) {
      throw new Error("fixture agent missing");
    }
    await current.setConfig({ agents: { entries: { WORKER: agent } } });
    const databasePath = join(
      current.env.OPENCLAW_STATE_DIR,
      "agents",
      "worker",
      "agent",
      "openclaw-agent.sqlite",
    );
    registerOpenClawAgentDatabase({ agentId: "worker", path: databasePath, env: current.env });
    const plan = await buildClawRemovePlan("worker", {
      env: current.env,
      config: current.getConfig(),
    });

    const result = await applyClawRemovePlan(plan, {
      env: current.env,
      config: current.getConfig(),
      consentPlanIntegrity: plan.planIntegrity,
      monitorGateway: quiescentClawMonitorGateway,
      purgeSessions: vi.fn(),
      trashPath: vi.fn(async () => true),
    });

    expect(result.status).toBe("complete");
    // Removal retains the adopted agent's database and sessions, so the registration that finds
    // them must survive; unregistering here would orphan state the operator still owns.
    expect(
      listOpenClawRegisteredAgentDatabases({ env: current.env }).map((entry) => entry.agentId),
    ).toEqual(["worker"]);
  });

  it("removes managed config without purging or trashing historical state", async () => {
    const current = await adoptedAgentFixture();
    const agent = current.getConfig().agents?.entries?.worker;
    if (!agent) {
      throw new Error("fixture agent missing");
    }
    await current.setConfig({ agents: { entries: { WORKER: agent } } });
    const plan = await buildClawRemovePlan("worker", {
      env: current.env,
      config: current.getConfig(),
    });
    const purgeSessions = vi.fn();
    const trashPath = vi.fn(async () => true);

    const result = await applyClawRemovePlan(plan, {
      env: current.env,
      config: current.getConfig(),
      consentPlanIntegrity: plan.planIntegrity,
      monitorGateway: quiescentClawMonitorGateway,
      purgeSessions,
      trashPath,
    });

    expect(result.status).toBe("complete");
    expect(Object.keys((await readSourceConfigBestEffort()).agents?.entries ?? {})).toEqual([]);
    expect(purgeSessions).not.toHaveBeenCalled();
    expect(trashPath).not.toHaveBeenCalled();
  });

  it("preserves the adopted agent's exec approvals", async () => {
    const current = await adoptedAgentFixture();
    saveExecApprovals({
      version: 1,
      agents: {
        worker: { security: "deny" },
        retained: { security: "allowlist" },
      },
    });
    const plan = await buildClawRemovePlan("worker", {
      env: current.env,
      config: current.getConfig(),
    });

    const result = await applyClawRemovePlan(plan, {
      env: current.env,
      config: current.getConfig(),
      consentPlanIntegrity: plan.planIntegrity,
      monitorGateway: quiescentClawMonitorGateway,
      purgeSessions: vi.fn(),
      trashPath: vi.fn(async () => true),
    });

    expect(result.status).toBe("complete");
    expect(loadExecApprovals().agents).toEqual({
      worker: { security: "deny" },
      retained: { security: "allowlist" },
    });
  });

  it("removes adopted config while retaining a shared session database", async () => {
    const current = await adoptedAgentFixture();
    const agent = current.getConfig().agents?.entries?.worker;
    if (!agent) {
      throw new Error("fixture agent missing");
    }
    const storePath = join(current.env.OPENCLAW_STATE_DIR, "shared.sqlite");
    const config: OpenClawConfig = {
      agents: { entries: { worker: agent, ops: {} } },
      session: { store: storePath },
    };
    await current.setConfig(config);
    openOpenClawAgentDatabase({ agentId: "worker", path: storePath, env: current.env });

    const plan = await buildClawRemovePlan("worker", { env: current.env, config });
    expect(plan.blockers).not.toContainEqual(
      expect.objectContaining({ code: "shared_session_store_owner" }),
    );
    const purgeSessions = vi.fn();
    const trashPath = vi.fn(async () => true);

    const result = await applyClawRemovePlan(plan, {
      env: current.env,
      config,
      consentPlanIntegrity: plan.planIntegrity,
      monitorGateway: quiescentClawMonitorGateway,
      purgeSessions,
      trashPath,
    });

    expect(result.status).toBe("complete");
    expect(Object.keys((await readSourceConfigBestEffort()).agents?.entries ?? {})).toEqual([
      "ops",
    ]);
    expect(purgeSessions).not.toHaveBeenCalled();
    expect(trashPath).not.toHaveBeenCalled();
  });

  it("blocks removal of an adopted agent still referenced by operator-owned config", async () => {
    const current = await adoptedAgentFixture();
    const agent = current.getConfig().agents?.entries?.worker;
    if (!agent) {
      throw new Error("fixture agent missing");
    }
    const referencedConfig: OpenClawConfig = {
      agents: { entries: { worker: agent } },
      bindings: [{ agentId: "worker", match: { channel: "telegram" } }],
      tools: { agentToAgent: { allow: ["worker"] } },
      hooks: { mappings: [{ id: "h", agentId: "worker", action: "agent" }] },
      broadcast: { "telegram:-100": { agents: ["worker"] } },
    };
    await current.setConfig(referencedConfig);

    const plan = await buildClawRemovePlan("worker", {
      env: current.env,
      config: current.getConfig(),
    });
    const blocker = plan.blockers.find((entry) => entry.code === "adopted_agent_referenced");
    expect(blocker?.message).toContain("bindings[0]");
    // Object-form broadcast references block adopted-agent removal like every other reference kind.
    expect(blocker?.message).toContain("broadcast.telegram:-100.agents[0]");
    expect(plan.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "agent", blocked: true }),
        expect.objectContaining({ kind: "configBinding", action: "retain", blocked: true }),
        expect.objectContaining({ kind: "agentAllow", action: "retain", blocked: true }),
        expect.objectContaining({
          kind: "configReference",
          target: "broadcast.telegram:-100.agents[0]",
          action: "retain",
          blocked: true,
        }),
        expect.objectContaining({
          kind: "configReference",
          target: "hooks.mappings[0]",
          action: "retain",
          blocked: true,
        }),
      ]),
    );

    await expect(
      applyClawRemovePlan(plan, {
        env: current.env,
        config: current.getConfig(),
        consentPlanIntegrity: plan.planIntegrity,
        monitorGateway: quiescentClawMonitorGateway,
      }),
    ).rejects.toMatchObject({ code: "remove_blocked" });
    // The real config-loading pipeline fills unrelated defaults on every read. The blocked
    // removal only needs to have left referencedConfig's own fields untouched.
    expect(current.getConfig()).toMatchObject(referencedConfig);

    // Once the operator clears the references the same agent removes cleanly.
    await current.setConfig({ agents: { entries: { worker: agent } } });
    const clearedPlan = await buildClawRemovePlan("worker", {
      env: current.env,
      config: current.getConfig(),
    });
    expect(clearedPlan.blockers).toEqual([]);
    const result = await applyClawRemovePlan(clearedPlan, {
      env: current.env,
      config: current.getConfig(),
      consentPlanIntegrity: clearedPlan.planIntegrity,
      monitorGateway: quiescentClawMonitorGateway,
      purgeSessions: vi.fn(),
      trashPath: vi.fn(async () => true),
    });
    expect(result.status).toBe("complete");
    expect((await readSourceConfigBestEffort()).agents?.entries?.worker).toBeUndefined();
  });
});
