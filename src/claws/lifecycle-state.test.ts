import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { loadConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { cronJobReadView } from "../cron/job-read-view.js";
import { normalizeCronJobCreate } from "../cron/normalize.js";
import { upsertCronJobRow } from "../cron/store/row-codec.js";
import type { CronStoredJob } from "../cron/types.js";
import { readAgentDeletionJournal } from "../state/agent-deletion-journal.js";
import {
  listOpenClawRegisteredAgentDatabases,
  registerOpenClawAgentDatabase,
} from "../state/openclaw-agent-db-registry.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { applyClawAddPlan } from "./add.js";
import {
  CLAW_CRON_REF_SCHEMA_VERSION,
  clawCronGatewayInput,
  markClawCronRefRemoved,
  readClawCronRefs,
  upsertClawCronRef,
} from "./cron.js";
import { readClawStatusForGateway } from "./gateway-status-worker.js";
import { readClawInventory } from "./inventory-read.js";
import { withClawAgentConfigRemoval } from "./lifecycle-config-removal.js";
import { quiescentClawMonitorGateway } from "./lifecycle-remove.test-support.js";
import { applyClawRemovePlan, buildClawRemovePlan, readClawStatus } from "./lifecycle-state.js";
import { createClawRemoveTestFixtures } from "./lifecycle-state.test-helpers.js";
import {
  CLAW_MCP_REF_SCHEMA_VERSION,
  digestClawMcpServer,
  readClawMcpServerRefs,
  upsertClawMcpServerRef,
} from "./mcp.js";
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

function cronReadView(agentId: string, ref: ReturnType<typeof readClawCronRefs>[number]) {
  const normalized = normalizeCronJobCreate(clawCronGatewayInput(agentId, ref));
  if (!normalized || !ref.schedulerJobId) {
    throw new Error("expected complete cron provenance");
  }
  return cronJobReadView({
    ...normalized,
    id: ref.schedulerJobId,
    createdAtMs: 1,
    updatedAtMs: 1,
    state: { nextRunAtMs: 100, lastRunAtMs: 50, lastStatus: "ok" },
  });
}

function seedAttachedCronJob(
  env: NodeJS.ProcessEnv,
  job: Pick<CronStoredJob, "id" | "name" | "schedule">,
): void {
  const database = openOpenClawStateDatabase({ env });
  upsertCronJobRow(
    database.db,
    "default",
    {
      ...job,
      agentId: "worker",
      owner: { agentId: "worker" },
      enabled: true,
      createdAtMs: 1,
      updatedAtMs: 1,
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "Run scheduled job" },
      state: {},
    },
    0,
  );
}

