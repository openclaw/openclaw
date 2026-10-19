import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { registerAgentWorkspaceAccess } from "../../agents/workspace-access.js";
import { createSkillCommandLoaders } from "../../auto-reply/reply/skill-command-loaders.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { readWorkspaceSkillSources } from "../loading/workspace-skill-source-reader.js";
import { resolveWorkspaceSkillSourcePlan } from "../loading/workspace-skill-sources.js";
import { writeSkill } from "../test-support/e2e-test-helpers.js";
import { resolveWorkshopSkillsDir } from "../workshop/skills-root.js";
import {
  expandExplicitSkillReferences,
  listSkillCommandsForWorkspace,
  listSkillCommandsForAgents,
  prepareSkillCommandsForAgents,
} from "./chat-commands.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => afterEach(cleanup));

function putSkill(dir: string, name: string, description: string, metadata?: string) {
  return writeSkill({ dir: path.join(dir, name), name, description, metadata });
}

function configFor(
  entries: NonNullable<OpenClawConfig["agents"]>["entries"],
  skills?: OpenClawConfig["skills"],
): OpenClawConfig {
  return { plugins: { enabled: false }, agents: { entries }, ...(skills ? { skills } : {}) };
}

function bridge() {
  return { readFile: vi.fn(), writeFile: vi.fn(), stat: vi.fn() };
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
  expect(workspaceMenu.map((command) => command.skillName)).toEqual(
    agentMenu.map((command) => command.skillName),
  );
  return agentMenu.map((command) => command.skillName);
}

