import "../test-utils/prepare-compiled-subprocesses.js";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { isAgentDeletionBlocked } from "../agents/agent-lifecycle-registry.js";
import * as mcpMutation from "../agents/mcp-config-mutation.js";
import * as mcpConfig from "../config/mcp-config.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { writeSessionEntry } from "../config/sessions/session-accessor.sqlite-entry-store.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isCronWithinActiveHours } from "../cron/active-hours.js";
import { resolveCronJobConfigRevision } from "../cron/config-revision.js";
import { normalizeCronJobCreate } from "../cron/normalize.js";
import { CronService } from "../cron/service.js";
import { createNoopLogger } from "../cron/service.test-harness.js";
import { completeAgentDeletionJournalInDatabase } from "../state/agent-deletion-journal.js";
import {
  closeOpenClawAgentDatabasesForTest,
  runOpenClawAgentWriteTransaction,
} from "../state/openclaw-agent-db.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import {
  beginAgentDeletionJournal,
  readAgentDeletionJournal,
} from "../test-utils/agent-deletion-journal.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import {
  applyTemplateAddPlanStateless,
  type StatelessTemplateAddOptions,
} from "./add-stateless.js";
import * as cronInstall from "./cron.js";
import type { TemplateCronGateway } from "./cron.js";
import { buildGatewayTemplateAddPlan } from "./gateway-add-plan.js";
import { projectTemplateAddScheduledJobs } from "./gateway-disclosure.js";
import { buildTemplateAddPlan } from "./lifecycle.js";
import {
  TEMPLATE_MCP_REF_SCHEMA_VERSION,
  type PersistedTemplateMcpServerRef,
} from "./mcp-records.js";
import * as mcpInstall from "./mcp.js";
import * as packageInstall from "./packages.js";
import type { PersistedTemplatePackageRef } from "./provenance.js";
import { readTemplateManifestFile } from "./reader.js";
import { parseTemplateOpenClawProfile } from "./schema.js";
import type { TemplateReadResult } from "./types.js";
import * as workspaceFiles from "./workspace.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => clearRuntimeConfigSnapshot());
afterEach(() => vi.unstubAllEnvs());
afterEach(() => vi.restoreAllMocks());
afterEach(() => closeOpenClawAgentDatabasesForTest());

function createTemplateCronAdapter(cron: CronService) {
  return {
    add: async (input, options) => {
      const normalized = normalizeCronJobCreate(input);
      if (!normalized) {
        throw new Error("invalid cron input");
      }
      return await cron.add(normalized, { commitGuard: options?.commitGuard });
    },
    list: async () => ({ jobs: await cron.list({ includeDisabled: true }) }),
    get: async (id) => {
      const job = await cron.readJob(id);
      return job && { ...job, configRevision: resolveCronJobConfigRevision(job) };
    },
    writeScratch: async (id, content, commitGuard) => {
      const result = await cron.writeScratch(id, { content, expectedRevision: 0, commitGuard });
      if (!result.ok) {
        throw new Error("scratch changed before import");
      }
    },
    enable: async (id, expectedConfigRevision, commitGuard) => {
      await cron.updateWithPrecondition(
        id,
        { enabled: true },
        (job) => {
          if (resolveCronJobConfigRevision(job) !== expectedConfigRevision) {
            throw new Error("automation changed before enable");
          }
        },
        { commitGuard },
      );
    },
    remove: async (id, options) => await cron.remove(id, options),
  } satisfies TemplateCronGateway;
}

