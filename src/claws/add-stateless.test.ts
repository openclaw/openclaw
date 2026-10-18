import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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
import { applyClawAddPlanStateless } from "./add-stateless.js";
import * as cronInstall from "./cron.js";
import { buildGatewayClawAddPlan } from "./gateway-add-plan.js";
import { CLAW_MCP_REF_SCHEMA_VERSION, type PersistedClawMcpServerRef } from "./mcp-records.js";
import * as mcpInstall from "./mcp.js";
import * as packageInstall from "./packages.js";
import type { PersistedClawPackageRef } from "./provenance.js";
import { readClawManifestFile } from "./reader.js";
import * as workspaceFiles from "./workspace.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.unstubAllEnvs());
afterEach(() => vi.restoreAllMocks());
afterEach(() => closeOpenClawAgentDatabasesForTest());

describe("stateless Claw Add", () => {
  it("reuses a deleted agent ID without leaving its database fenced", async () => {
    const stateDir = tempDirs.make("openclaw-claws-stateless-readd-");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const source = await readClawManifestFile(
      path.resolve("src/claws/fixtures/workspace-agent.claw.json"),
    );
    expect(source.ok).toBe(true);
    if (!source.ok) {
      return;
    }
    const agentId = source.manifest.agent.id;
    const deletion = beginAgentDeletionJournal({
      operationId: "prior-deletion",
      deleteFiles: false,
      agentId,
      agentDir: path.join(stateDir, "agents", agentId, "agent"),
      workspaceDir: path.join(stateDir, `workspace-${agentId}`),
      sessionsDir: path.join(stateDir, "agents", agentId, "sessions"),
    });
    runOpenClawStateWriteTransaction((database) =>
      completeAgentDeletionJournalInDatabase(database, deletion.agentId, deletion.operationId),
    );
    expect(isAgentDeletionBlocked(agentId)).toBe(true);
    expect(() =>
      runOpenClawAgentWriteTransaction(() => undefined, { agentId, env: process.env }),
    ).toThrow(`agent ${agentId} is deleted`);

    let config = { agents: { entries: {} } };
    const plan = await buildGatewayClawAddPlan(source, { config, sourceMcpServers: {} });
    const result = await applyClawAddPlanStateless(plan, {
      consentPlanIntegrity: plan.planIntegrity,
      commitConfig: async (transform) => {
        config = transform(config) as typeof config;
      },
    });

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
    const stateDir = tempDirs.make("openclaw-claws-stateless-deletion-pending-");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const source = await readClawManifestFile(
      path.resolve("src/claws/fixtures/workspace-agent.claw.json"),
    );
    expect(source.ok).toBe(true);
    if (!source.ok) {
      return;
    }
    const agentId = source.manifest.agent.id;
    beginAgentDeletionJournal({
      operationId: "pending-deletion",
      deleteFiles: false,
      agentId,
      agentDir: path.join(stateDir, "agents", agentId, "agent"),
      workspaceDir: path.join(stateDir, `workspace-${agentId}`),
      sessionsDir: path.join(stateDir, "agents", agentId, "sessions"),
    });

    let config = { agents: { entries: {} } };
    const plan = await buildGatewayClawAddPlan(source, { config, sourceMcpServers: {} });
    const result = await applyClawAddPlanStateless(plan, {
      consentPlanIntegrity: plan.planIntegrity,
      commitConfig: async (transform) => {
        config = transform(config) as typeof config;
      },
    });

    expect(result).toMatchObject({
      status: "partial",
      error: { code: "agent_deletion_pending" },
      configCommitted: false,
    });
    expect(config.agents.entries).not.toHaveProperty(agentId);
    expect(readAgentDeletionJournal(agentId, {}, "runtime")?.cleanupCompleted).toBe(false);
  });

  it("adds numbered ordinary agents without an install record", async () => {
    const stateDir = tempDirs.make("openclaw-claws-stateless-add-");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const source = await readClawManifestFile(
      path.resolve("src/claws/fixtures/workspace-agent.claw.json"),
    );
    expect(source.ok).toBe(true);
    if (!source.ok) {
      return;
    }
    let config = { agents: { entries: {} } };
    const add = async () => {
      const plan = await buildGatewayClawAddPlan(source, { config, sourceMcpServers: {} });
      const result = await applyClawAddPlanStateless(plan, {
        consentPlanIntegrity: plan.planIntegrity,
        commitConfig: async (transform) => {
          config = transform(config) as typeof config;
        },
      });
      return { plan, result };
    };

    const first = await add();
    const second = await add();

    expect(first.result.status).toBe("complete");
    expect(second.result.status).toBe("complete");
    expect(first.result).not.toHaveProperty("installRecord");
    expect(second.result.agent.finalId).toBe("workspace-agent-2");
    expect(second.result.agent.config.name).toBe("Workspace Agent 2");
    expect(Object.keys(config.agents.entries)).toEqual([
      "main",
      "workspace-agent",
      "workspace-agent-2",
    ]);
    expect(existsSync(path.join(stateDir, "workspace-workspace-agent-2", "SOUL.md"))).toBe(true);
  });

  it("removes the new agent and workspace when a later stage fails", async () => {
    const stateDir = tempDirs.make("openclaw-claws-stateless-rollback-");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const source = await readClawManifestFile(
      path.resolve("src/claws/fixtures/workspace-agent.claw.json"),
    );
    expect(source.ok).toBe(true);
    if (!source.ok) {
      return;
    }
    let config = { agents: { entries: {} } };
    const plan = await buildGatewayClawAddPlan(source, { config, sourceMcpServers: {} });

    vi.spyOn(workspaceFiles, "createClawWorkspaceFiles").mockRejectedValueOnce(
      new Error("test file failure"),
    );
    const result = await applyClawAddPlanStateless(plan, {
      consentPlanIntegrity: plan.planIntegrity,
      commitConfig: async (transform) => {
        config = transform(config) as typeof config;
      },
    });

    expect(result).toMatchObject({
      status: "partial",
      configCommitted: false,
      workspaceCreated: false,
      error: { code: "add_failed", message: "test file failure" },
    });
    expect(Object.keys(config.agents.entries)).toEqual([]);
    expect(existsSync(plan.agent.workspace)).toBe(false);
  });

  it("reconciles a config write that committed before reporting an error", async () => {
    const stateDir = tempDirs.make("openclaw-claws-uncertain-commit-");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const source = await readClawManifestFile(
      path.resolve("src/claws/fixtures/workspace-agent.claw.json"),
    );
    expect(source.ok).toBe(true);
    if (!source.ok) {
      return;
    }
    let config = { agents: { entries: {} } };
    const plan = await buildGatewayClawAddPlan(source, { config, sourceMcpServers: {} });
    let writes = 0;

    const result = await applyClawAddPlanStateless(plan, {
      consentPlanIntegrity: plan.planIntegrity,
      getCurrentConfig: () => config,
      commitConfig: async (transform) => {
        config = transform(config) as typeof config;
        writes += 1;
        if (writes === 1) {
          throw new Error("write acknowledgment lost");
        }
      },
    });

    expect(result).toMatchObject({
      status: "partial",
      configCommitted: false,
      workspaceCreated: false,
      error: { code: "add_failed", message: "write acknowledgment lost" },
    });
    expect(writes).toBe(2);
    expect(Object.keys(config.agents.entries)).toEqual(["main"]);
    expect(existsSync(plan.agent.workspace)).toBe(false);
  });

  it("keeps an exposed workspace if its files changed before rollback", async () => {
    const stateDir = tempDirs.make("openclaw-claws-workspace-changed-");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const source = await readClawManifestFile(
      path.resolve("src/claws/fixtures/workspace-agent.claw.json"),
    );
    expect(source.ok).toBe(true);
    if (!source.ok) {
      return;
    }
    let config = { agents: { entries: {} } };
    const plan = await buildGatewayClawAddPlan(source, { config, sourceMcpServers: {} });
    vi.spyOn(cronInstall, "installClawCronJobsStateless").mockImplementationOnce(async () => {
      writeFileSync(path.join(plan.agent.workspace, "USER.md"), "new user content");
      throw new Error("scheduler unavailable");
    });
    const result = await applyClawAddPlanStateless(plan, {
      consentPlanIntegrity: plan.planIntegrity,
      commitConfig: async (transform) => {
        config = transform(config) as typeof config;
      },
    });

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
    const stateDir = tempDirs.make("openclaw-claws-shared-rollback-");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const source = await readClawManifestFile(
      path.resolve("src/claws/fixtures/workspace-agent.claw.json"),
    );
    expect(source.ok).toBe(true);
    if (!source.ok) {
      return;
    }
    const plan = await buildGatewayClawAddPlan(source, {
      config: { agents: { entries: {} } },
      sourceMcpServers: {},
    });
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
    const introducedPackage = {
      kind: "plugin",
      origin: "claw-introduced",
      status: "complete",
    } as PersistedClawPackageRef;
    const reusedPackage = {
      kind: "plugin",
      origin: "pre-existing",
      status: "complete",
    } as PersistedClawPackageRef;
    const introducedMcp = {
      name: "new-server",
      origin: "claw-introduced",
      status: "complete",
    } as PersistedClawMcpServerRef;
    const reusedMcp = {
      name: "existing-server",
      origin: "pre-existing",
      status: "complete",
    } as PersistedClawMcpServerRef;
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

    const result = await applyClawAddPlanStateless(plan, {
      consentPlanIntegrity: plan.planIntegrity,
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

  it("removes only an unchanged MCP server introduced by this Add", async () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("openclaw-claws-mcp-rollback-"));
    const introduced = mcpRef("new-server", "claw-introduced");
    const reused = mcpRef("existing-server", "pre-existing");
    const refs = [introduced, reused];
    const unsetMcpServer = vi
      .spyOn(mcpMutation, "unsetConfiguredMcpServer")
      .mockResolvedValue({ ...configSnapshot, ok: true, removed: true });
    vi.spyOn(mcpConfig, "listConfiguredMcpServers").mockResolvedValue({
      ...configSnapshot,
      ok: true,
      mcpServers: { "new-server": configured },
    });

    expect(await mcpInstall.rollbackStatelessClawMcpServers(refs)).toEqual([]);
    expect(unsetMcpServer).toHaveBeenCalledWith(
      expect.objectContaining({ name: "new-server", expectedServer: configured }),
    );
    expect(refs).toEqual([reused]);
  });

  it("preserves an MCP server changed after this Add configured it", async () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("openclaw-claws-mcp-changed-"));
    const introduced = mcpRef("new-server", "claw-introduced");
    const refs = [introduced];
    const unsetMcpServer = vi.spyOn(mcpMutation, "unsetConfiguredMcpServer");
    vi.spyOn(mcpConfig, "listConfiguredMcpServers").mockResolvedValue({
      ...configSnapshot,
      ok: true,
      mcpServers: { "new-server": { command: "different-command" } },
    });

    expect(await mcpInstall.rollbackStatelessClawMcpServers(refs)).toEqual([]);
    expect(unsetMcpServer).not.toHaveBeenCalled();
    expect(refs).toEqual([introduced]);
  });
});