describe("skill command discovery through workspace loading", () => {
  it("keeps distinct commands across workspaces with truncated-name collisions", async () => {
    const root = tempDirs.make("agent-skill-command-collision-");
    const firstName = `${"a".repeat(31)}-one`;
    const secondName = `${"a".repeat(31)}-two`;
    const firstWorkspace = path.join(root, "first");
    const secondWorkspace = path.join(root, "second");
    for (const [workspace, name] of [
      [firstWorkspace, firstName],
      [secondWorkspace, secondName],
    ] as const) {
      await putSkill(path.join(workspace, "skills"), name, "Agent command");
    }
    const cfg = configFor(
      {
        first: { workspace: firstWorkspace, skills: [firstName] },
        second: { workspace: secondWorkspace, skills: [secondName] },
      },
      { allowBundled: [] },
    );
    await withBundledDir(root, async () => {
      const commands = await prepareSkillCommandsForAgents({
        cfg,
        agentIds: ["first", "second"],
      });
      expect(commands.map(({ skillName, name }) => ({ skillName, name }))).toEqual([
        { skillName: firstName, name: `${"a".repeat(31)}_` },
        {
          skillName: secondName,
          name: `${"a".repeat(30)}_2`,
        },
      ]);
    });
  });

  it("includes a registered remote workspace absent from the Gateway filesystem", async () => {
    const root = tempDirs.make("remote-skill-commands-");
    const gateway = path.join(root, "missing-gateway-workspace");
    const remote = path.join(root, "remote");
    await putSkill(path.join(remote, "skills"), "hello", "Remote command");
    const cfg = configFor({ main: { workspace: gateway, skills: ["hello"] } });
    const release = registerAgentWorkspaceAccess(gateway, {
      bridge: bridge(),
      loadSkills: async (request) =>
        readWorkspaceSkillSources({
          ...request,
          sourcePlan: resolveWorkspaceSkillSourcePlan(remote, { workspaceOnly: true }),
        }),
    });
    try {
      expect(
        (await prepareSkillCommandsForAgents({ cfg, agentIds: ["main"] })).map(
          (command) => command.skillName,
        ),
      ).toEqual(["hello"]);
      expect(listSkillCommandsForAgents({ cfg, agentIds: ["main"] })).toEqual([]);
      const loaders = createSkillCommandLoaders(() => import("./chat-commands.runtime.js"), {
        workspaceDir: gateway,
        cfg,
        agentId: "main",
      });
      expect((await loaders.loadSkillCommands!()).map((command) => command.skillName)).toEqual([
        "hello",
      ]);
    } finally {
      release();
    }
    await expect(prepareSkillCommandsForAgents({ cfg, agentIds: ["main"] })).rejects.toThrow(
      "stopped or not ready",
    );
  });

  it("loads Gateway bundled instructions with Harness binary eligibility despite a workspace collision", async () => {
    const root = tempDirs.make("remote-bundled-command-");
    const gateway = path.join(root, "gateway");
    const remote = path.join(root, "remote");
    const bundled = path.join(root, "gateway-bundled");
    await putSkill(
      bundled,
      "control-ui",
      "Gateway bundled dashboard",
      '{"openclaw":{"requires":{"bins":["remote-dashboard-helper"]}}}',
    );
    await putSkill(path.join(remote, "skills"), "control-ui", "Workspace replacement");
    const cfg = configFor({ main: { workspace: gateway } });
    const release = registerAgentWorkspaceAccess(gateway, {
      bridge: bridge(),
      loadSkills: async (request) => {
        const sources = readWorkspaceSkillSources({
          ...request,
          sourcePlan:
            request.sourcePlan.roots.length === 0
              ? request.sourcePlan
              : resolveWorkspaceSkillSourcePlan(remote, { workspaceOnly: true }),
        });
        // Host facts differ from the Gateway; command filtering must use these facts.
        return {
          ...sources,
          runtime: { platform: process.platform, bins: ["remote-dashboard-helper"] },
        };
      },
    });
    try {
      await withEnvAsync({ OPENCLAW_BUNDLED_SKILLS_DIR: bundled }, async () => {
        const params = { workspaceDir: gateway, cfg, agentId: "main" };
        const loaders = createSkillCommandLoaders(
          () => import("./chat-commands.runtime.js"),
          params,
        );
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
        const filtered = createSkillCommandLoaders(() => import("./chat-commands.runtime.js"), {
          ...params,
          skillFilter: ["another-skill"],
        });
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
      await putSkill(path.join(workspaceDir, "skills"), "allowed", "Allowed procedure");
      for (const name of ["hidden", "disabled"]) {
        await putSkill(skillRoot, name, `${name} procedure`);
      }
      await putSkill(
        resolveWorkshopSkillsDir(config, "beta"),
        "beta-only",
        "Beta's private procedure",
      );
      await withBundledDir(root, async () => {
        const params = { workspaceDir, cfg: config, agentId: "alpha" };
        const skillCommands = listSkillCommandsForWorkspace(params);
        const allSkillCommands = listSkillCommandsForWorkspace({
          ...params,
          includeAllowlistHidden: true,
        });
        // Learned (Workshop) skills belong to their agent and bypass its allowlist.
        const visible = source === "workshop" ? ["allowed", "hidden"] : ["allowed"];
        expect(skillCommands.map((command) => command.skillName)).toEqual(visible);
        expect(await prepareSkillCommandsForAgents({ cfg: config, agentIds: ["alpha"] })).toEqual(
          skillCommands,
        );
        expect(allSkillCommands.map((command) => command.skillName)).toEqual(["allowed", "hidden"]);
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
          listSkillCommandsForWorkspace({ ...params, skillFilter: ["hidden"] }).map(
            (command) => command.skillName,
          ),
        ).toEqual(["hidden"]);
      });
    },
  );

  it("keeps Gateway commands without exposing a stale remote workspace copy", async () => {
    const root = tempDirs.make("remote-skill-menu-");
    const workspace = path.join(root, "workspace");
    const gatewaySkills = path.join(root, "gateway-skills");
    await putSkill(gatewaySkills, "gateway-command", "Gateway-owned command");
    await putSkill(
      path.join(workspace, "skills"),
      "workspace-command",
      "Stale Gateway workspace copy",
    );
    const cfg = configFor(
      { main: { workspace, skills: ["gateway-command", "workspace-command"] } },
      { load: { extraDirs: [gatewaySkills] } },
    );
    const loadSkills = vi.fn(() => {
      throw new Error("Harness unavailable");
    });
    const release = registerAgentWorkspaceAccess(workspace, {
      bridge: bridge(),
      loadSkills,
    });
    try {
      expect(menuNames(cfg, workspace)).toEqual(["gateway-command"]);
      expect(loadSkills).not.toHaveBeenCalled();
    } finally {
      release();
    }
    expect(menuNames(cfg, workspace)).toEqual(["gateway-command"]);
    expect(loadSkills).not.toHaveBeenCalled();
  });
});