describe("stateless Template Add", () => {
  let stateDir: string;
  let source: Extract<TemplateReadResult, { ok: true }>;
  let config = { agents: { entries: {} } };
  beforeEach(async () => {
    stateDir = tempDirs.make("openclaw-templates-stateless-");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const sourceRoot = path.join(stateDir, "source");
    mkdirSync(sourceRoot);
    writeFileSync(path.join(sourceRoot, "SOUL.md"), "Workspace agent instructions.\n");
    const manifestPath = path.join(sourceRoot, "template.json");
    writeFileSync(
      manifestPath,
      JSON.stringify({
        schemaVersion: 1,
        agent: { id: "workspace-agent", name: "Workspace Agent" },
        workspace: { bootstrapFiles: { "SOUL.md": { source: "SOUL.md" } } },
      }),
    );
    const result = await readTemplateManifestFile(manifestPath);
    if (!result.ok) {
      throw new Error(JSON.stringify(result.diagnostics));
    }
    source = result;
    config = { agents: { entries: {} } };
  });
  const buildPlan = () => buildGatewayTemplateAddPlan(source, { config, sourceMcpServers: {} });
  const commitConfig: NonNullable<StatelessTemplateAddOptions["commitConfig"]> = async (
    transform,
  ) => {
    config = transform(config) as typeof config;
  };
  const apply = (
    plan: Awaited<ReturnType<typeof buildPlan>>,
    options: StatelessTemplateAddOptions = {},
  ) =>
    applyTemplateAddPlanStateless(plan, {
      consentPlanIntegrity: plan.planIntegrity,
      commitConfig,
      ...options,
    });
  const beginDeletion = (operationId: string) => {
    const agentId = source.manifest.agent.id;
    return beginAgentDeletionJournal({
      operationId,
      deleteFiles: false,
      agentId,
      agentDir: path.join(stateDir, "agents", agentId, "agent"),
      workspaceDir: path.join(stateDir, `workspace-${agentId}`),
      sessionsDir: path.join(stateDir, "agents", agentId, "sessions"),
    });
  };

  it("reuses a deleted agent ID without leaving its database fenced", async () => {
    const agentId = source.manifest.agent.id;
    const deletion = beginDeletion("prior-deletion");
    runOpenClawStateWriteTransaction((database) =>
      completeAgentDeletionJournalInDatabase(database, deletion.agentId, deletion.operationId),
    );
    expect(isAgentDeletionBlocked(agentId)).toBe(true);
    expect(() =>
      runOpenClawAgentWriteTransaction(() => undefined, { agentId, env: process.env }),
    ).toThrow(`agent ${agentId} is deleted`);

    const plan = await buildPlan();
    const result = await apply(plan);

    expect(result.status).toBe("complete");
    expect(readAgentDeletionJournal(agentId, {}, "runtime")).toBeUndefined();
    expect(isAgentDeletionBlocked(agentId)).toBe(false);
    expect(config.agents.entries).toHaveProperty(agentId);
    expect(() =>
      runOpenClawAgentWriteTransaction(
        (database) =>
          writeSessionEntry(database, `agent:${agentId}:main`, {
            sessionId: "new-chat-after-readd",
            updatedAt: Date.now(),
          }),
        { agentId, env: process.env },
      ),
    ).not.toThrow();
  });

  it("does not publish an agent while its prior deletion is unfinished", async () => {
    const agentId = source.manifest.agent.id;
    beginDeletion("pending-deletion");

    const plan = await buildPlan();
    const result = await apply(plan);

    expect(result).toMatchObject({
      status: "partial",
      error: { code: "agent_deletion_pending" },
      configCommitted: false,
    });
    expect(config.agents.entries).not.toHaveProperty(agentId);
    expect(readAgentDeletionJournal(agentId, {}, "runtime")?.cleanupCompleted).toBe(false);
  });

  it("adds numbered ordinary agents without an install record", async () => {
    const add = async () => apply(await buildPlan());

    const first = await add();
    const second = await add();

    expect(first.status).toBe("complete");
    expect(first).not.toHaveProperty("installRecord");
    expect(second).toMatchObject({
      status: "complete",
      agent: { finalId: "workspace-agent-2", config: { name: "Workspace Agent 2" } },
    });
    expect(Object.keys(config.agents.entries)).toEqual([
      "main",
      "workspace-agent",
      "workspace-agent-2",
    ]);
    expect(existsSync(path.join(stateDir, "workspace-workspace-agent-2", "SOUL.md"))).toBe(true);
  });

  it.each(["workspace failure", "lost config acknowledgement"] as const)(
    "rolls back the new agent and workspace after %s",
    async (failure) => {
      const plan = await buildPlan();
      let writes = 0;
      const message =
        failure === "workspace failure" ? "test file failure" : "write acknowledgment lost";
      if (failure === "workspace failure") {
        vi.spyOn(workspaceFiles, "createTemplateWorkspaceFiles").mockRejectedValueOnce(
          new Error(message),
        );
      }
      const result = await apply(
        plan,
        failure === "workspace failure"
          ? {}
          : {
              getCurrentConfig: () => config,
              commitConfig: async (transform) => {
                config = transform(config) as typeof config;
                if (++writes === 1) {
                  throw new Error(message);
                }
              },
            },
      );
      expect(result).toMatchObject({
        status: "partial",
        configCommitted: false,
        workspaceCreated: false,
        error: { code: "add_failed", message },
      });
      expect(Object.keys(config.agents.entries)).toEqual(
        failure === "workspace failure" ? [] : ["main"],
      );
      expect(existsSync(plan.agent.workspace)).toBe(false);
    },
  );

  it("keeps an exposed workspace if its files changed before rollback", async () => {
    const plan = await buildPlan();
    vi.spyOn(cronInstall, "installTemplateCronJobsStateless").mockImplementationOnce(async () => {
      writeFileSync(path.join(plan.agent.workspace, "USER.md"), "new user content");
      throw new Error("scheduler unavailable");
    });
    const result = await apply(plan);

    expect(result).toMatchObject({
      status: "partial",
      configCommitted: true,
      workspaceCreated: true,
      error: { code: "add_rollback_incomplete" },
    });
    expect(result.error?.message).toContain("Workspace changed");
    expect(Object.keys(config.agents.entries)).toEqual(["main", "workspace-agent"]);
    expect(existsSync(path.join(plan.agent.workspace, "USER.md"))).toBe(true);
  });

  const configured = { command: "npx", args: ["example-mcp"] };
  const configSnapshot = {
    path: "/fixture/openclaw.json",
    config: {},
    authoredConfig: {},
    runtimeConfig: {},
    sourceConfigBeforeMigrations: {},
    mcpServers: {},
  };
  const mcpRef = (
    name: string,
    origin: PersistedTemplateMcpServerRef["origin"],
  ): PersistedTemplateMcpServerRef => ({
    schemaVersion: TEMPLATE_MCP_REF_SCHEMA_VERSION,
    agentId: "new-agent",
    name,
    configDigest: mcpInstall.digestTemplateMcpServer(configured),
    relationship: origin === "template-introduced" ? "managed" : "referenced",
    origin,
    independentOwner: true,
    status: "complete",
    createdAtMs: 1,
    updatedAtMs: 1,
  });

  it.each([false, true])(
    "cleans unchanged shared requirements after publish failure (MCP changed=%s)",
    async (changed) => {
      const plan = await buildPlan();
      plan.actions.push(
        {
          kind: "package",
          id: "@owner/new-plugin",
          action: "install",
          target: "plugins",
          details: { kind: "plugin" },
          blocked: false,
        },
        {
          kind: "mcpServer",
          id: "new-server",
          action: "configure",
          target: "mcp.servers.new-server",
          blocked: false,
        },
      );
      const packageRef = (origin: PersistedTemplatePackageRef["origin"]) =>
        ({ kind: "plugin", origin, status: "complete" }) as PersistedTemplatePackageRef;
      const introducedPackage = packageRef("template-introduced");
      const reusedPackage = packageRef("pre-existing");
      const introducedMcp = mcpRef("new-server", "template-introduced");
      const reusedMcp = mcpRef("existing-server", "pre-existing");
      vi.spyOn(packageInstall, "rollbackStatelessTemplatePackages").mockImplementation(
        async (refs) => {
          refs[0]!.status = "rolled_back";
          return [];
        },
      );
      const unsetMcpServer = vi.spyOn(mcpMutation, "unsetConfiguredMcpServer");
      unsetMcpServer.mockResolvedValue({ ...configSnapshot, ok: true, removed: true });
      vi.spyOn(mcpConfig, "listConfiguredMcpServers").mockResolvedValue({
        ...configSnapshot,
        ok: true,
        mcpServers: { "new-server": changed ? { command: "different-command" } : configured },
      });
      vi.spyOn(packageInstall, "installTemplatePackages").mockResolvedValueOnce([
        introducedPackage,
        reusedPackage,
      ]);
      vi.spyOn(mcpInstall, "installTemplateMcpServersStateless").mockImplementationOnce(
        async (_plan, { refs }) => {
          refs.push(introducedMcp, reusedMcp);
        },
      );

      const result = await apply(plan, {
        commitConfig: async () => {
          throw new Error("publish failed");
        },
        getCurrentConfig: () => ({ agents: { entries: {} } }),
      });

      expect(result.error).toMatchObject({
        code: "add_failed",
        message: changed
          ? "publish failed Shared plugins or MCP servers already added were kept; remove them separately if unused."
          : "publish failed",
      });
      expect(result.packages.map((ref) => ref.status)).toEqual(["rolled_back", "complete"]);
      expect(result.mcpServers).toEqual(changed ? [introducedMcp, reusedMcp] : [reusedMcp]);
      if (changed) {
        expect(unsetMcpServer).not.toHaveBeenCalled();
      } else {
        expect(unsetMcpServer).toHaveBeenCalledWith(
          expect.objectContaining({ name: "new-server", expectedServer: configured }),
        );
      }
      expect(existsSync(plan.agent.workspace)).toBe(false);
    },
  );
});

