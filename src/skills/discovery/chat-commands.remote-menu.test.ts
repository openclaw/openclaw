import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  declareAgentWorkspaceAccess,
  registerAgentWorkspaceAccess,
} from "../../agents/workspace-access.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { writeSkill } from "../test-support/e2e-test-helpers.js";
import { listSkillCommandsForAgents, listSkillCommandsForWorkspace } from "./chat-commands.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => afterEach(cleanup));

async function fixture(shadowWorkspace: boolean) {
  const root = tempDirs.make("remote-skill-menu-");
  const workspace = path.join(root, "workspace");
  const gatewaySkills = path.join(root, "gateway-skills");
  await writeSkill({
    dir: path.join(gatewaySkills, "gateway-command"),
    name: "gateway-command",
    description: "Gateway-owned command",
  });
  if (shadowWorkspace) {
    await writeSkill({
      dir: path.join(workspace, "skills", "workspace-command"),
      name: "workspace-command",
      description: "Stale Gateway workspace copy",
    });
  }
  const cfg: OpenClawConfig = {
    plugins: { enabled: false },
    skills: { load: { extraDirs: [gatewaySkills] } },
    agents: {
      entries: {
        main: { workspace, skills: ["gateway-command", "workspace-command"] },
      },
    },
  };
  return { cfg, workspace };
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

describe("remote workspace native Skill menus", () => {
  it.each([
    { binding: "registered", shadowWorkspace: false },
    { binding: "registered", shadowWorkspace: true },
    { binding: "declared", shadowWorkspace: false },
  ])(
    "keeps Gateway commands without remote reads ($binding, shadow=$shadowWorkspace)",
    async ({ binding, shadowWorkspace }) => {
      const { cfg, workspace } = await fixture(shadowWorkspace);
      const loadSkills = vi.fn(() => {
        throw new Error("Harness unavailable");
      });
      if (binding === "declared") {
        declareAgentWorkspaceAccess(workspace);
        expect(menuNames(cfg, workspace)).toEqual(["gateway-command"]);
        return;
      }
      const release = registerAgentWorkspaceAccess(workspace, {
        bridge: { readFile: vi.fn(), writeFile: vi.fn(), stat: vi.fn() },
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
    },
  );

  it.each(["local", "active", "stopped"])(
    "preserves workspace commands with %s workspace access",
    async (state) => {
      const { cfg, workspace } = await fixture(true);
      const expected = menuNames(cfg, workspace);
      expect(expected).toEqual(["gateway-command", "workspace-command"]);
      const release =
        state === "local"
          ? undefined
          : registerAgentWorkspaceAccess(workspace, {
              bridge: { readFile: vi.fn(), writeFile: vi.fn(), stat: vi.fn() },
            });
      if (state === "stopped") {
        release?.();
      }
      try {
        expect(menuNames(cfg, workspace)).toEqual(expected);
        expect(expected).toContain("workspace-command");
      } finally {
        release?.();
      }
    },
  );
});
