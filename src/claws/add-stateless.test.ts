import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { isAgentDeletionBlocked } from "../agents/agent-lifecycle-registry.js";
import * as mcpMutation from "../agents/mcp-config-mutation.js";
import * as mcpConfig from "../config/mcp-config.js";
import { writeSessionEntry } from "../config/sessions/session-accessor.sqlite-entry-store.js";
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
import { applyClawAddPlanStateless, type StatelessClawAddOptions } from "./add-stateless.js";
import * as cronInstall from "./cron.js";
import { buildGatewayClawAddPlan } from "./gateway-add-plan.js";
import { CLAW_MCP_REF_SCHEMA_VERSION, type PersistedClawMcpServerRef } from "./mcp-records.js";
import * as mcpInstall from "./mcp.js";
import * as packageInstall from "./packages.js";
import type { PersistedClawPackageRef } from "./provenance.js";
import { readClawManifestFile } from "./reader.js";
import type { ClawReadResult } from "./types.js";
import * as workspaceFiles from "./workspace.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.unstubAllEnvs());
afterEach(() => vi.restoreAllMocks());
afterEach(() => closeOpenClawAgentDatabasesForTest());

describe("stateless Claw Add", () => {
  let stateDir: string;
  let source: Extract<ClawReadResult, { ok: true }>;
  let config = { agents: { entries: {} } };
  beforeEach(async () => {
    stateDir = tempDirs.make("openclaw-claws-stateless-");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const result = await readClawManifestFile(
      path.resolve("src/claws/fixtures/workspace-agent.claw.json"),
    );
    if (!result.ok) {
      throw new Error(JSON.stringify(result.diagnostics));
    }
    source = result;
    config = { agents: { entries: {} } };
  });
  const buildPlan = () => buildGatewayClawAddPlan(source, { config, sourceMcpServers: {} });
  const commitConfig: NonNullable<StatelessClawAddOptions["commitConfig"]> = async (transform) => {
    config = transform(config) as typeof config;
  };
  const apply = (
    plan: Awaited<ReturnType<typeof buildPlan>>,
    options: StatelessClawAddOptions = {},
  ) =>
    applyClawAddPlanStateless(plan, {
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
        vi.spyOn(workspaceFiles, "createClawWorkspaceFiles").mockRejectedValueOnce(
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
      if (failure === "lost config acknowledgement") {
        expect(writes).toBe(2);
      }
    },
  );

  it("keeps an exposed workspace if its files changed before rollback", async () => {
    const plan = await buildPlan();
    vi.spyOn(cronInstall, "installClawCronJobsStateless").mockImplementationOnce(async () => {
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

  it("cleans newly added shared requirements after a pre-publish failure", async () => {
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
    const packageRef = (origin: PersistedClawPackageRef["origin"]) =>
      ({ kind: "plugin", origin, status: "complete" }) as PersistedClawPackageRef;
    const introducedPackage = packageRef("claw-introduced");
    const reusedPackage = packageRef("pre-existing");
    const mcpRef = (name: string, origin: PersistedClawMcpServerRef["origin"]) =>
      ({ name, origin, status: "complete" }) as PersistedClawMcpServerRef;
    const introducedMcp = mcpRef("new-server", "claw-introduced");
    const reusedMcp = mcpRef("existing-server", "pre-existing");
    const rollbackPackages = vi
      .spyOn(packageInstall, "rollbackStatelessClawPackages")
      .mockImplementation(async (refs) => {
        refs[0]!.status = "rolled_back";
        return [];
      });
    const rollbackMcpServers = vi
      .spyOn(mcpInstall, "rollbackStatelessClawMcpServers")
      .mockImplementation(async (refs) => {
        refs.splice(refs.indexOf(introducedMcp), 1);
        return [];
      });
    vi.spyOn(packageInstall, "installClawPackages").mockResolvedValueOnce([
      introducedPackage,
      reusedPackage,
    ]);
    vi.spyOn(mcpInstall, "installClawMcpServersStateless").mockResolvedValueOnce([
      introducedMcp,
      reusedMcp,
    ]);

    const result = await apply(plan, {
      commitConfig: async () => {
        throw new Error("publish failed");
      },
      getCurrentConfig: () => ({ agents: { entries: {} } }),
    });

    expect(result.error).toMatchObject({ code: "add_failed", message: "publish failed" });
    expect(rollbackPackages).toHaveBeenCalledWith(
      [introducedPackage, reusedPackage],
      expect.anything(),
    );
    expect(rollbackMcpServers).toHaveBeenCalledWith([reusedMcp], expect.anything());
    expect(result.packages.map((ref) => ref.status)).toEqual(["rolled_back", "complete"]);
    expect(result.mcpServers).toEqual([reusedMcp]);
    expect(existsSync(plan.agent.workspace)).toBe(false);
  });
});

describe("stateless MCP cleanup", () => {
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
    origin: PersistedClawMcpServerRef["origin"],
  ): PersistedClawMcpServerRef => ({
    schemaVersion: CLAW_MCP_REF_SCHEMA_VERSION,
    agentId: "new-agent",
    name,
    configDigest: mcpInstall.digestClawMcpServer(configured),
    relationship: origin === "claw-introduced" ? "managed" : "referenced",
    origin,
    independentOwner: true,
    status: "complete",
    createdAtMs: 1,
    updatedAtMs: 1,
  });

  it.each([false, true])(
    "preserves other owners when the introduced server changed: %s",
    async (changed) => {
      vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("openclaw-claws-mcp-rollback-"));
      const introduced = mcpRef("new-server", "claw-introduced");
      const reused = mcpRef("existing-server", "pre-existing");
      const refs = changed ? [introduced] : [introduced, reused];
      const unsetMcpServer = vi.spyOn(mcpMutation, "unsetConfiguredMcpServer");
      if (!changed) {
        unsetMcpServer.mockResolvedValue({ ...configSnapshot, ok: true, removed: true });
      }
      vi.spyOn(mcpConfig, "listConfiguredMcpServers").mockResolvedValue({
        ...configSnapshot,
        ok: true,
        mcpServers: { "new-server": changed ? { command: "different-command" } : configured },
      });
      expect(await mcpInstall.rollbackStatelessClawMcpServers(refs)).toEqual([]);
      if (changed) {
        expect(unsetMcpServer).not.toHaveBeenCalled();
      } else {
        expect(unsetMcpServer).toHaveBeenCalledWith(
          expect.objectContaining({ name: "new-server", expectedServer: configured }),
        );
      }
      expect(refs).toEqual([changed ? introduced : reused]);
    },
  );
});
