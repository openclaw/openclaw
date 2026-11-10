import "../test-utils/prepare-compiled-subprocesses.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred, awaitGateBeforeSettlement } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { isAgentDeletionBlocked } from "../agents/agent-lifecycle-registry.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import {
  readSessionEntryRow,
  writeSessionEntry,
} from "../config/sessions/session-accessor.sqlite-entry-store.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isCronWithinActiveHours } from "../cron/active-hours.js";
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
import { workspaceIdentity } from "./add-checkpoint.js";
import {
  applyTemplateAddPlanStateless,
  type StatelessTemplateAddOptions,
  type TemplateConfiguredAgentCheckpoint,
} from "./add-stateless.js";
import * as bootstrapInstall from "./bootstrap.js";
import { createTemplateCronGateway } from "./cron-gateway.js";
import * as cronInstall from "./cron.js";
import { buildGatewayTemplateAddPlan } from "./gateway-add-plan.js";
import { projectTemplateAddScheduledJobs } from "./gateway-disclosure.js";
import { buildTemplateAddPlan } from "./lifecycle.js";
import * as mcpInstall from "./mcp.js";
import * as packageInstall from "./packages.js";
import { readTemplateManifestFile } from "./reader.js";
import { parseTemplateOpenClawProfile } from "./schema.js";
import type { TemplateManifest, TemplateReadResult } from "./types.js";
import * as workspaceFiles from "./workspace.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => clearRuntimeConfigSnapshot());
afterEach(() => vi.unstubAllEnvs());
afterEach(() => vi.restoreAllMocks());
afterEach(() => closeOpenClawAgentDatabasesForTest());

