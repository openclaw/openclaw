import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { resolvePluginAgentSkillsDirs } from "./plugin-skills.js";

let workspaceDir: string;
beforeEach(async () => {
  workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-agent-skills-"));
});
afterEach(async () => {
  await fs.rm(workspaceDir, { recursive: true, force: true });
});

it("loads a plugin's per-agent learned skill folder only while the plugin is enabled", () => {
  expect(resolvePluginAgentSkillsDirs({ workspaceDir, config: {} })).toEqual(["workshop-skills"]);
  expect(
    resolvePluginAgentSkillsDirs({
      workspaceDir,
      config: { plugins: { entries: { "skill-workshop": { enabled: false } } } },
    }),
  ).toEqual([]);
});
