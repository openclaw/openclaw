import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  prepareRuntimeSkillEntries,
  resolveRuntimeSkillsPrompt,
} from "../../agents/embedded-agent-runner/skills-prompt.js";
import type { OpenClawConfig } from "../../config/config.js";
import { writeSkill } from "../test-support/e2e-test-helpers.js";
import { writePluginWithSkill } from "../test-support/skill-plugin-fixtures.test-support.js";
import { resolveReusableWorkspaceSkillSnapshot } from "./session-snapshot.js";

const tempDirs = createTempDirTracker();
async function resolveBundledDiffsSkillEntries(config?: OpenClawConfig) {
  const bundledPluginsDir = tempDirs.make("openclaw-bundled-");
  const workspaceDir = tempDirs.make("openclaw-workspace-");
  await writePluginWithSkill({
    pluginRoot: path.join(bundledPluginsDir, "diffs"),
    pluginId: "diffs",
    skillId: "diffs",
    skillDescription: "runtime integration test",
  });

  vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", bundledPluginsDir);
  return await prepareRuntimeSkillEntries({
    skillsAnchorWorkspace: workspaceDir,
    ...(config ? { config } : {}),
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
  tempDirs.cleanup();
});

function workspaces() {
  return {
    workspaceDir: tempDirs.make("openclaw-agent-workspace-"),
    executionWorkspaceDir: tempDirs.make("openclaw-execution-workspace-"),
  };
}

async function snapshot(params: Parameters<typeof resolveReusableWorkspaceSkillSnapshot>[0]) {
  return (
    await resolveReusableWorkspaceSkillSnapshot({ ...params, watch: false, snapshotVersion: 1 })
  ).snapshot;
}

function writeWorkspaceSkill(root: string, name: string, description: string) {
  return writeSkill({ dir: path.join(root, "skills", name), name, description });
}

it("matches snapshot skill roots when a snapshot-less run uses a different execution directory", async () => {
  const roots = workspaces();
  const { workspaceDir: agentWorkspaceDir, executionWorkspaceDir } = roots;
  for (const [workspaceDir, name, description] of [
    [agentWorkspaceDir, "fallback-agent", "Agent only"],
    [agentWorkspaceDir, "fallback-shared", "Agent wins"],
    [executionWorkspaceDir, "fallback-execution", "Execution only"],
    [executionWorkspaceDir, "fallback-shared", "Execution loses"],
  ] as const) {
    await writeWorkspaceSkill(workspaceDir, name, description);
  }
  const skillNames = ["fallback-agent", "fallback-shared", "fallback-execution"];
  const saved = await snapshot({ ...roots, config: {}, skillFilter: skillNames });
  const fallback = await prepareRuntimeSkillEntries({
    skillsAnchorWorkspace: agentWorkspaceDir,
    executionWorkspaceDir,
    config: {},
  });
  const fallbackSkills = fallback.skillEntries.filter((entry) =>
    skillNames.includes(entry.skill.name),
  );

  expect(fallbackSkills.map((entry) => entry.skill.name)).toEqual(
    saved.skills.map((skill) => skill.name),
  );
  expect(
    fallbackSkills.find((entry) => entry.skill.name === "fallback-shared")?.skill,
  ).toMatchObject({
    description: "Agent wins",
    filePath: path.join(agentWorkspaceDir, "skills", "fallback-shared", "SKILL.md"),
  });
});

it("keeps agent skills ahead of execution skills in a constrained fallback prompt", async () => {
  const roots = workspaces();
  const agentSkillName = "z-agent-priority";
  const executionSkillName = "a-execution-priority";
  await writeWorkspaceSkill(roots.workspaceDir, agentSkillName, "Agent priority");
  await writeWorkspaceSkill(
    path.join(roots.executionWorkspaceDir, ".agents"),
    executionSkillName,
    "Execution priority",
  );
  const config: OpenClawConfig = {
    skills: { limits: { maxSkillsInPrompt: 1 } },
    agents: { defaults: { skills: [agentSkillName, executionSkillName] } },
  };
  const saved = await snapshot({
    ...roots,
    config,
    skillFilter: [agentSkillName, executionSkillName],
  });
  const { prompt: fallbackPrompt } = await resolveRuntimeSkillsPrompt({
    skillsAnchorWorkspace: roots.workspaceDir,
    executionWorkspaceDir: roots.executionWorkspaceDir,
    config,
    agentId: "main",
  });

  expect(fallbackPrompt).toBe(saved.prompt);
  expect(fallbackPrompt).toContain(agentSkillName);
  expect(fallbackPrompt).not.toContain(executionSkillName);
});

it.each([false, true])("loads bundled diffs only when explicitly enabled (%s)", async (enabled) => {
  const result = await resolveBundledDiffsSkillEntries(
    enabled ? { plugins: { entries: { diffs: { enabled: true } } } } : undefined,
  );
  expect(result.shouldLoadSkillEntries).toBe(true);
  expect(result.skillEntries.some((entry) => entry.skill.name === "diffs")).toBe(enabled);
});