const checklist = "# Checklist\nCheck active incidents.\n";
const baseConfig = (): OpenClawConfig => ({
  agents: { entries: { main: {} } },
  plugins: { enabled: false },
});
async function portableSource(fixture: OpenClawTestState) {
  const packageRoot = fixture.statePath("package");
  await mkdir(packageRoot, { recursive: true });
  await writeFile(
    path.join(packageRoot, "template.json"),
    JSON.stringify({
      schemaVersion: 1,
      agent: { id: "portable", name: "Portable" },
      workspace: { bootstrapFiles: { "HEARTBEAT.md": { source: "HEARTBEAT.md" } } },
    }),
  );
  await writeFile(
    path.join(packageRoot, "HEARTBEAT.md"),
    `${checklist}tasks:\n- name: Summary\n  interval: 15m\n  prompt: Prepare a summary.\n`,
  );
  const source = await readTemplateManifestFile(path.join(packageRoot, "template.json"));
  assert(source.ok, JSON.stringify(source.diagnostics));
  return source;
}

it.each([
  { every: "5m", changed: "none" },
  { every: "0m", changed: "none" },
  { every: "5m", changed: "source" },
  { every: "5m", changed: "definition" },
  { every: "5m", changed: "scratch" },
  { every: "5m", changed: "rollback-definition" },
  { every: "5m", changed: "rollback-scratch" },
  { every: "5m", changed: "missing-scratch-adapter" },
])(
  "adds portable heartbeat $every with consent and scratch guarded ($changed)",
  async ({ every, changed }) => {
    const rollback = changed.startsWith("rollback-");
    const scratchChanged = changed.endsWith("scratch");
    const definitionChanged = changed.endsWith("definition");
    await withOpenClawTestState({ label: "template-portable-add" }, async (fixture) => {
      const source = await portableSource(fixture);
      let config = baseConfig();
      setRuntimeConfigSnapshot(config);
      const makePlan = () =>
        buildTemplateAddPlan({
          manifest: source.manifest,
          source: source.source,
          openClawProfile: { schemaVersion: 1, agent: { heartbeat: { every } } },
          context: { config, workspace: fixture.statePath("added-workspace") },
        });
      const plan = await makePlan();
      expect((await makePlan()).planIntegrity).toBe(plan.planIntegrity);
      expect(plan.agent.config).not.toHaveProperty("heartbeat");
      expect(projectTemplateAddScheduledJobs(plan).jobs.map((job) => job.proposed)).toEqual([
        expect.objectContaining({
          schedule: { everyMs: every === "0m" ? 1_800_000 : 300_000 },
          delivery: "owner",
          session: "main",
        }),
        expect.objectContaining({
          schedule: { everyMs: 900_000 },
          delivery: "owner",
          message: "Prepare a summary.",
        }),
      ]);
      if (changed === "source") {
        await writeFile(fixture.statePath("package", "HEARTBEAT.md"), "Changed after consent.\n");
      }
      const run = vi.fn(async () => ({ status: "ok" as const }));
      const cron = new CronService({
        storePath: fixture.statePath("cron", "jobs.json"),
        scheduler: createTestGatewayScheduler(),
        cronEnabled: true,
        defaultAgentId: "main",
        log: createNoopLogger(),
        enqueueSystemEvent: vi.fn(),
        runSessionEvent: run,
        runIsolatedAgentJob: run,
      });
      await cron.start();
      const gateway = createTemplateCronAdapter(cron);
      try {
        const result = await applyTemplateAddPlanStateless(plan, {
          config,
          consentPlanIntegrity: plan.planIntegrity,
          getCurrentConfig: () => config,
          commitConfig: async (transform) => {
            config = transform(config);
            setRuntimeConfigSnapshot(config);
          },
          cronGateway: {
            ...gateway,
            add: async (input, options) => {
              if (rollback && input.name === "Summary") {
                const [existing] = await cron.list({ includeDisabled: true });
                if (scratchChanged) {
                  const edited = await cron.writeScratch(existing!.id, {
                    content: "Operator checklist",
                    expectedRevision: 1,
                  });
                  expect(edited.ok).toBe(true);
                } else {
                  await cron.update(existing!.id, { name: "Operator edit" });
                }
                throw new Error("Second automation could not be added");
              }
              return gateway.add(input, options);
            },
            writeScratch:
              changed === "missing-scratch-adapter"
                ? undefined
                : async (id, content, commitGuard) => {
                    expect((await cron.readJob(id))?.enabled).toBe(false);
                    expect(await cron.run(id, "due")).toMatchObject({ ran: false });
                    expect(run).not.toHaveBeenCalled();
                    if (changed === "scratch") {
                      await cron.writeScratch(id, {
                        content: "Operator checklist",
                        expectedRevision: 0,
                      });
                    }
                    await gateway.writeScratch(id, content, commitGuard);
                    if (changed === "definition") {
                      await cron.update(id, { name: "Operator edit" });
                    }
                  },
            enable: async (id, revision, commitGuard) => {
              expect((await cron.readScratch(id)).scratch?.content).toBe(checklist);
              await gateway.enable(id, revision, commitGuard);
            },
          },
        });
        const jobs = await cron.list({ includeDisabled: true });
        if (changed === "source" || changed === "missing-scratch-adapter") {
          expect(result).toMatchObject({ status: "partial", configCommitted: false });
          expect(result.error?.message).toContain(
            changed === "source"
              ? "changed after consent"
              : "requires the gateway-owned cron.scratch.set API",
          );
          expect(jobs).toEqual([]);
          expect(config.agents?.entries).not.toHaveProperty("portable");
          return;
        }
        if (definitionChanged || scratchChanged) {
          expect(result).toMatchObject({
            status: "partial",
            configCommitted: true,
            error: { code: "cron_scratch_import_incomplete" },
          });
          expect(result.error?.message).toContain("Inspect their scratch and enabled state");
          expect(jobs).toHaveLength(1);
          expect(jobs[0]).toMatchObject({
            enabled: rollback,
            ...(definitionChanged ? { name: "Operator edit" } : {}),
          });
          expect((await cron.readScratch(jobs[0]!.id)).scratch?.content).toBe(
            scratchChanged ? "Operator checklist" : checklist,
          );
          expect(config.agents?.entries).toHaveProperty("portable");
          expect(run).not.toHaveBeenCalled();
          return;
        }
        expect(result.status, result.error?.message).toBe("complete");
        expect(jobs).toHaveLength(2);
        expect(jobs.every((job) => job.enabled === (every !== "0m"))).toBe(true);
        expect(jobs.find((job) => job.name === "Summary")?.payload).toMatchObject({
          kind: "agentTurn",
          message: "Prepare a summary.",
        });
        const monitor = jobs.find((job) => job.name !== "Summary")!;
        expect((await cron.readScratch(monitor.id)).scratch?.content).toBe(checklist);
      } finally {
        cron.stop();
        await cron.waitForIdle();
      }
    });
  },
);

