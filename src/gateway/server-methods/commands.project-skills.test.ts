import fs from "node:fs/promises";
import path from "node:path";
import { expect, test, vi } from "vitest";
import type { CommandsListResult } from "../../../packages/gateway-protocol/src/index.js";
import { registerAgentWorkspaceAccess } from "../../agents/workspace-access.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { registerProjectRegistry } from "../../projects/project-registry.js";
import { readWorkspaceSkillSources } from "../../skills/loading/workspace-skill-source-reader.js";
import { resolveWorkspaceSkillSourcePlan } from "../../skills/loading/workspace-skill-sources.js";
import { writeSkill } from "../../skills/test-support/e2e-test-helpers.js";
import { withEnvAsync } from "../../test-utils/env.js";
import * as commandsListResult from "./commands-list-result.js";
import { buildCommandsListResult } from "./commands-list-result.js";
import { commandsHandlers } from "./commands.js";
import { initializeRepository, withProjectState } from "./projects.test-support.js";

const CREATOR_SCOPES = ["operator.admin"];
const FIXTURE_SKILLS = new Set([
  "agent_fixture",
  "shared_fixture",
  "project_fixture",
  "project_agents_fixture",
  "unlisted_project_fixture",
]);

function putSkill(root: string, name: string, description = name) {
  return writeSkill({ dir: path.join(root, name), name, description });
}

async function listCommands(
  cfg: OpenClawConfig,
  params: Record<string, unknown>,
  scopes = CREATOR_SCOPES,
  getRuntimeConfig: () => OpenClawConfig = () => cfg,
) {
  let result: { ok: boolean; payload?: unknown; error?: { code?: string } } | undefined;
  await commandsHandlers["commands.list"]!({
    req: {} as never,
    params: { agentId: "main", scope: "text", ...params },
    respond: (ok, payload, error) => {
      result = { ok, payload, error };
    },
    context: { getRuntimeConfig } as never,
    client: { connect: { scopes } } as never,
    isWebchatConnect: () => false,
  });
  return result!;
}

function fixtureSkills(result: { ok: boolean; payload?: unknown; error?: unknown }) {
  expect(result.error).toBeUndefined();
  return (result.payload as CommandsListResult).commands
    .filter((command) => FIXTURE_SKILLS.has(command.name))
    .map((command) => ({ name: command.name, description: command.description }));
}

test("New session command discovery previews admitted project skills under runtime rules", async () => {
  await withProjectState(async (state) => {
    const workspace = await initializeRepository(state.root, "workspace");
    const project = await initializeRepository(state.root, "project");
    await putSkill(path.join(workspace, "skills"), "agent-fixture");
    await putSkill(path.join(workspace, "skills"), "shared-fixture", "Agent copy");
    await putSkill(path.join(project, "skills"), "shared-fixture", "Project copy");
    await putSkill(path.join(project, "skills"), "project-fixture");
    await putSkill(path.join(project, ".agents", "skills"), "project-agents-fixture");
    await putSkill(path.join(project, "skills"), "unlisted-project-fixture");
    const registered = await registerProjectRegistry({ path: project });
    const bundled = path.join(state.root, "bundled");
    await fs.mkdir(bundled);
    const config = (mode: "off" | "all"): OpenClawConfig => ({
      plugins: { enabled: false },
      skills: { allowBundled: [] },
      agents: {
        entries: {
          main: {
            workspace,
            sandbox: { mode },
            skills: [
              "agent-fixture",
              "shared-fixture",
              "project-fixture",
              "project-agents-fixture",
            ],
          },
        },
      },
    });
    const cfg = config("off");
    const agentOnly = [
      { name: "agent_fixture", description: "agent-fixture" },
      { name: "shared_fixture", description: "Agent copy" },
    ];
    await withEnvAsync({ OPENCLAW_BUNDLED_SKILLS_DIR: bundled }, async () => {
      // No project keeps the existing agent-workspace catalog.
      expect(fixtureSkills(await listCommands(cfg, {}))).toEqual(agentOnly);
      // Both project roots join; the agent workspace keeps precedence and the allowlist holds.
      expect(fixtureSkills(await listCommands(cfg, { projectId: registered.id }))).toEqual([
        { name: "agent_fixture", description: "agent-fixture" },
        { name: "project_agents_fixture", description: "project-agents-fixture" },
        { name: "project_fixture", description: "project-fixture" },
        { name: "shared_fixture", description: "Agent copy" },
      ]);
      // Clients that could not create this session never read the project's skills.
      expect(
        fixtureSkills(await listCommands(cfg, { projectId: registered.id }, ["operator.read"])),
      ).toEqual(agentOnly);
      // Sandboxed agents cannot admit a project outside their workspace, so neither can discovery.
      expect(
        fixtureSkills(await listCommands(config("all"), { projectId: registered.id })),
      ).toEqual(agentOnly);
      expect(fixtureSkills(await listCommands(cfg, { projectId: "missing-project" }))).toEqual(
        agentOnly,
      );
      // Admission repeats before disclosure: a sandbox tightened during discovery withholds it.
      let current = cfg;
      const build = commandsListResult.buildCommandsListResult;
      using _ = vi
        .spyOn(commandsListResult, "buildCommandsListResult")
        .mockImplementation(async (input) => {
          const result = await build(input);
          current = config("all");
          return result;
        });
      expect(
        await listCommands(cfg, { projectId: registered.id }, CREATOR_SCOPES, () => current),
      ).toMatchObject({ ok: false, payload: undefined, error: { code: "UNAVAILABLE" } });
      // An existing session owns its project; a client cannot redirect its catalog.
      expect(
        await listCommands(cfg, { projectId: registered.id, sessionKey: "agent:main:main" }),
      ).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
    });
  });
});

