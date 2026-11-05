import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  prepareRuntimeSkillEntries,
  resolveRuntimeSkillsPrompt,
} from "../../agents/embedded-agent-runner/skills-prompt.js";
import type { OpenClawConfig } from "../../config/config.js";
import { writeSkill } from "../test-support/e2e-test-helpers.js";
import { writePluginWithSkill } from "../test-support/skill-plugin-fixtures.test-support.js";
import { resolveReusableWorkspaceSkillSnapshot } from "./session-snapshot.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.unstubAllEnvs());

async function workspaceFixture(
  skills: ["agent" | "execution", string, string, ".agents"?][],
  config: OpenClawConfig = {},
) {
  const workspaceDir = tempDirs.make("openclaw-agent-workspace-");
  const executionWorkspaceDir = tempDirs.make("openclaw-execution-workspace-");
  for (const [root, name, description, subdir = ""] of skills) {
    const base = root === "agent" ? workspaceDir : executionWorkspaceDir;
    await writeSkill({ dir: path.join(base, subdir, "skills", name), name, description });
  }
  const skillFilter = [...new Set(skills.map(([, name]) => name))];
  const { snapshot } = await resolveReusableWorkspaceSkillSnapshot({
    workspaceDir,
    executionWorkspaceDir,
    config,
    skillFilter,
    watch: false,
    snapshotVersion: 1,
  });
  return {
    snapshot,
    skillFilter,
    params: { skillsAnchorWorkspace: workspaceDir, executionWorkspaceDir, config },
  };
}

it("matches snapshot skill roots when a snapshot-less run uses a different execution directory", async () => {
  const { snapshot, params, skillFilter } = await workspaceFixture([
    ["agent", "fallback-agent", "Agent only"],
    ["agent", "fallback-shared", "Agent wins"],
    ["execution", "fallback-execution", "Execution only"],
    ["execution", "fallback-shared", "Execution loses"],
  ]);
  const { skillEntries } = await prepareRuntimeSkillEntries(params);
  const skills = skillEntries
    .map((entry) => entry.skill)
    .filter((skill) => skillFilter.includes(skill.name));
  expect(skills.map((skill) => skill.name)).toEqual(snapshot.skills.map((skill) => skill.name));
  expect(skills.find((skill) => skill.name === "fallback-shared")).toMatchObject({
    description: "Agent wins",
    filePath: path.join(params.skillsAnchorWorkspace, "skills", "fallback-shared", "SKILL.md"),
  });
});

it("keeps agent skills ahead of execution skills in a constrained fallback prompt", async () => {
  const agent = "z-agent-priority",
    execution = "a-execution-priority";
  const { snapshot, params } = await workspaceFixture(
    [
      ["agent", agent, "Agent priority"],
      ["execution", execution, "Execution priority", ".agents"],
    ],
    {
      skills: { limits: { maxSkillsInPrompt: 1 } },
      agents: { defaults: { skills: [agent, execution] } },
    },
  );
  const { prompt } = await resolveRuntimeSkillsPrompt({ ...params, agentId: "main" });
  expect(prompt).toBe(snapshot.prompt);
  expect(prompt).toContain(agent);
  expect(prompt).not.toContain(execution);
});

it.each([false, true])("loads bundled diffs only when explicitly enabled (%s)", async (enabled) => {
  const bundledPluginsDir = tempDirs.make("openclaw-bundled-");
  await writePluginWithSkill({
    pluginRoot: path.join(bundledPluginsDir, "diffs"),
    pluginId: "diffs",
    skillId: "diffs",
    skillDescription: "runtime integration test",
  });
  vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", bundledPluginsDir);
  const result = await prepareRuntimeSkillEntries({
    skillsAnchorWorkspace: tempDirs.make("openclaw-workspace-"),
    ...(enabled ? { config: { plugins: { entries: { diffs: { enabled: true } } } } } : {}),
  });
  expect(result.shouldLoadSkillEntries).toBe(true);
  expect(result.skillEntries.some((entry) => entry.skill.name === "diffs")).toBe(enabled);
});
