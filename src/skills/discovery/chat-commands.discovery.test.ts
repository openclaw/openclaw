import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { registerAgentWorkspaceAccess } from "../../agents/workspace-access.js";
import { createSkillCommandLoaders } from "../../auto-reply/reply/skill-command-loaders.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { readWorkspaceSkillSources } from "../loading/workspace-skill-source-reader.js";
import { resolveWorkspaceSkillSourcePlan } from "../loading/workspace-skill-sources.js";
import { writeSkill } from "../test-support/e2e-test-helpers.js";
import { registerNodeSkillWorkspace } from "../test-support/node-skill-workspace.js";
import { resolveWorkshopSkillsDir } from "../workshop/skills-root.js";
import {
  expandExplicitSkillReferences,
  listSkillCommandsForWorkspace,
  listSkillCommandsForAgents,
  prepareSkillCommandsForAgents,
  resolveSkillCommandInvocation,
} from "./chat-commands.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => afterEach(cleanup));

function putSkill(dir: string, name: string, description = name, metadata?: string) {
  return writeSkill({ dir: path.join(dir, name), name, description, metadata });
}

function configFor(
  entries: NonNullable<OpenClawConfig["agents"]>["entries"],
  skills?: OpenClawConfig["skills"],
): OpenClawConfig {
  return {
    plugins: { allow: ["skill-workshop"] },
    agents: { entries },
    ...(skills ? { skills } : {}),
  };
}

const bridge = () => ({ readFile: vi.fn(), writeFile: vi.fn(), stat: vi.fn() });

const skillNames = (commands: readonly { skillName: string }[]) =>
  commands.map((command) => command.skillName);
const commandLoaders = (params: Parameters<typeof createSkillCommandLoaders>[1]) =>
  createSkillCommandLoaders(() => import("./chat-commands.runtime.js"), params);

async function remoteFixture(name: string, description: string, bins?: string[]) {
  const root = tempDirs.make("remote-skill-commands-");
  const gateway = path.join(root, "missing-gateway-workspace");
  const remote = path.join(root, "remote");
  await putSkill(path.join(remote, "skills"), name, description);
  const cfg = configFor({ main: { workspace: gateway, ...(bins ? {} : { skills: [name] }) } });
  const release = registerAgentWorkspaceAccess(gateway, {
    bridge: bridge(),
    loadSkills: async (request) => ({
      ...readWorkspaceSkillSources({
        ...request,
        sourcePlan:
          bins && request.sourcePlan.roots.length === 0
            ? request.sourcePlan
            : resolveWorkspaceSkillSourcePlan(remote, { workspaceOnly: true }),
      }),
      ...(bins ? { runtime: { platform: process.platform, bins } } : {}),
    }),
  });
  return { root, cfg, release, params: { workspaceDir: gateway, cfg, agentId: "main" } };
}

async function withBundledDir(root: string, run: () => Promise<void>) {
  const bundledSkillsDir = path.join(root, "bundled");
  await fs.mkdir(bundledSkillsDir);
  await withEnvAsync(
    { OPENCLAW_STATE_DIR: root, OPENCLAW_BUNDLED_SKILLS_DIR: bundledSkillsDir },
    run,
  );
}

function menuNames(cfg: OpenClawConfig, workspace: string) {
  const agentMenu = listSkillCommandsForAgents({ cfg, agentIds: ["main"] });
  const workspaceMenu = listSkillCommandsForWorkspace({
    cfg,
    workspaceDir: workspace,
    agentId: "main",
  });
  expect(skillNames(workspaceMenu)).toEqual(skillNames(agentMenu));
  return skillNames(agentMenu);
}

