// Removal coverage for historical state retained after configured-agent adoption.
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { loadConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  listOpenClawRegisteredAgentDatabases,
  registerOpenClawAgentDatabase,
} from "../state/openclaw-agent-db-registry.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { applyClawAddPlan } from "./add.js";
import { quiescentClawMonitorGateway } from "./lifecycle-remove.test-support.js";
import { applyClawRemovePlan, buildClawRemovePlan, readClawStatus } from "./lifecycle-state.js";
import { buildClawAddPlan } from "./lifecycle.js";
import { parseClawManifest } from "./schema.js";
import type { ClawSourceIdentity } from "./types.js";

let state: OpenClawTestState;
beforeEach(async () => {
  state = await createOpenClawTestState({ prefix: "claw-agent-adopt-remove-" });
  await state.writeConfig({});
});
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(async () => {
  closeOpenClawStateDatabaseForTest();
  await state.cleanup();
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
  // applyClawRemovePlan below commits agent-entry deletion through the real config file
  // (deleteAgentConfigEntry -> mutateConfigFileWithRetry); keep the real file and this
  // closure in lockstep so removal and the test's own assertions agree on one config.
  await state.writeConfig(config);
  const plan = await buildClawAddPlan({
    manifest: parsed.manifest,
    source,
    context: {
      workspace,
      adoptExistingAgent: true,
      existingAgents: [{ id: "worker", name: "Worker", workspace }],
    },
  });
  const env = { OPENCLAW_STATE_DIR: state.stateDir };
  await applyClawAddPlan(plan, {
    env,
    consentPlanIntegrity: plan.planIntegrity,
    readConfig: () => config,
    commitConfig: async (transform) => {
      config = transform(config);
      await state.writeConfig(config);
    },
  });
  return {
    env,
    workspace,
    // Read fresh: this fixture writes the real config file directly (state.writeConfig),
    // bypassing the mutateConfigFileWithRetry path that invalidates loadConfig's pinned
    // runtime snapshot, so a pinned read here would serve a stale pre-write config.
    getConfig: () => loadConfig({ pin: false }),
    setConfig: async (next: OpenClawConfig) => {
      config = next;
      await state.writeConfig(next);
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
    // Real config normalization materializes a default "main" agent once entries is
    // fully empty, so assert the case-mismatched entry is gone rather than entries=={}.
    expect(current.getConfig().agents?.entries?.WORKER).toBeUndefined();
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
    };
    await current.setConfig(referencedConfig);

    const plan = await buildClawRemovePlan("worker", {
      env: current.env,
      config: current.getConfig(),
    });
    const blocker = plan.blockers.find((entry) => entry.code === "adopted_agent_referenced");
    expect(blocker?.message).toContain("bindings[0]");
    expect(plan.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "agent", blocked: true }),
        expect.objectContaining({ kind: "configBinding", action: "retain", blocked: true }),
        expect.objectContaining({ kind: "agentAllow", action: "retain", blocked: true }),
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
    // toMatchObject: the real config-loading pipeline fills in unrelated top-level
    // defaults (commands, messages, agents.defaults) on every read; the blocked
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
    expect(current.getConfig().agents?.entries?.worker).toBeUndefined();
  });
});
