import path from "node:path";
import { Type } from "typebox";
import { expect, it, onTestFinished } from "vitest";
import { wrapToolWithBeforeToolCallHook } from "../agents/agent-tools.before-tool-call.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import { canonicalizePath } from "../agents/utils/paths.js";
import { consumeRunSkillUsage } from "../skills/runtime/run-usage.js";
import { registerSkillUsageTracking } from "../skills/runtime/skill-usage.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createOwnershipRecord } from "./registry-ownership.test-support.js";
import { createRuntimeTestRegistry } from "./registry-runtime.test-helpers.js";
import { disposePluginRegistryInstances } from "./runtime.js";
import { createPluginRuntime } from "./runtime/index.js";

it("records skill use for the executing plugin tool call and reads it back by path", async () => {
  const state = await createOpenClawTestState({ layout: "state-only" });
  onTestFinished(() => state.cleanup());
  const builder = createRuntimeTestRegistry(createPluginRuntime());
  onTestFinished(async () => void (await disposePluginRegistryInstances(builder.registry)));
  const { skills } = builder.createApi(createOwnershipRecord("skill-usage-reader"), {
    config: {},
    pluginConfig: {},
  }).runtime;
  await state.writeText("workspace/skills/deploy/SKILL.md", "# Deploy\n");
  const skillFile = path.join(state.workspaceDir, "skills", "deploy", "SKILL.md");
  const use: Parameters<typeof skills.recordUsed>[0] = {
    skillFile,
    skillName: "deploy",
    skillSource: "workspace",
  };

  expect((await skills.readUsage({ skillFiles: [skillFile] })).tracked).toBe(false);
  const stopTracking = registerSkillUsageTracking();
  expect(await skills.readUsage({ skillFiles: [skillFile] })).toEqual({
    tracked: true,
    usage: new Map(),
  });
  expect(skills.recordUsed(use)).toBe(false);

  let late: Promise<boolean> | undefined;
  const tool: AnyAgentTool = {
    name: "skill_viewer",
    label: "Skill viewer",
    description: "Shows a skill",
    parameters: Type.Object({}),
    execute: async () => {
      expect(() => skills.recordUsed({ ...use, skillFile: "skills/deploy/SKILL.md" })).toThrow(
        "absolute SKILL.md path",
      );
      expect(skills.recordUsed(use)).toBe(true);
      // A continuation that outlives the call keeps the async context but not the authority.
      late = new Promise((resolve) => {
        setTimeout(() => resolve(skills.recordUsed(use)), 0);
      });
      return { content: [{ type: "text", text: "Deploy" }], details: {} };
    },
  };
  const runId = "plugin-skill-usage";
  await wrapToolWithBeforeToolCallHook(tool, {
    runId,
    agentId: "main",
    loopDetection: { enabled: false },
  }).execute("view-deploy", {});
  expect(await late).toBe(false);
  await stopTracking();

  const canonicalFile = canonicalizePath(skillFile);
  expect(consumeRunSkillUsage(runId)).toEqual([
    { name: "deploy", source: "workspace", activation: "read", skillFile: canonicalFile },
  ]);
  const read = await skills.readUsage({ skillFiles: [skillFile, canonicalFile] });
  expect(read.tracked).toBe(false);
  expect(read.usage.get(skillFile)).toEqual({ useCount: 1, lastUsedAtMs: expect.any(Number) });
  expect(read.usage.get(canonicalFile)).toEqual(read.usage.get(skillFile));
});