describe("Claw status and remove", () => {
  it.each(["direct", "worker"] as const)(
    "readds a Claw after completed removal using %s state writes",
    async (stateMode) => {
      const current = await addFixture();
      const removePlan = await buildClawRemovePlan("worker", {
        env: current.env,
        config: current.getConfig(),
      });
      const removed = await applyClawRemovePlan(removePlan, {
        ...removeOptions(current, removePlan),
        trashPath: async (pathname) => {
          await rm(pathname, { recursive: true, force: true });
          return true;
        },
      });
      expect(removed).toMatchObject({ status: "complete", agentRemoved: true });
      const deletion = readAgentDeletionJournal("worker", { env: current.env });
      expect(deletion).toMatchObject({ cleanupCompleted: true });
      expect(loadConfig().agents?.entries?.worker).toBeUndefined();

      const readded = await applyClawAddPlan(current.plan, {
        env: current.env,
        ...(stateMode === "worker" ? { stateMode } : {}),
        consentPlanIntegrity: current.plan.planIntegrity,
        commitConfig: async (transform) => {
          expect(readAgentDeletionJournal("worker", { env: current.env })?.operationId).toBe(
            deletion?.operationId,
          );
          await state.writeConfig(transform(loadConfig()));
        },
      });

      expect(readded).toMatchObject({ status: "complete", configCommitted: true });
      const persistedConfig = JSON.parse(
        await readFile(state.configPath, "utf8"),
      ) as OpenClawConfig;
      expect(persistedConfig.agents?.entries?.worker).toBeDefined();
      expect(readAgentDeletionJournal("worker", { env: current.env })).toBeUndefined();
    },
  );

  it("removes an orphan with only MCP provenance through the CLI read path", async () => {
    const server = { command: "docs-mcp" };
    const config = { mcp: { servers: { docs: server } } };
    await state.writeConfig(config);
    upsertClawMcpServerRef(
      {
        schemaVersion: CLAW_MCP_REF_SCHEMA_VERSION,
        agentId: "orphan-mcp",
        name: "docs",
        configDigest: digestClawMcpServer(server),
        relationship: "managed",
        origin: "claw-introduced",
        independentOwner: false,
        status: "complete",
        createdAtMs: 1,
        updatedAtMs: 2,
      },
      { env: state.env },
    );

    const plan = await buildClawRemovePlan("orphan-mcp", {
      env: state.env,
      config,
      sourceMcpServers: { docs: server },
      exactAgentId: true,
    });

    expect(plan.blockers).toEqual([]);
    expect(plan.actions).toContainEqual(expect.objectContaining({ kind: "mcpServer", id: "docs" }));

    const result = await applyClawRemovePlan(plan, {
      env: state.env,
      config,
      sourceMcpServers: { docs: server },
      exactAgentId: true,
      monitorGateway: quiescentClawMonitorGateway,
      consentPlanIntegrity: plan.planIntegrity,
      purgeSessions: async () => false,
      trashPath: async () => true,
    });
    expect(result.status).toBe("complete");
    expect(result.mcpServers).toContainEqual({ name: "docs", action: "removed" });
    expect(loadConfig().mcp?.servers?.docs).toBeUndefined();
    expect(readClawMcpServerRefs("orphan-mcp", { env: state.env })).toEqual([]);
  });

  it("plans an orphan with only cron provenance through the CLI read path", async () => {
    upsertClawCronRef(
      {
        schemaVersion: CLAW_CRON_REF_SCHEMA_VERSION,
        agentId: "orphan-cron",
        manifestId: "daily",
        declarationKey: "claw:orphan-cron:daily",
        schedulerJobId: "scheduler-daily",
        status: "complete",
        job: {
          id: "daily",
          schedule: { cron: "0 9 * * *", timezone: "UTC" },
          session: "main",
          message: "Prepare the report",
        },
        createdAtMs: 1,
        updatedAtMs: 3,
      },
      { env: state.env },
    );

    const plan = await buildClawRemovePlan("orphan-cron", {
      env: state.env,
      config: {},
      sourceMcpServers: {},
      exactAgentId: true,
    });

    expect(plan.blockers).not.toContainEqual(expect.objectContaining({ code: "claw_not_found" }));
    expect(plan.actions).toContainEqual(expect.objectContaining({ kind: "cronJob", id: "daily" }));
  });

  it("plans exact-agent removal from read-worker facts without opening the state database", async () => {
    const current = await addFixture({ withFile: true });
    const inventory = await readClawInventory({ env: current.env });
    const missingPath = join(state.stateDir, "missing-for-remove-plan.sqlite");
    const readFacts = {
      inventory,
      registeredAgentDatabases: [],
      inspectSessionStoreOwner: () => ({ status: "unowned" as const }),
      readAttachedCronJobs: vi.fn(async () => []),
    };

    const plan = await buildClawRemovePlan(
      "worker",
      {
        path: missingPath,
        env: current.env,
        config: current.getConfig(),
        readOnly: true,
        exactAgentId: true,
      },
      readFacts,
    );
    expect(plan.agentId).toBe("worker");
    expect(plan.actions.some((action) => action.kind === "installRecord")).toBe(true);
    expect(plan.blockers).toEqual([]);
    expect(readFacts.readAttachedCronJobs).toHaveBeenCalledOnce();
    await expect(readFile(missingPath)).rejects.toMatchObject({ code: "ENOENT" });

    const nameLookup = await buildClawRemovePlan(
      "@acme/worker",
      { path: missingPath, env: current.env, config: current.getConfig(), exactAgentId: true },
      readFacts,
    );
    expect(nameLookup.agentId).toBeUndefined();
    expect(nameLookup.blockers.map((blocker) => blocker.code)).toEqual(["claw_not_found"]);
  });

  it("blocks removal when a surviving custom session store owner cannot be verified", async () => {
    const current = await addFixture({ withFile: true });
    const installedConfig = current.getConfig();
    const config: OpenClawConfig = {
      ...installedConfig,
      agents: {
        ...installedConfig.agents,
        entries: {
          ...installedConfig.agents?.entries,
          survivor: { workspace: join(current.root, "survivor-workspace") },
        },
      },
      session: { ...installedConfig.session, store: join(current.root, "shared-sessions.sqlite") },
    };
    const plan = await buildClawRemovePlan(
      "worker",
      { env: current.env, config, readOnly: true, exactAgentId: true },
      {
        inventory: await readClawInventory({ env: current.env }),
        registeredAgentDatabases: [],
        inspectSessionStoreOwner: () => ({ status: "unreadable" }),
        readAttachedCronJobs: async () => [],
      },
    );
    expect(plan.blockers.map((blocker) => blocker.code)).toContain("shared_session_store_owner");
  });

  it("previews locally without probing Gateway when there are no attached jobs, but never applies without one", async () => {
    const current = await addFixture({ withFile: true });
    const inspect = vi.fn(async () => {
      throw new Error("Gateway offline");
    });
    const plan = await buildClawRemovePlan("worker", {
      env: current.env,
      config: current.getConfig(),
      monitorGateway: { ...quiescentClawMonitorGateway, inspect },
    });
    expect(plan.blockers).toEqual([]);
    expect(inspect).not.toHaveBeenCalled();
    await expect(
      applyClawRemovePlan(plan, {
        env: current.env,
        config: current.getConfig(),
        consentPlanIntegrity: plan.planIntegrity,
      }),
    ).rejects.toMatchObject({ code: "monitor_gateway_required" });
    await expect(readFile(join(current.plan.agent.workspace, "SOUL.md"), "utf8")).resolves.toBe(
      "managed\n",
    );
  });

  it("does not reconcile pending MCP provenance before rejecting remove without Gateway", async () => {
    const current = await addFixture();
    const server = { command: "docs-mcp", args: [] };
    const mcpOptions = {
      listMcpServers: async () => ({
        ok: true as const,
        path: "config",
        config: {},
        mcpServers: { docs: server },
        runtimeConfig: current.getConfig(),
        sourceConfigBeforeMigrations: current.getConfig(),
      }),
    };
    const ref = {
      schemaVersion: "openclaw.clawMcpServerRef.v1" as const,
      agentId: "worker",
      name: "docs",
      configDigest: digestClawMcpServer(server),
      relationship: "managed" as const,
      origin: "claw-introduced" as const,
      independentOwner: false,
      status: "complete" as const,
      createdAtMs: 1,
      updatedAtMs: 1,
    };
    upsertClawMcpServerRef(ref, { env: current.env });
    const config = current.getConfig();
    const plan = await buildClawRemovePlan("worker", {
      env: current.env,
      config,
      ...mcpOptions,
    });
    upsertClawMcpServerRef({ ...ref, status: "pending" }, { env: current.env });

    await expect(
      applyClawRemovePlan(plan, {
        env: current.env,
        config,
        consentPlanIntegrity: plan.planIntegrity,
        ...mcpOptions,
      }),
    ).rejects.toMatchObject({ code: "monitor_gateway_required" });
    expect(readClawMcpServerRefs("worker", { env: current.env })).toMatchObject([
      { name: "docs", status: "pending" },
    ]);
  });

  it("rejects cleanup when an expected-missing agent id was recreated", async () => {
    await expect(
      withClawAgentConfigRemoval(
        {
          agentId: "worker",
          expectedDigest: "sha256:missing",
          expectedRemovalSurfaceDigest: "sha256:unused",
          expectedState: "missing",
          fallbackWorkspace: "/tmp/old-worker",
          config: { agents: { entries: { worker: { workspace: "/tmp/new-worker" } } } },
          onModified: () => new Error("agent recreated"),
        },
        (commitRemoval) => commitRemoval(),
      ),
    ).rejects.toThrow("agent recreated");
  });

  it("reports installed agent, managed files, and package references", async () => {
    const current = await addFixture({ withFile: true });
    persistClawPackageRef(
      current.plan,
      {
        kind: "plugin",
        source: "clawhub",
        ref: "audit",
        version: "2.0.0",
        integrity: packageIntegrity,
      },
      { env: current.env, nowMs: 2 },
    );
    const status = await readClawStatus("worker", {
      env: current.env,
      config: current.getConfig(),
    });
    expect(status).toMatchObject({
      summary: {
        claws: 1,
        partial: 0,
        missingAgents: 0,
        driftedFiles: 0,
        packageRefs: 1,
        missingPackages: 1,
      },
      records: [
        {
          install: { agentId: "worker", claw: { name: "@acme/worker" } },
          agentState: "present",
          workspaceFiles: [{ path: "SOUL.md", state: "unchanged" }],
          packages: [{ kind: "plugin", ref: "audit", state: "missing" }],
        },
      ],
    });
  });

  it("can remove a Claw after the operator changes model and delegation", async () => {
    const current = await addFixture();
    const config = current.getConfig();
    config.agents!.entries!.worker!.model = { primary: "acme/operator" };
    config.agents!.entries!.worker!.subagents = { allowAgents: [] };
    await state.writeConfig(config);
    const liveConfig = current.getConfig();
    const plan = await buildClawRemovePlan("worker", { env: current.env, config: liveConfig });

    expect(plan.blockers).toEqual([]);
    await expect(
      applyClawRemovePlan(plan, removeOptions(current, plan, liveConfig)),
    ).resolves.toMatchObject({ status: "complete", agentRemoved: true });
    expect(current.getConfig().agents?.entries?.worker).toBeUndefined();
  });

  it("reports adapter identity drift for an installed extension without mutating provenance", async () => {
    const current = await addFixture();
    const extension = {
      id: "audit-tools",
      format: "claude" as const,
      detectedFormat: "claude" as const,
      mapped: ["skills"],
      unavailable: ["agents"],
      adapterIdentity: "openclaw/previous",
    };
    persistClawPackageRef(
      current.plan,
      {
        kind: "plugin",
        source: "clawhub",
        ref: "audit",
        version: "2.0.0",
        integrity: packageIntegrity,
        extension,
      },
      { env: current.env, nowMs: 2, relationship: "referenced" },
    );

    const status = await readClawStatus("worker", {
      env: current.env,
      config: current.getConfig(),
      packageDeps: {
        resolvePlugin: async () => ({
          status: "found" as const,
          pluginId: "audit",
          installedVersion: "2.0.0",
          record: { source: "clawhub", integrity: packageIntegrity },
        }),
      },
    });

    expect(status.summary.driftedPackages).toBe(1);
    expect(status.records[0]?.packages[0]).toMatchObject({
      state: "present",
      extension,
      extensionCompatibility: {
        state: "drifted",
        mapped: ["agents", "skills"],
        unavailable: [],
        adapterIdentity: "openclaw/v1",
      },
    });
    expect(readClawPackageRefs({ env: current.env })[0]?.extension).toEqual(extension);
  });

  it("reports unavailable extension inspection separately from package drift", async () => {
    const current = await addFixture();
    const extension = {
      id: "audit-tools",
      format: "claude" as const,
      detectedFormat: "claude" as const,
      mapped: ["skills"],
      unavailable: ["agents"],
      adapterIdentity: "openclaw/current",
    };
    persistClawPackageRef(
      current.plan,
      {
        kind: "plugin",
        source: "clawhub",
        ref: "audit",
        version: "2.0.0",
        integrity: packageIntegrity,
        extension,
      },
      { env: current.env, nowMs: 2, relationship: "referenced" },
    );

    const status = await readClawStatus("worker", {
      env: current.env,
      config: current.getConfig(),
      packageDeps: {
        resolvePlugin: async () => ({
          status: "found" as const,
          pluginId: "audit",
          installedVersion: "2.0.0",
          record: { source: "clawhub", integrity: packageIntegrity },
        }),
      },
      packagePreflight: async () => ({
        ok: false,
        code: "extension_unavailable",
        message: "Canonical extension inspection is unavailable.",
      }),
    });

    expect(status.summary).toMatchObject({ driftedPackages: 0, unavailableExtensions: 1 });
    expect(status.records[0]?.packages[0]).toMatchObject({
      state: "present",
      extensionCompatibility: {
        state: "unavailable",
        message: "Canonical extension inspection is unavailable.",
      },
    });
  });

  it("counts every non-complete root install as partial", async () => {
    const current = await fixture();
    persistClawInstallRecord(current.plan, { env: current.env, status: "config_committed" });

    await expect(
      readClawStatus("worker", { env: current.env, config: { agents: { entries: {} } } }),
    ).resolves.toMatchObject({ summary: { claws: 1, partial: 1 } });
  });

  it("reports orphaned subordinate ownership without a root install row", async () => {
    const current = await fixture();
    persistClawPackageRef(
      current.plan,
      {
        kind: "plugin",
        source: "clawhub",
        ref: "audit",
        version: "2.0.0",
        integrity: packageIntegrity,
      },
      { env: current.env, nowMs: 2 },
    );

    await expect(readClawStatus("worker", { env: current.env, config: {} })).resolves.toMatchObject(
      {
        summary: { claws: 1, partial: 1, missingAgents: 1, packageRefs: 1 },
        records: [
          {
            orphaned: true,
            install: { agentId: "worker", status: "partial" },
            packages: [{ ref: "audit", state: "missing" }],
          },
        ],
      },
    );
    await expect(readClawStatusForGateway({ config: {} })).resolves.toMatchObject({
      records: [
        {
          agentId: "worker",
          status: "partial",
          agentState: "missing",
          orphaned: true,
          resources: expect.arrayContaining([
            expect.objectContaining({ kind: "plugin", id: "audit@2.0.0" }),
          ]),
        },
      ],
      summary: { claws: 1, attention: 1 },
    });

    const remove = await buildClawRemovePlan("worker", { env: current.env, config: {} });
    const removed = await applyClawRemovePlan(remove, {
      monitorGateway: quiescentClawMonitorGateway,
      trashPath: async () => true,
      env: current.env,
      config: {},
      consentPlanIntegrity: remove.planIntegrity,
      purgeSessions: async () => undefined,
    });
    expect(removed).toMatchObject({ status: "complete", agentRemoved: false });
    await expect(readClawStatus("worker", { env: current.env, config: {} })).resolves.toMatchObject(
      {
        summary: { claws: 0 },
      },
    );
    await expect(readClawStatusForGateway({ config: {} })).resolves.toMatchObject({
      records: [],
      summary: { claws: 0, attention: 0 },
    });
  });

  it("previews all canonical agent config deletion effects", async () => {
    const current = await addFixture();
    const config: OpenClawConfig = {
      ...current.getConfig(),
      bindings: [{ match: { channel: "telegram", accountId: "*" }, agentId: "worker" }],
      tools: { agentToAgent: { allow: ["worker"] } },
    } as OpenClawConfig;

    const plan = await buildClawRemovePlan("worker", { env: current.env, config });

    expect(plan.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "agent", target: 'agents.entries["worker"]' }),
        expect.objectContaining({ kind: "configBinding", target: "bindings[agentId=worker]" }),
        expect.objectContaining({ kind: "agentAllow", target: "tools.agentToAgent.allow[worker]" }),
        expect.objectContaining({ kind: "workspace", action: "trash" }),
        expect.objectContaining({ kind: "agentState", action: "trash" }),
        expect.objectContaining({ kind: "sessionIndex", action: "delete" }),
        expect.objectContaining({ kind: "sessionTranscripts", action: "trash" }),
      ]),
    );
  });

  it("refuses changed bindings and retains the cleanup fence", async () => {
    const current = await addFixture();
    const config: OpenClawConfig = {
      ...current.getConfig(),
      bindings: [{ match: { channel: "telegram", accountId: "first" }, agentId: "worker" }],
    } as OpenClawConfig;
    const plan = await buildClawRemovePlan("worker", { env: current.env, config });
    const changedConfig: OpenClawConfig = {
      ...config,
      bindings: [{ match: { channel: "telegram", accountId: "second" }, agentId: "worker" }],
    } as OpenClawConfig;

    await expect(
      applyClawRemovePlan(plan, {
        monitorGateway: {
          ...quiescentClawMonitorGateway,
          quiesce: async () => {
            await state.writeConfig(changedConfig);
          },
        },
        env: current.env,
        config,
        consentPlanIntegrity: plan.planIntegrity,
      }),
    ).resolves.toMatchObject({
      status: "partial",
      agentRemoved: false,
      error: { code: "agent_modified" },
    });
    expect(readAgentDeletionJournal("worker", { env: current.env })).toMatchObject({
      cleanupCompleted: false,
    });
  });

  it("keeps Claw-owned cron removal actions separate from independent jobs", async () => {
    const current = await addFixture({ withCron: true });
    seedAttachedCronJob(current.env, {
      id: "scheduler-daily",
      name: "Claw job",
      schedule: { kind: "cron", expr: "0 9 * * *", tz: "UTC" },
    });
    for (const id of ["z-operator-job", "a-operator-job"]) {
      seedAttachedCronJob(current.env, {
        id,
        name: "Operator job",
        schedule: { kind: "every", everyMs: 60_000 },
      });
    }

    const plan = await buildClawRemovePlan("worker", {
      env: current.env,
      config: current.getConfig(),
    });
    const independentIds = ["a-operator-job", "z-operator-job"];
    expect(plan.blockers).toEqual(
      independentIds.map((id) => ({
        code: "agent_job_attached",
        message: expect.stringContaining(JSON.stringify(id)),
      })),
    );
    expect(plan.actions.filter((action) => action.kind === "scheduledJob")).toEqual(
      independentIds.map((id) => expect.objectContaining({ id, action: "retain", blocked: true })),
    );
    expect(plan.actions.filter((action) => action.kind === "cronJob")).toEqual([
      expect.objectContaining({
        id: "daily-report",
        target: "scheduler-daily",
        action: "remove",
        blocked: false,
      }),
    ]);
  });

  it("removes the agent and unchanged files but only releases package refs", async () => {
    const current = await addFixture({ withFile: true });
    const databasePath = join(
      current.env.OPENCLAW_STATE_DIR,
      "agents",
      "worker",
      "agent",
      "openclaw-agent.sqlite",
    );
    registerOpenClawAgentDatabase({ agentId: "worker", path: databasePath, env: current.env });
    persistClawPackageRef(
      current.plan,
      {
        kind: "skill",
        source: "clawhub",
        ref: "triage",
        version: "1.0.0",
        integrity: packageIntegrity,
      },
      { env: current.env },
    );
    const plan = await buildClawRemovePlan("worker", {
      env: current.env,
      config: current.getConfig(),
    });
    const config = current.getConfig();
    const result = await applyClawRemovePlan(plan, {
      ...removeOptions(current, plan, config),
    });
    expect(result).toMatchObject({
      status: "complete",
      agentRemoved: true,
      packageRefsReleased: 1,
      workspaceFiles: [{ path: "SOUL.md", action: "deleted" }],
    });
    expect(loadConfig().agents?.entries?.worker).toBeUndefined();
    expect(
      listOpenClawRegisteredAgentDatabases({ env: current.env }).map((entry) => entry.agentId),
    ).not.toContain("worker");
    await expect(readFile(join(current.plan.agent.workspace, "SOUL.md"), "utf8")).rejects.toThrow();
    await expect(
      readClawStatus("worker", { env: current.env, config: loadConfig() }),
    ).resolves.toMatchObject({
      summary: { claws: 0 },
    });
  });

  it("removes scheduler-owned cron jobs before agent config", async () => {
    const current = await addFixture({ withCron: true });
    const plan = await buildClawRemovePlan("worker", {
      env: current.env,
      config: current.getConfig(),
    });
    expect(plan.actions).toContainEqual(
      expect.objectContaining({
        kind: "cronJob",
        id: "daily-report",
        action: "remove",
        target: "scheduler-daily",
      }),
    );
    const config = current.getConfig();
    const order: string[] = [];
    const result = await applyClawRemovePlan(plan, {
      ...removeOptions(current, plan, config),
      cronGateway: {
        get: async () =>
          cronReadView("worker", readClawCronRefs("worker", { env: current.env })[0]!),
        remove: async (id) => {
          expect(loadConfig().agents?.entries?.worker).toBeDefined();
          order.push(`cron:${id}`);
          return { ok: true };
        },
      },
    });
    expect(order).toEqual(["cron:scheduler-daily"]);
    expect(loadConfig().agents?.entries?.worker).toBeUndefined();
    expect(result).toMatchObject({
      status: "complete",
      cronJobs: [
        { manifestId: "daily-report", schedulerJobId: "scheduler-daily", action: "removed" },
      ],
    });
  });

  it("accepts scheduler defaults when removing a Claw cron job", async () => {
    const current = await addFixture({ withCron: true });
    const plan = await buildClawRemovePlan("worker", {
      env: current.env,
      config: current.getConfig(),
    });
    const ref = readClawCronRefs("worker", { env: current.env })[0]!;
    const live = cronReadView("worker", ref);
    const remove = vi.fn().mockResolvedValue({ ok: true });

    const result = await applyClawRemovePlan(plan, {
      ...removeOptions(current, plan),
      cronGateway: {
        get: async () => ({
          ...live,
          payload: { ...live.payload, toolsAllow: ["*"] },
          scheduledToolPolicy: { version: 1, mode: "trusted" },
        }),
        remove,
      },
    });

    expect(remove).toHaveBeenCalledWith(ref.schedulerJobId);
    expect(result).toMatchObject({
      status: "complete",
      agentRemoved: true,
      cronJobs: [{ manifestId: "daily-report", action: "removed" }],
    });
  });

  it("fails removal planning when source MCP config cannot be read", async () => {
    const current = await addFixture({ withCron: true });

    await expect(
      buildClawRemovePlan("worker", {
        env: current.env,
        config: current.getConfig(),
        listMcpServers: async () => ({
          ok: false,
          path: "config",
          error: "Config file is invalid.",
        }),
      }),
    ).rejects.toMatchObject({ code: "mcp_config_unavailable" });
  });

  it("retains the agent when recurring work cannot be disabled", async () => {
    const current = await addFixture({ withCron: true });
    const plan = await buildClawRemovePlan("worker", {
      env: current.env,
      config: current.getConfig(),
    });
    const result = await applyClawRemovePlan(plan, {
      ...removeOptions(current, plan),
      cronGateway: {
        get: async () =>
          cronReadView("worker", readClawCronRefs("worker", { env: current.env })[0]!),
        remove: async () => {
          throw new Error("scheduler unavailable");
        },
      },
    });

    expect(result).toMatchObject({
      status: "partial",
      agentRemoved: false,
      error: { code: "cron_cleanup_failed", message: "scheduler unavailable" },
      cronJobs: [{ manifestId: "daily-report", action: "error" }],
    });
  });

  it("reconciles a lost cron.remove response when the gateway confirms absence", async () => {
    const current = await addFixture({ withCron: true });
    const plan = await buildClawRemovePlan("worker", {
      env: current.env,
      config: current.getConfig(),
    });
    const ref = readClawCronRefs("worker", { env: current.env })[0]!;
    let present = true;
    const config = current.getConfig();

    const result = await applyClawRemovePlan(plan, {
      ...removeOptions(current, plan, config),
      cronGateway: {
        get: async () => (present ? cronReadView("worker", ref) : undefined),
        remove: async () => {
          present = false;
          throw new Error("response lost");
        },
      },
    });

    expect(result).toMatchObject({
      status: "complete",
      cronJobs: [{ manifestId: "daily-report", action: "removed" }],
    });
  });

  it("preserves a live cron job that changed after planning", async () => {
    const current = await addFixture({ withCron: true });
    const plan = await buildClawRemovePlan("worker", {
      env: current.env,
      config: current.getConfig(),
    });
    const remove = vi.fn();

    const result = await applyClawRemovePlan(plan, {
      ...removeOptions(current, plan),
      cronGateway: {
        get: async () => ({
          ...cronReadView("worker", readClawCronRefs("worker", { env: current.env })[0]!),
          schedule: { kind: "cron", expr: "0 12 * * *", tz: "UTC" },
        }),
        remove,
      },
    });

    expect(result).toMatchObject({
      status: "partial",
      agentRemoved: false,
      error: { code: "cron_cleanup_failed", message: expect.stringContaining("changed") },
    });
    expect(remove).not.toHaveBeenCalled();
  });

  it("finishes local cleanup without repeating a confirmed remote cron removal", async () => {
    const current = await addFixture({ withCron: true });
    markClawCronRefRemoved("worker", "daily-report", { env: current.env });
    const plan = await buildClawRemovePlan("worker", {
      env: current.env,
      config: current.getConfig(),
    });
    const config = current.getConfig();
    const remoteRemovals: string[] = [];

    const result = await applyClawRemovePlan(plan, {
      ...removeOptions(current, plan, config),
      cronGateway: {
        remove: async (id) => {
          remoteRemovals.push(id);
          return { ok: true };
        },
      },
    });

    expect(remoteRemovals).toEqual([]);
    expect(result).toMatchObject({
      status: "complete",
      cronJobs: [{ manifestId: "daily-report", action: "removed" }],
    });
  });

  it("preserves modified files while releasing their provenance", async () => {
    const current = await addFixture({ withFile: true });
    const target = join(current.plan.agent.workspace, "SOUL.md");
    await writeFile(target, "operator edit\n", "utf8");
    const plan = await buildClawRemovePlan("worker", {
      env: current.env,
      config: current.getConfig(),
    });
    expect(plan.actions).toContainEqual(
      expect.objectContaining({ kind: "workspace", action: "retain" }),
    );
    const trashPath = vi.fn().mockResolvedValue(true);
    expect(plan.actions).toContainEqual(
      expect.objectContaining({ kind: "workspaceFile", action: "retain", blocked: false }),
    );
    const config = current.getConfig();
    const result = await applyClawRemovePlan(plan, {
      monitorGateway: quiescentClawMonitorGateway,
      consentPlanIntegrity: plan.planIntegrity,
      env: current.env,
      config,
      trashPath,
    });
    expect(result.workspaceFiles).toEqual([{ path: "SOUL.md", action: "retainedModified" }]);
    await expect(readFile(target, "utf8")).resolves.toBe("operator edit\n");
    expect(trashPath).not.toHaveBeenCalledWith(current.plan.agent.workspace, expect.anything());
  });
});