const createTemplateCronAdapter = (cron: CronService) =>
  createTemplateCronGateway(
    cron,
    () => ({ agents: { entries: { main: {} } } }),
    () => {},
  );

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
    const manifestPath = path.join(sourceRoot, "CLAW.md");
    writeFileSync(
      manifestPath,
      `---\n${JSON.stringify({
        schemaVersion: 1,
        agent: { id: "workspace-agent", name: "Workspace Agent" },
        workspace: { bootstrapFiles: { "SOUL.md": { source: "SOUL.md" } } },
      })}\n---\n`,
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
    const prepareAgentSession = vi.fn(async () => {
      expect(isAgentDeletionBlocked(agentId)).toBe(false);
      runOpenClawAgentWriteTransaction(
        (database) =>
          writeSessionEntry(database, `agent:${agentId}:main`, {
            sessionId: "prepared-chat-after-readd",
            updatedAt: Date.now(),
          }),
        { agentId, env: process.env },
      );
      return async () => {};
    });
    const result = await apply(plan, { prepareAgentSession, getCurrentConfig: () => config });

    expect(prepareAgentSession).toHaveBeenCalledOnce();
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

  it("makes the instructed agent and its canonical chat ready before deferrable setup", async () => {
    const plan = await buildPlan();
    plan.actions.push({
      kind: "package",
      action: "install",
      blocked: false,
      id: "notes",
      target: "notes",
      details: { kind: "plugin" },
    });
    const order: string[] = [];
    vi.spyOn(bootstrapInstall, "seedTemplatePackageBootstrap").mockImplementation(async () => {
      order.push("bootstrap");
      return undefined;
    });
    const greetingStarted = createDeferred();
    const greetingFinished = createDeferred();
    const routines = vi
      .spyOn(cronInstall, "installTemplateCronJobsStateless")
      .mockResolvedValue([]);
    const packages = vi
      .spyOn(packageInstall, "installTemplatePackages")
      .mockImplementation(async () => {
        order.push("packages");
        expect(order).toContain("agent-ready");
        return [];
      });
    const mcp = vi
      .spyOn(mcpInstall, "installTemplateMcpServersStateless")
      .mockImplementation(async () => {
        order.push("mcp");
      });
    const installation = apply(plan, {
      getCurrentConfig: () => config,
      prepareAgentSession: async () => {
        expect(readFileSync(path.join(plan.agent.workspace, "SOUL.md"), "utf8")).toBe(
          "Workspace agent instructions.\n",
        );
        order.push("session");
        return async () => {
          throw new Error("exposed chat must not be deleted");
        };
      },
      waitForAgentRuntime: async () => {
        expect(config.agents.entries).toHaveProperty(plan.agent.finalId);
        order.push("runtime");
        return "applied";
      },
      onAgentReady: async (agent) => {
        expect(agent).toEqual({
          agentId: "workspace-agent",
          sessionKey: "agent:workspace-agent:main",
        });
        order.push("agent-ready");
        greetingStarted.resolve();
        await greetingFinished.promise;
        order.push("greeting-visible");
      },
    });
    try {
      await awaitGateBeforeSettlement(
        greetingStarted.promise,
        installation,
        "Template Add finished before the normal greeting started",
      );
      expect(packages).not.toHaveBeenCalled();
      expect(mcp).not.toHaveBeenCalled();
      expect(routines).not.toHaveBeenCalled();
    } finally {
      greetingFinished.resolve();
    }
    const result = await installation;
    expect(result.status).toBe("complete");
    expect(order).toEqual([
      "session",
      "runtime",
      "agent-ready",
      "greeting-visible",
      "packages",
      "mcp",
      "bootstrap",
    ]);
    expect(routines).toHaveBeenCalledOnce();
  });

  it("retains an adopted agent and its chat when later setup fails", async () => {
    const plan = await buildPlan();
    const rollbackChat = vi.fn(async () => {});
    const result = await apply(plan, {
      getCurrentConfig: () => config,
      prepareAgentSession: async () => rollbackChat,
      waitForAgentRuntime: async () => {
        runOpenClawAgentWriteTransaction(
          (database) =>
            writeSessionEntry(database, "agent:workspace-agent:main", {
              sessionId: "chat-after-runtime-publication",
              updatedAt: Date.now(),
            }),
          { agentId: plan.agent.finalId, env: process.env },
        );
        return "applied";
      },
      onAgentReady: async () => {
        throw new Error("setup policy changed");
      },
    });
    expect(rollbackChat).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: "partial",
      configCommitted: true,
      workspaceCreated: true,
      agentRetained: true,
      error: { code: "add_failed", message: expect.stringContaining("setup policy changed") },
    });
    expect(config.agents.entries).toHaveProperty(plan.agent.finalId);
    expect(existsSync(plan.agent.workspace)).toBe(true);
    expect(
      runOpenClawAgentWriteTransaction(
        (database) => readSessionEntryRow(database, "agent:workspace-agent:main")?.entry.sessionId,
        { agentId: plan.agent.finalId, env: process.env },
      ),
    ).toBe("chat-after-runtime-publication");
  });

  it.each([
    "unchanged",
    "source-root",
    "workspace",
    "config",
    "source",
    "consent",
    "plan",
    "phase-only",
  ] as const)(
    "retries configured initialization without rewriting its agent or chat (%s)",
    async (change) => {
      if (change === "source-root") {
        const root = path.join(stateDir, "source");
        await writeFile(
          path.join(root, "package.json"),
          JSON.stringify({
            name: "@test/workspace-agent-template",
            version: "1.0.0",
            openclaw: { template: "CLAW.md" },
          }),
        );
        const loaded = await readTemplateManifestFile(root);
        assert(loaded.ok);
        source = {
          ...loaded,
          source: {
            ...loaded.source,
            integrityKind: "artifact",
            integrity: `sha256:${"a".repeat(64)}`,
          },
        };
      }
      const plan = await buildPlan();
      let checkpoint: TemplateConfiguredAgentCheckpoint | undefined;
      const onAgentReady = vi.fn(async () => {});
      const prepareAgentSession = vi.fn(async () => {
        runOpenClawAgentWriteTransaction(
          (database) =>
            writeSessionEntry(database, "agent:workspace-agent:main", {
              sessionId: "pending-configured-chat",
              updatedAt: Date.now(),
            }),
          { agentId: plan.agent.finalId, env: process.env },
        );
        return async () => {
          throw new Error("Retained chat must not be deleted");
        };
      });
      let policyConfig = config;
      const failed = await apply(plan, {
        getCurrentConfig: () => policyConfig,
        prepareEffect: async () => {
          policyConfig = config;
        },
        prepareAgentSession,
        onAgentConfigured: async (value) => {
          checkpoint = value;
          expect(value.planDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
          expect(value.sourceIntegrity).toMatch(/^sha256:[a-f0-9]{64}$/);
        },
        waitForAgentRuntime: async () => {
          throw new Error("runtime unavailable");
        },
        onAgentReady,
      });
      expect(failed).toMatchObject({
        status: "partial",
        agentRetained: true,
        configCommitted: true,
        error: { message: expect.stringContaining("runtime unavailable") },
      });
      assert(checkpoint);
      expect(onAgentReady).not.toHaveBeenCalled();
      if (change === "workspace") {
        await writeFile(path.join(plan.agent.workspace, "SOUL.md"), "User-edited instructions.");
      } else if (change === "config") {
        config = {
          ...config,
          agents: {
            entries: { ...config.agents.entries, [plan.agent.finalId]: { name: "Changed" } },
          },
        };
      } else if (change === "source") {
        await writeFile(path.join(stateDir, "source", "SOUL.md"), "Changed after consent.");
      } else if (change === "plan") {
        plan.actions[0]!.reason = "Changed plan despite unchanged claimed integrity";
      } else if (change === "source-root") {
        const oldRoot = plan.template.packageRoot;
        const newRoot = path.join(stateDir, "retry-source");
        await cp(oldRoot, newRoot, { recursive: true });
        plan.template.packageRoot = newRoot;
        plan.template.manifestPath = path.join(newRoot, "CLAW.md");
        for (const action of plan.actions) {
          if (action.source) {
            action.source = path.join(newRoot, path.relative(oldRoot, action.source));
          }
        }
        plan.planIntegrity = "newly-reviewed-integrity-at-new-source-root";
      }
      const writeWorkspace = vi.spyOn(workspaceFiles, "createTemplateWorkspaceFiles");
      const commit = vi.fn(commitConfig);
      const runtimeStarted = createDeferred();
      const runtimeReady = createDeferred();
      const waitForAgentRuntime = vi.fn(async () => {
        runtimeStarted.resolve();
        await runtimeReady.promise;
        return "applied" as const;
      });
      const retry = apply(plan, {
        consentPlanIntegrity: change === "consent" ? "changed" : plan.planIntegrity,
        getCurrentConfig: () => config,
        commitConfig: commit,
        prepareAgentSession,
        admittedAgent: {
          ...checkpoint,
          ...(change === "phase-only" ? { planDigest: undefined, sourceIntegrity: undefined } : {}),
          phase: "configured",
          assertCurrent: async () => {},
        },
        waitForAgentRuntime,
        onAgentReady,
      }).catch((error: unknown) => ({ error }));
      const succeeds = change === "unchanged" || change === "source-root";
      if (succeeds) {
        try {
          await awaitGateBeforeSettlement(
            runtimeStarted.promise,
            retry,
            "Configured retry settled before runtime readiness",
          );
          expect(onAgentReady).not.toHaveBeenCalled();
          expect(await workspaceIdentity(plan.agent.workspace)).toBe(checkpoint.workspaceIdentity);
        } finally {
          runtimeReady.resolve();
        }
      }
      const retried = await retry;
      expect(writeWorkspace).not.toHaveBeenCalled();
      expect(commit).not.toHaveBeenCalled();
      expect(prepareAgentSession).toHaveBeenCalledOnce();
      if (succeeds) {
        expect(retried).toMatchObject({ status: "complete", agentRetained: true });
        expect(waitForAgentRuntime).toHaveBeenCalledOnce();
        expect(onAgentReady).toHaveBeenCalledOnce();
      } else {
        expect(retried.error).toBeDefined();
        expect(waitForAgentRuntime).not.toHaveBeenCalled();
        expect(onAgentReady).not.toHaveBeenCalled();
      }
      expect(
        runOpenClawAgentWriteTransaction(
          (database) =>
            readSessionEntryRow(database, "agent:workspace-agent:main")?.entry.sessionId,
          { agentId: plan.agent.finalId, env: process.env },
        ),
      ).toBe("pending-configured-chat");
    },
  );

  it("keeps a failed configured checkpoint pending without starting runtime or greeting", async () => {
    const plan = await buildPlan();
    const waitForAgentRuntime = vi.fn(async () => "applied" as const);
    const onAgentReady = vi.fn(async () => {});
    const rollbackChat = vi.fn(async () => {});
    let checkpoint: TemplateConfiguredAgentCheckpoint | undefined;
    const result = await apply(plan, {
      prepareAgentSession: async () => rollbackChat,
      getCurrentConfig: () => config,
      onAgentConfigured: async (value) => {
        checkpoint = value;
        throw new Error("checkpoint acknowledgement lost");
      },
      waitForAgentRuntime,
      onAgentReady,
    });
    expect(result).toMatchObject({
      status: "partial",
      agentRetained: true,
      configCommitted: true,
      error: { message: expect.stringContaining("checkpoint acknowledgement lost") },
    });
    expect(rollbackChat).not.toHaveBeenCalled();
    expect(config.agents.entries).toHaveProperty(plan.agent.finalId);
    expect(await readFile(path.join(plan.agent.workspace, "SOUL.md"), "utf8")).toBe(
      "Workspace agent instructions.\n",
    );
    expect(waitForAgentRuntime).not.toHaveBeenCalled();
    expect(onAgentReady).not.toHaveBeenCalled();
    assert(checkpoint);
    const retry = await apply(plan, {
      getCurrentConfig: () => config,
      admittedAgent: {
        config: checkpoint.config,
        workspaceIdentity: await workspaceIdentity(plan.agent.workspace),
        phase: "admitted",
        assertCurrent: async () => {},
      },
      waitForAgentRuntime,
      onAgentReady,
    });
    expect(retry).toMatchObject({ status: "partial", agentRetained: true });
    expect(waitForAgentRuntime).not.toHaveBeenCalled();
    expect(onAgentReady).not.toHaveBeenCalled();
  });

  it("adds numbered ordinary agents without an install record", async () => {
    const onSetupEvent = vi.fn();
    const add = async () => apply(await buildPlan(), { onSetupEvent });

    const first = await add();
    const second = await add();

    expect(first.status).toBe("complete");
    expect(onSetupEvent).not.toHaveBeenCalled();
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
    "rolls back the new agent and reseeds bootstrap on retry after %s",
    async (failure) => {
      const bootstrap = "Run these first-time agent instructions.\n";
      writeFileSync(path.join(stateDir, "source", "BOOTSTRAP.md"), bootstrap);
      const reread = await readTemplateManifestFile(path.join(stateDir, "source", "CLAW.md"));
      assert(reread.ok);
      source = reread;
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

      const retryPlan = await buildPlan();
      expect(retryPlan.agent.workspace).toBe(plan.agent.workspace);
      const retried = await apply(retryPlan);
      expect(retried.status).toBe("complete");
      expect(await readFile(path.join(retryPlan.agent.workspace, "BOOTSTRAP.md"), "utf8")).toBe(
        bootstrap,
      );
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

  it("does not touch shared requirements when agent publication fails", async () => {
    const plan = await buildPlan();
    plan.actions.push({
      kind: "package",
      id: "notes",
      action: "install",
      target: "notes",
      details: { kind: "plugin" },
      blocked: false,
    });
    const packages = vi.spyOn(packageInstall, "installTemplatePackages");
    const mcp = vi.spyOn(mcpInstall, "installTemplateMcpServersStateless");
    const result = await apply(plan, {
      commitConfig: async () => {
        throw new Error("publish failed");
      },
      getCurrentConfig: () => ({ agents: { entries: {} } }),
    });
    expect(result).toMatchObject({
      status: "partial",
      error: { code: "add_failed", message: "publish failed" },
      packages: [],
      mcpServers: [],
    });
    expect(packages).not.toHaveBeenCalled();
    expect(mcp).not.toHaveBeenCalled();
    expect(existsSync(plan.agent.workspace)).toBe(false);
  });
});

const checklist = "# Checklist\nCheck active incidents.\n";
const baseConfig = (): OpenClawConfig => ({
  agents: { entries: { main: {} } },
  plugins: { enabled: false },
});
async function portableSource(
  fixture: OpenClawTestState,
  manifest: Partial<TemplateManifest> = {},
) {
  const packageRoot = fixture.statePath("package");
  await mkdir(packageRoot, { recursive: true });
  await writeFile(
    path.join(packageRoot, "CLAW.md"),
    `---\n${JSON.stringify({
      schemaVersion: 1,
      agent: { id: "portable", name: "Portable" },
      workspace: { bootstrapFiles: { "HEARTBEAT.md": { source: "HEARTBEAT.md" } } },
      ...manifest,
    })}\n---\n`,
  );
  await writeFile(
    path.join(packageRoot, "HEARTBEAT.md"),
    `${checklist}tasks:\n- name: Summary\n  interval: 15m\n  prompt: Prepare a summary.\n`,
  );
  const source = await readTemplateManifestFile(path.join(packageRoot, "CLAW.md"));
  assert(source.ok, JSON.stringify(source.diagnostics));
  return source;
}

it.each([false, true])(
  "preserves exactly declared routines with MCP environment ready=%s",
  async (ready) => {
    vi.stubEnv("TEMPLATE_ROUTINE_TEST_TOKEN", ready ? "synthetic-token" : undefined);
    await withOpenClawTestState({ label: "template-routine-readiness" }, async (fixture) => {
      const source = await portableSource(fixture, {
        mcpServers: {
          calendar: {
            command: "fixture-mcp",
            env: { TOKEN: "${TEMPLATE_ROUTINE_TEST_TOKEN}" },
          },
        },
        automations: [
          {
            id: "daily",
            schedule: { cron: "0 9 * * *", timezone: "UTC" },
            session: "isolated",
            message: "Prepare the daily brief.",
          },
        ],
      });
      let config = baseConfig();
      setRuntimeConfigSnapshot(config);
      const plan = await buildTemplateAddPlan({
        manifest: source.manifest,
        source: source.source,
        openClawProfile: { schemaVersion: 1, agent: { heartbeat: { every: "5m" } } },
        context: { config, workspace: fixture.statePath("added-workspace") },
      });
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
      const notices: unknown[] = [];
      try {
        const result = await applyTemplateAddPlanStateless(plan, {
          config,
          consentPlanIntegrity: plan.planIntegrity,
          getCurrentConfig: () => config,
          commitConfig: async (transform) => {
            config = transform(config);
            setRuntimeConfigSnapshot(config);
          },
          cronGateway: createTemplateCronAdapter(cron),
          onSetupEvent: async (event) => {
            notices.push(event);
            // Each result is published before the next scheduler write, not at the end.
            expect(await cron.list({ includeDisabled: true })).toHaveLength(notices.length);
          },
        });
        expect(result.status, result.error?.message).toBe("complete");
        expect(notices).toHaveLength(3);
        expect(notices).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              kind: "automation-created",
              agentId: plan.agent.finalId,
              name: "daily",
              enabled: ready,
              schedulerJobId: expect.any(String),
            }),
          ]),
        );
        expect(
          notices.every((event) => (event as { kind: string }).kind === "automation-created"),
        ).toBe(true);
        const jobs = await cron.list({ includeDisabled: true });
        expect(jobs).toHaveLength(3);
        expect(jobs.every((job) => job.enabled === ready)).toBe(true);
        expect(jobs.find((job) => job.name === "daily")).toMatchObject({
          schedule: { kind: "cron", expr: "0 9 * * *" },
          payload: { kind: "agentTurn", message: "Prepare the daily brief." },
        });
        expect(jobs.find((job) => job.name === "Summary")).toMatchObject({
          schedule: { kind: "every", everyMs: 900_000 },
          payload: { kind: "agentTurn", message: "Prepare a summary." },
        });
        const monitor = jobs.find((job) => job.name !== "daily" && job.name !== "Summary")!;
        expect((await cron.readScratch(monitor.id)).scratch?.content).toBe(checklist);
        expect(
          result.cronJobs.every((ref) =>
            cronInstall.templateCronGatewayJobMatchesRef(
              plan.agent.finalId,
              ref,
              jobs.find((job) => job.id === ref.schedulerJobId),
            ),
          ),
        ).toBe(true);
        if (!ready) {
          for (const job of jobs) {
            expect(await cron.run(job.id, "due")).toMatchObject({ ran: false });
          }
          expect(run).not.toHaveBeenCalled();
        }
      } finally {
        cron.stop();
        await cron.waitForIdle();
      }
    });
  },
);

it.each([
  { every: "5m", changed: "none" },
  { every: "0m", changed: "none" },
  { every: "5m", changed: "source" },
  { every: "5m", changed: "definition" },
  { every: "5m", changed: "scratch" },
  { every: "5m", changed: "rollback-definition" },
  { every: "5m", changed: "rollback-scratch" },
  { every: "5m", changed: "rollback-notice" },
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
          onSetupEvent: async (event) => {
            if (changed === "rollback-notice" && event.kind === "automation-failed") {
              throw new Error("Fixture notice publication failed");
            }
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
        if (changed === "rollback-notice") {
          expect(result).toMatchObject({
            status: "partial",
            error: { code: "cron_scratch_import_incomplete" },
          });
          expect(result.cronJobs).toHaveLength(1);
          expect(result.cronJobs[0]?.schedulerJobId).toBe(jobs[0]?.id);
          expect(jobs).toHaveLength(1);
          expect(config.agents?.entries).toHaveProperty("portable");
          return;
        }
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