describe("skill command discovery through workspace loading", () => {
  it("keeps distinct commands across workspaces with truncated-name collisions", async () => {
    const root = tempDirs.make("agent-skill-command-collision-");
    const firstName = `${"a".repeat(31)}-one`;
    const secondName = `${"a".repeat(31)}-two`;
    const entries = Object.fromEntries(
      await Promise.all(
        [firstName, secondName].map(async (name, index) => {
          const workspace = path.join(root, String(index));
          await putSkill(path.join(workspace, "skills"), name);
          const agent = { workspace, skills: [name] };
          return [String(index), agent] as const;
        }),
      ),
    );
    const cfg = configFor(entries, { allowBundled: [] });
    await withBundledDir(root, async () => {
      const commands = await prepareSkillCommandsForAgents({ cfg, agentIds: ["0", "1"] });
      expect(commands.map(({ skillName, name }) => ({ skillName, name }))).toEqual([
        { skillName: firstName, name: `${"a".repeat(31)}_` },
        { skillName: secondName, name: `${"a".repeat(30)}_2` },
      ]);
    });
  });

  it("discovers remote skills while keeping live and retired native menus Gateway-only", async () => {
    const { root, cfg, release, params } = await remoteFixture("hello", "Remote command");
    const gatewaySkills = path.join(root, "gateway-skills");
    const menuConfig = configFor(
      {
        main: {
          workspace: params.workspaceDir,
          skills: ["hello", "gateway-command", "workspace-command"],
        },
      },
      { load: { extraDirs: [gatewaySkills] } },
    );
    try {
      expect(skillNames(await prepareSkillCommandsForAgents({ cfg, agentIds: ["main"] }))).toEqual([
        "hello",
      ]);
      expect(listSkillCommandsForAgents({ cfg, agentIds: ["main"] })).toEqual([]);
      expect(skillNames(await commandLoaders(params).loadSkillCommands!())).toEqual(["hello"]);
      await putSkill(gatewaySkills, "gateway-command", "Gateway-owned command");
      await putSkill(path.join(params.workspaceDir, "skills"), "workspace-command", "Stale copy");
      expect(menuNames(menuConfig, params.workspaceDir)).toEqual(["gateway-command"]);
    } finally {
      release();
    }
    await expect(prepareSkillCommandsForAgents({ cfg, agentIds: ["main"] })).rejects.toThrow(
      "stopped or not ready",
    );
    expect(menuNames(menuConfig, params.workspaceDir)).toEqual(["gateway-command"]);
  });

  it("loads Gateway bundled instructions with Harness binary eligibility despite a workspace collision", async () => {
    // Host facts differ from the Gateway; command filtering must use these facts.
    const { root, release, params } = await remoteFixture("control-ui", "Workspace replacement", [
      "remote-dashboard-helper",
    ]);
    const bundled = path.join(root, "gateway-bundled");
    try {
      await putSkill(
        bundled,
        "control-ui",
        "Gateway bundled dashboard",
        '{"openclaw":{"requires":{"bins":["remote-dashboard-helper"]}}}',
      );
      await withEnvAsync({ OPENCLAW_BUNDLED_SKILLS_DIR: bundled }, async () => {
        const loaders = commandLoaders(params);
        expect(await loaders.loadSkillCommands!()).toEqual([
          expect.objectContaining({
            skillName: "control-ui",
            description: "Workspace replacement",
          }),
        ]);
        expect(await loaders.loadBundledSkillCommand!("control-ui")).toMatchObject({
          skillSource: "bundled",
          description: "Gateway bundled dashboard",
          skillFile: await fs.realpath(path.join(bundled, "control-ui", "SKILL.md")),
        });
        const filtered = commandLoaders({ ...params, skillFilter: ["another-skill"] });
        expect(await filtered.loadBundledSkillCommand!("control-ui")).toBeUndefined();
        expect(await loaders.loadBundledSkillCommand!("../control-ui")).toBeUndefined();
      });
    } finally {
      release();
    }
  });

  it.each(["workspace", "workshop"] as const)(
    "applies the allowlist to %s skills without loading another agent's skills",
    async (source) => {
      const root = tempDirs.make("openclaw-skill-command-discovery-");
      const workspaceDir = path.join(root, "workspace");
      const config = configFor(
        {
          alpha: {
            agentDir: path.join(root, "alpha"),
            workspace: workspaceDir,
            skills: ["allowed"],
          },
          beta: { agentDir: path.join(root, "beta"), workspace: workspaceDir },
        },
        { allowBundled: [], entries: { disabled: { enabled: false } } },
      );
      const skillRoot =
        source === "workshop"
          ? resolveWorkshopSkillsDir(config, "alpha")
          : path.join(workspaceDir, "skills");
      await putSkill(path.join(workspaceDir, "skills"), "allowed");
      for (const name of ["hidden", "disabled"]) {
        await putSkill(skillRoot, name);
      }
      await putSkill(resolveWorkshopSkillsDir(config, "beta"), "beta-only");
      await withBundledDir(root, async () => {
        const params = { workspaceDir, cfg: config, agentId: "alpha" };
        const skillCommands = listSkillCommandsForWorkspace(params);
        const allSkillCommands = listSkillCommandsForWorkspace({
          ...params,
          includeAllowlistHidden: true,
        });
        // Learned (Workshop) skills belong to their agent and bypass its allowlist.
        const visible = source === "workshop" ? ["allowed", "hidden"] : ["allowed"];
        expect(skillNames(skillCommands)).toEqual(visible);
        expect(await prepareSkillCommandsForAgents({ cfg: config, agentIds: ["alpha"] })).toEqual(
          skillCommands,
        );
        expect(skillNames(allSkillCommands)).toEqual(["allowed", "hidden"]);
        for (const text of source === "workshop"
          ? []
          : ["Use $hidden for this task.", "/hidden run it", "/skill hidden run it"]) {
          expect(expandExplicitSkillReferences({ text, skillCommands, allSkillCommands })).toEqual({
            body: text,
            error:
              'Skill "hidden" is not available for this agent. Update the skill allowlist or choose an allowed skill.',
            skills: [],
          });
        }
        expect(
          skillNames(listSkillCommandsForWorkspace({ ...params, skillFilter: ["hidden"] })),
        ).toEqual(["hidden"]);
      });
    },
  );

  // The Gateway preview takes the same host routing from the registry; the commands.list
  // owner proves that half in commands.project-skills.test.ts.
  it("keeps a created session's registered project root Gateway-owned", async () => {
    const root = tempDirs.make("node-agent-created-project-");
    const gateway = path.join(root, "missing-gateway-workspace");
    const remote = path.join(root, "remote");
    const project = path.join(root, "gateway-project");
    await putSkill(path.join(remote, "skills"), "node-agent-skill");
    await putSkill(path.join(project, "skills"), "gateway-project-skill");
    const cfg = configFor(
      { main: { workspace: gateway, skills: ["node-agent-skill", "gateway-project-skill"] } },
      { allowBundled: [] },
    );
    using node = registerNodeSkillWorkspace(gateway, remote);
    const observe = async (load: () => Promise<readonly { skillName: string }[]>) => {
      node.executionRoots.length = 0;
      const skills = skillNames(await load()).toSorted();
      return { skills, nodeRoots: [...node.executionRoots] };
    };
    // Reply-path loaders and the commands.list catalog resolve a session's root alike.
    const sessionCommands = async (entry: Record<string, unknown>) => {
      const sessionEntry: SessionEntry = { sessionId: "s", updatedAt: 0, ...entry };
      const reply = await observe(() =>
        commandLoaders({ workspaceDir: gateway, cfg, agentId: "main", sessionEntry })
          .loadSkillCommands!(),
      );
      const catalog = await observe(() =>
        prepareSkillCommandsForAgents({ cfg, agentIds: ["main"], sessionEntry }),
      );
      expect(catalog).toEqual(reply);
      return reply;
    };
    const both = ["gateway-project-skill", "node-agent-skill"];
    await withBundledDir(root, async () => {
      // sessions.create records a registered project as projectId plus its admitted spawnedCwd.
      expect(await sessionCommands({ projectId: "registered-alpha", spawnedCwd: project })).toEqual(
        { skills: both, nodeRoots: [undefined] },
      );
      // A cwd without a registered project is node-owned: the node is asked, the Gateway never reads it.
      expect(await sessionCommands({ spawnedCwd: project })).toEqual({
        skills: ["node-agent-skill"],
        nodeRoots: [project],
      });
      // The agent-workspace pseudo-project is the node workspace itself.
      expect(await sessionCommands({ projectId: "workspace:main", spawnedCwd: project })).toEqual({
        skills: ["node-agent-skill"],
        nodeRoots: [project],
      });
      // Managed worktrees keep their canonical Gateway source.
      const worktree = {
        id: "wt",
        branch: "main",
        repoRoot: project,
        canonicalWorkspaceDir: project,
      };
      expect((await sessionCommands({ worktree })).skills).toEqual(both);
    });
  });

  it("invokes a session's project skills through the reply-path loaders", async () => {
    const root = tempDirs.make("openclaw-session-project-invocation-");
    const workspaceDir = path.join(root, "workspace");
    const project = path.join(root, "project");
    await putSkill(path.join(workspaceDir, "skills"), "agent-fixture");
    await putSkill(path.join(project, "skills"), "project-fixture");
    await putSkill(path.join(project, ".agents", "skills"), "project-agents-fixture");
    const cfg = configFor(
      {
        main: {
          workspace: workspaceDir,
          skills: ["agent-fixture", "project-fixture", "project-agents-fixture"],
        },
      },
      { allowBundled: [] },
    );
    const load = (spawnedCwd?: string) =>
      commandLoaders({
        workspaceDir,
        cfg,
        agentId: "main",
        sessionEntry: spawnedCwd
          ? { sessionId: "project-session", updatedAt: 0, spawnedCwd }
          : undefined,
      }).loadSkillCommands!();
    await withBundledDir(root, async () => {
      expect(skillNames(await load())).toEqual(["agent-fixture"]);
      const skillCommands = await load(project);
      expect(skillNames(skillCommands)).toEqual([
        "agent-fixture",
        "project-agents-fixture",
        "project-fixture",
      ]);
      const expansion = expandExplicitSkillReferences({
        text: "$project_agents_fixture and $project_fixture review this",
        skillCommands,
      });
      expect(expansion.error).toBeUndefined();
      expect(skillNames(expansion.skills)).toEqual(["project-agents-fixture", "project-fixture"]);
      expect(
        resolveSkillCommandInvocation({
          commandBodyNormalized: "/project_fixture now",
          skillCommands,
        })?.command.skillName,
      ).toBe("project-fixture");
    });
  });
});
