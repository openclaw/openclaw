import fs from "node:fs/promises";
import path from "node:path";
import { expect, test, vi } from "vitest";
import type { CommandsListResult } from "../../../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { registerProjectRegistry } from "../../projects/project-registry.js";
import { writeSkill } from "../../skills/test-support/e2e-test-helpers.js";
import { registerNodeSkillWorkspace } from "../../skills/test-support/node-skill-workspace.js";
import { withEnvAsync } from "../../test-utils/env.js";
import * as commandsListResult from "./commands-list-result.js";
import { commandsHandlers } from "./commands.js";
import { initializeRepository, withProjectState } from "./projects.test-support.js";

const CREATOR_SCOPES = ["operator.admin"];

function putSkill(root: string, name: string, description = name) {
  return writeSkill({ dir: path.join(root, name), name, description });
}

function agentConfig(workspace: string, main: Record<string, unknown> = {}): OpenClawConfig {
  return {
    plugins: { enabled: false },
    skills: { allowBundled: [] },
    agents: { entries: { main: { workspace, sandbox: { mode: "off" }, ...main } } },
  };
}

/** Isolated project state with an empty bundled skills root. */
function withSkillState(run: (root: string) => Promise<void>) {
  return withProjectState(async (state) => {
    const bundled = path.join(state.root, "bundled");
    await fs.mkdir(bundled);
    await withEnvAsync({ OPENCLAW_BUNDLED_SKILLS_DIR: bundled }, () => run(state.root));
  });
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

function skillCommands(result: { ok: boolean; payload?: unknown; error?: unknown }) {
  expect(result.error).toBeUndefined();
  return (result.payload as CommandsListResult).commands
    .filter((command) => command.source === "skill")
    .map((command) => ({ name: command.name, description: command.description }));
}

test("New session command discovery previews admitted project skills under runtime rules", async () => {
  await withSkillState(async (root) => {
    const workspace = await initializeRepository(root, "workspace");
    const project = await initializeRepository(root, "project");
    await putSkill(path.join(workspace, "skills"), "agent-fixture");
    await putSkill(path.join(workspace, "skills"), "shared-fixture", "Agent copy");
    await putSkill(path.join(project, "skills"), "shared-fixture", "Project copy");
    await putSkill(path.join(project, "skills"), "project-fixture");
    await putSkill(path.join(project, ".agents", "skills"), "project-agents-fixture");
    await putSkill(path.join(project, "skills"), "unlisted-project-fixture");
    const registered = await registerProjectRegistry({ path: project });
    const allowed = [
      "agent-fixture",
      "shared-fixture",
      "project-fixture",
      "project-agents-fixture",
    ];
    const config = (mode: "off" | "all") =>
      agentConfig(workspace, { sandbox: { mode }, skills: allowed });
    const cfg = config("off");
    const agentOnly = [
      { name: "agent_fixture", description: "agent-fixture" },
      { name: "shared_fixture", description: "Agent copy" },
    ];
    // No project keeps the existing agent-workspace catalog.
    expect(skillCommands(await listCommands(cfg, {}))).toEqual(agentOnly);
    // Both project roots join; the agent workspace keeps precedence and the allowlist holds.
    expect(skillCommands(await listCommands(cfg, { projectId: registered.id }))).toEqual([
      { name: "agent_fixture", description: "agent-fixture" },
      { name: "project_agents_fixture", description: "project-agents-fixture" },
      { name: "project_fixture", description: "project-fixture" },
      { name: "shared_fixture", description: "Agent copy" },
    ]);
    // Clients that could not create this session never read the project's skills.
    expect(
      skillCommands(await listCommands(cfg, { projectId: registered.id }, ["operator.read"])),
    ).toEqual(agentOnly);
    // Sandboxed agents cannot admit a project outside their workspace, so neither can discovery.
    expect(skillCommands(await listCommands(config("all"), { projectId: registered.id }))).toEqual(
      agentOnly,
    );
    expect(skillCommands(await listCommands(cfg, { projectId: "missing-project" }))).toEqual(
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

// The created session's catalog takes the same host routing from its session entry; the
// discovery owner proves that half in chat-commands.discovery.test.ts.
test("project previews keep the registry's file host", async () => {
  await withSkillState(async (root) => {
    // Gateway-local agent workspace path holds a stale local-only skill; the paired
    // node serves the real workspace with a node-only skill.
    const workspace = await initializeRepository(root, "workspace");
    const remote = path.join(root, "node-workspace");
    const project = await initializeRepository(root, "registered");
    await putSkill(path.join(workspace, "skills"), "local-only");
    await putSkill(path.join(remote, "skills"), "node-only");
    await putSkill(path.join(project, "skills"), "registered-skill");
    const registered = await registerProjectRegistry({ path: project });
    using node = registerNodeSkillWorkspace(workspace, remote);
    const cfg = agentConfig(workspace);
    const names = async (projectId: string) =>
      skillCommands(await listCommands(cfg, { projectId })).map(({ name }) => name);
    // The workspace pseudo-project is the node workspace: never the stale Gateway copy.
    expect(await names("workspace:main")).toEqual(["node_only"]);
    // A registered checkout is Gateway-owned; the node is never asked for its path.
    expect(await names(registered.id)).toEqual(["node_only", "registered_skill"]);
    expect(node.executionRoots).not.toContain(project);
  });
});
