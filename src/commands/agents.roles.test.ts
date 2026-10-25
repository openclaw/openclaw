import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { createAgentTeam } from "../agents/agent-team.js";
import { ensureAgentWorkspace } from "../agents/workspace.js";
import { readConfigFileSnapshot } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { listDirectoryTreeStrict } from "../infra/directory-walk.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { defaultRuntime } from "../runtime.js";
import { publishAgentDeletionJournalStatus } from "../state/agent-deletion-journal-status.js";
import { withOpenClawStateDatabaseReadSnapshot } from "../state/openclaw-state-db-readonly.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { beginAgentDeletionJournal } from "../test-utils/agent-deletion-journal.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { agentsAddCommand } from "./agents.commands.add.js";
import { agentsTeamCreateCommand } from "./agents.commands.team.js";
import { ensureOnboardingAgent } from "./onboard-agent.js";

const specialists = ["researcher", "writer", "reviewer"];

let root: string, configPath: string;
it.aroundEach(async (runTest) => {
  await withOpenClawTestState(
    { layout: "state-only", label: "agent-roles", env: { OPENCLAW_WORKSPACE_DIR: undefined } },
    async (state) => {
      root = state.stateDir;
      configPath = state.configPath;
      state.envVars.OPENCLAW_HOME = root;
      state.applyEnv();
      try {
        await runTest();
      } finally {
        vi.restoreAllMocks();
      }
    },
  );
});

async function readConfig(): Promise<OpenClawConfig> {
  const snapshot = await readConfigFileSnapshot();
  expect(snapshot.valid).toBe(true);
  return snapshot.sourceConfig ?? snapshot.config;
}

function existingFleet(): OpenClawConfig {
  return {
    agents: {
      ownership: "explicit",
      defaults: { maxConcurrent: 3, subagents: { maxConcurrent: 2 } },
      entries: {
        ambient: { workspace: path.join(root, "ambient") },
        observer: { workspace: path.join(root, "observer") },
      },
    },
    tools: { agentToAgent: { enabled: false } },
  };
}

it.each([false, true])("rejects existing-roster onboarding (stale proposal: %s)", async (stale) => {
  const initial = { agents: { entries: { main: { name: "Existing owner" } } } };
  const original = JSON.stringify(initial);
  await fs.writeFile(configPath, original);
  const workspace = path.join(root, "team");
  await expect(
    ensureOnboardingAgent({
      config: stale ? {} : initial,
      workspace,
      firstAgent: { name: "coordinator", team: true },
    }),
  ).rejects.toThrow("The requested team was not created because an agent roster already exists");
  expect(await fs.readFile(configPath, "utf8")).toBe(original);
  await expect(fs.access(workspace)).rejects.toMatchObject({ code: "ENOENT" });
});

it("preserves implicit main workspace and routing when adding a team", async () => {
  const workspace = path.join(root, "existing-workspace");
  const initial = {
    agents: { defaults: { workspace } },
    bindings: [{ agentId: "main", match: { channel: "test-channel" } }],
  };
  await fs.mkdir(workspace);
  await fs.writeFile(path.join(workspace, "AGENTS.md"), "Existing operating program\n");
  await fs.writeFile(configPath, JSON.stringify(initial));
  const result = await createAgentTeam({ workspaceRoot: path.join(root, "team") });
  expect(result).toMatchObject({ status: "created", coordinatorId: "coordinator" });
  const config = await readConfig();
  const ids = Object.keys(config.agents?.entries ?? {});
  expect(ids).toEqual(["main", "coordinator", ...specialists]);
  expect(config.agents?.entries?.main?.workspace).toBe(workspace);
  expect(config.bindings).toEqual(initial.bindings);
  expect(await fs.readFile(path.join(workspace, "AGENTS.md"), "utf8")).toBe(
    "Existing operating program\n",
  );
});

it("allows a team to replace the implicit main", async () => {
  const result = await createAgentTeam({ coordinator: "main" });
  expect(result).toMatchObject({ status: "created", coordinatorId: "main" });
  expect(Object.keys((await readConfig()).agents?.entries ?? {})).toEqual(["main", ...specialists]);
});

it("rejects unfinished role adoption without workspace or config changes", async () => {
  const original = JSON.stringify(existingFleet());
  await fs.writeFile(configPath, original);
  const workspace = path.join(root, "editor");
  const seeded = await ensureAgentWorkspace({ dir: workspace, ensureBootstrapFiles: true });
  expect(seeded.bootstrapPending).toBe(true);
  // Git metadata is completion evidence; keep this fixture unambiguously unfinished.
  await fs.rm(path.join(workspace, ".git"), { recursive: true, force: true });
  await fs.rm(path.join(workspace, "SOUL.md"));
  await fs.rm(path.join(workspace, "IDENTITY.md"));
  const readWorkspace = async () =>
    Promise.all(
      (await listDirectoryTreeStrict(workspace))
        .filter(({ dirent }) => dirent.isFile())
        .map(async ({ dirent }) => {
          const file = path.join(dirent.parentPath, dirent.name);
          return [path.relative(workspace, file), await fs.readFile(file)];
        }),
    );
  const before = await readWorkspace();
  const adding = agentsAddCommand({
    name: "Editor",
    role: "writer",
    workspace,
    nonInteractive: true,
    json: true,
  });
  await expect.soft(adding).rejects.toThrow("unfinished bootstrap");
  expect.soft(await readWorkspace()).toEqual(before);
  expect.soft(await fs.readFile(configPath, "utf8")).toBe(original);
  expect((await readConfig()).agents?.entries?.editor).toBeUndefined();
});