const overnight = { start: "22:00", end: "06:00", timezone: "UTC" };
it.each([
  ["start only", { start: "22:00" }, undefined, [true, true]],
  ["end only", { end: "06:00" }, undefined, [true, true]],
  ["complete overnight window", { ...overnight }, overnight, [false, true]],
] as const)(
  "preserves portable active-hours admission for %s",
  async (_name, activeHours, expectedHours, allowed) => {
    await withOpenClawTestState({ label: "template-portable-active-hours" }, async (fixture) => {
      const source = await portableSource(fixture);
      const profile = parseTemplateOpenClawProfile({
        schemaVersion: 1,
        agent: { heartbeat: { every: "5m", activeHours } },
      });
      assert(profile.ok, JSON.stringify(profile.diagnostics));
      const plan = await buildTemplateAddPlan({
        manifest: source.manifest,
        source: source.source,
        openClawProfile: profile.profile,
        context: {
          config: baseConfig(),
          workspace: fixture.statePath("added-workspace"),
        },
      });
      const jobs = plan.actions.flatMap((action) => (action.automation ? [action.automation] : []));
      expect(jobs).toHaveLength(2);
      for (const job of jobs) {
        expect(job.activeHours).toEqual(expectedHours);
        expect(
          [Date.UTC(2026, 0, 1, 12), Date.UTC(2026, 0, 1, 23)].map((nowMs) =>
            isCronWithinActiveHours(job.activeHours, nowMs, "UTC"),
          ),
        ).toEqual(allowed);
      }
    });
  },
);
