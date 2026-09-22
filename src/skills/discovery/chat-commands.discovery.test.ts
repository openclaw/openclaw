import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { registerAgentWorkspaceAccess } from "../../agents/workspace-access.js";
import { createSkillCommandLoaders } from "../../auto-reply/reply/skill-command-loaders.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { readWorkspaceSkillSources } from "../loading/workspace-skill-loader.js";
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

describe("skill command discovery through workspace loading", () => {
  it("includes a registered remote workspace absent from the Gateway filesystem", async () => {
    const root = tempDirs.make("remote-skill-commands-");
    const gateway = path.join(root, "missing-gateway-workspace");
    const remote = path.join(root, "remote");
    await writeSkill({
      dir: path.join(remote, "skills", "hello"),
      name: "hello",
      description: "Remote command",
    });
    const cfg = {
      plugins: { enabled: false },
      agents: { entries: { main: { workspace: gateway, skills: ["hello"] } } },
    } satisfies OpenClawConfig;
    const release = registerAgentWorkspaceAccess(gateway, {
      bridge: { readFile: vi.fn(), writeFile: vi.fn(), stat: vi.fn() },
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
    await writeSkill({
      dir: path.join(bundled, "control-ui"),
      name: "control-ui",
      description: "Gateway bundled dashboard",
      metadata: '{"openclaw":{"requires":{"bins":["remote-dashboard-helper"]}}}',
    });
    await writeSkill({
      dir: path.join(remote, "skills", "control-ui"),
      name: "control-ui",
      description: "Workspace replacement",
    });
    const cfg = {
      plugins: { enabled: false },
      agents: { entries: { main: { workspace: gateway } } },
    } satisfies OpenClawConfig;
    const release = registerAgentWorkspaceAccess(gateway, {
      bridge: { readFile: vi.fn(), writeFile: vi.fn(), stat: vi.fn() },
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
    "reports allowlist-hidden %s skills without loading another agent's skills",
    async (source) => {
      const root = tempDirs.make("openclaw-skill-command-discovery-");
      const workspaceDir = path.join(root, "workspace");
      const config = {
        plugins: { enabled: false },
        agents: {
          entries: {
            alpha: {
              agentDir: path.join(root, "alpha"),
              workspace: workspaceDir,
              skills: ["allowed"],
            },
            beta: { agentDir: path.join(root, "beta"), workspace: workspaceDir },
          },
        },
        skills: { allowBundled: [], entries: { disabled: { enabled: false } } },
      } satisfies OpenClawConfig;
      const skillRoot =
        source === "workshop"
          ? resolveWorkshopSkillsDir(config, "alpha")
          : path.join(workspaceDir, "skills");
      await writeSkill({
        dir: path.join(workspaceDir, "skills", "allowed"),
        name: "allowed",
        description: "Allowed procedure",
      });
      for (const name of ["hidden", "disabled"]) {
        await writeSkill({
          dir: path.join(skillRoot, name),
          name,
          description: `${name} procedure`,
        });
      }
      await writeSkill({
        dir: path.join(resolveWorkshopSkillsDir(config, "beta"), "beta-only"),
        name: "beta-only",
        description: "Beta's private procedure",
      });
      const bundledSkillsDir = path.join(root, "bundled");
      await fs.mkdir(bundledSkillsDir);
      await withEnvAsync(
        { OPENCLAW_STATE_DIR: root, OPENCLAW_BUNDLED_SKILLS_DIR: bundledSkillsDir },
        async () => {
          const params = { workspaceDir, cfg: config, agentId: "alpha" };
          const skillCommands = listSkillCommandsForWorkspace(params);
          const allSkillCommands = listSkillCommandsForWorkspace({
            ...params,
            includeAllowlistHidden: true,
          });
          expect(skillCommands.map((command) => command.skillName)).toEqual(["allowed"]);
          expect(await prepareSkillCommandsForAgents({ cfg: config, agentIds: ["alpha"] })).toEqual(
            skillCommands,
          );
          expect(allSkillCommands.map((command) => command.skillName)).toEqual([
            "allowed",
            "hidden",
          ]);
          for (const text of [
            "Use $hidden for this task.",
            "/hidden run it",
            "/skill hidden run it",
          ]) {
            expect(
              expandExplicitSkillReferences({ text, skillCommands, allSkillCommands }),
            ).toEqual({
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
        },
      );
    },
  );
});