it.each([false, true])(
  "creates directed teams preserving the existing ambient owner: %s",
  async (hasAmbientOwner) => {
    const initial = existingFleet();
    if (hasAmbientOwner && initial.agents?.defaults) {
      initial.agents.defaults.systemAgent = { agentId: " ambient " };
    }
    await fs.writeFile(configPath, JSON.stringify(initial));
    const before = await readConfig();
    const coordinatorId = hasAmbientOwner ? "docs-lead" : "coordinator";
    const specialistIds = specialists.map((id) => (hasAmbientOwner ? `docs-${id}` : id));
    const workspaceRoot = path.join(root, hasAmbientOwner ? "team-workspaces" : "workspace");
    const json = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
    await agentsTeamCreateCommand({
      ...(hasAmbientOwner ? { coordinator: "lead", prefix: "docs", workspaceRoot } : {}),
      nonInteractive: true,
      json: true,
    });
    const summary: unknown = json.mock.calls[0]?.[0];
    expect(summary).toMatchObject({
      coordinatorId,
      ambientOwnerId: hasAmbientOwner ? "ambient" : coordinatorId,
      agents: [coordinatorId, ...specialistIds].map((agentId) => ({
        agentId,
        workspace: path.join(workspaceRoot, agentId),
      })),
      ...(hasAmbientOwner
        ? { note: "ambient owner stays ambient; talk to the coordinator by name" }
        : {}),
    });
    const config = await readConfig();
    expect(config.agents?.defaults).toEqual({
      ...before.agents?.defaults,
      systemAgent: hasAmbientOwner
        ? before.agents?.defaults?.systemAgent
        : { agentId: coordinatorId },
    });
    expect(config.tools).toEqual(before.tools);
    expect(config.agents?.entries?.ambient).toEqual(before.agents?.entries?.ambient);
    for (const id of [coordinatorId, ...specialistIds]) {
      const entry = config.agents?.entries?.[id];
      expect(entry?.subagents).toEqual(
        id === coordinatorId
          ? { allowAgents: specialistIds, delegationMode: "prefer" }
          : { allowAgents: [] },
      );
      expect(entry?.workspace).toBe(path.join(workspaceRoot, id));
      expect(entry).not.toHaveProperty("default");
    }
  },
);

it("rejects pending specialist deletion before publishing config or workspace", async () => {
  const original = JSON.stringify(existingFleet());
  await fs.writeFile(configPath, original);
  const workspaceRoot = path.join(root, "team-workspaces");
  beginAgentDeletionJournal({
    agentId: "reviewer",
    operationId: "pending-reviewer",
    agentDir: path.join(root, "agents", "reviewer", "agent"),
    workspaceDir: path.join(workspaceRoot, "reviewer"),
    sessionsDir: path.join(root, "agents", "reviewer", "sessions"),
    deleteFiles: false,
  });
  const foreign = openNodeSqliteDatabase(resolveOpenClawStateSqlitePath());
  let result: Awaited<ReturnType<typeof createAgentTeam>>;
  try {
    foreign.exec(
      "UPDATE agent_deletion_journal SET cleanup_completed = 1 WHERE agent_id = 'reviewer'",
    );
    publishAgentDeletionJournalStatus(foreign, "reviewer", "complete");
    result = await withOpenClawStateDatabaseReadSnapshot(async () => {
      foreign.exec(
        "UPDATE agent_deletion_journal SET cleanup_completed = 0 WHERE agent_id = 'reviewer'",
      );
      publishAgentDeletionJournalStatus(foreign, "reviewer", "pending");
      const observation = observeHostDataSql();
      try {
        const created = await createAgentTeam({ workspaceRoot });
        expect(
          observation.queries.filter((sql) => /\bagent_deletion_journal\b/i.test(sql)),
        ).toEqual([]);
        return created;
      } finally {
        observation.restore();
      }
    });
  } finally {
    foreign.close();
  }
  expect(result).toMatchObject({
    status: "error",
    message: expect.stringContaining("reviewer"),
  });
  expect(await fs.readFile(configPath, "utf8")).toBe(original);
  await expect(fs.access(workspaceRoot)).rejects.toMatchObject({ code: "ENOENT" });
});