test("project previews keep the registry's file host and match the created session's catalog", async () => {
  await withProjectState(async (state) => {
    // Gateway-local agent workspace path holds a stale local-only skill; the paired
    // node serves the real workspace with a node-only skill.
    const workspace = await initializeRepository(state.root, "workspace");
    const remote = path.join(state.root, "node-workspace");
    const project = await initializeRepository(state.root, "registered");
    await putSkill(path.join(workspace, "skills"), "local-only");
    await putSkill(path.join(remote, "skills"), "node-only");
    await putSkill(path.join(project, "skills"), "registered-skill");
    const registered = await registerProjectRegistry({ path: project });
    const bundled = path.join(state.root, "bundled");
    await fs.mkdir(bundled);
    const nodeExecutionRoots: Array<string | undefined> = [];
    using _ = {
      [Symbol.dispose]: registerAgentWorkspaceAccess(workspace, {
        bridge: {
          readFile: async () => Buffer.alloc(0),
          writeFile: async () => {},
          stat: async () => null,
        } as never,
        loadSkills: async (request) => {
          nodeExecutionRoots.push(request.executionWorkspaceDir);
          return readWorkspaceSkillSources({
            ...request,
            executionWorkspaceDir: undefined,
            sourcePlan: resolveWorkspaceSkillSourcePlan(remote, { workspaceOnly: true }),
          });
        },
      }),
    };
    const cfg: OpenClawConfig = {
      plugins: { enabled: false },
      skills: { allowBundled: [] },
      agents: { entries: { main: { workspace, sandbox: { mode: "off" } } } },
    };
    const names = (result: CommandsListResult) =>
      result.commands
        .filter((command) => command.source === "skill")
        .map((command) => command.name)
        .toSorted();
    const created = async (entry: { projectId: string; spawnedCwd: string }) =>
      names(
        await buildCommandsListResult({
          cfg,
          agentId: "main",
          scope: "text",
          sessionKey: "agent:main:created",
          sessionEntry: { sessionId: "created", updatedAt: 0, ...entry },
        }),
      );
    await withEnvAsync({ OPENCLAW_BUNDLED_SKILLS_DIR: bundled }, async () => {
      // The workspace pseudo-project is the node workspace: never the stale Gateway copy.
      const workspacePreview = await listCommands(cfg, { projectId: "workspace:main" });
      expect(workspacePreview.error).toBeUndefined();
      expect(names(workspacePreview.payload as CommandsListResult)).toEqual(["node_only"]);
      expect(await created({ projectId: "workspace:main", spawnedCwd: workspace })).toEqual([
        "node_only",
      ]);
      // A registered checkout is Gateway-owned in preview and after creation; the node
      // is never asked for its path.
      nodeExecutionRoots.length = 0;
      const registeredPreview = await listCommands(cfg, { projectId: registered.id });
      expect(names(registeredPreview.payload as CommandsListResult)).toEqual([
        "node_only",
        "registered_skill",
      ]);
      expect(await created({ projectId: registered.id, spawnedCwd: project })).toEqual([
        "node_only",
        "registered_skill",
      ]);
      expect(nodeExecutionRoots.filter((root) => root === project)).toEqual([]);
    });
  });
});
