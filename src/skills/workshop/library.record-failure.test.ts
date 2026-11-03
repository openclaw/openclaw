import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../../plugins/hooks.test-fixtures.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { registerSkillsChangeListener } from "../runtime/refresh-state.js";
import { createWorkshopSkill } from "./library.js";
import { resolveWorkshopSkillsDir } from "./skills-root.js";

vi.mock("./changes.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./changes.js")>()),
  recordWorkshopChange: vi.fn(async () => {
    throw new Error("change log unavailable");
  }),
}));

let state: OpenClawTestState;
beforeEach(async () => {
  state = await createOpenClawTestState({ layout: "state-only" });
});
afterEach(async () => {
  resetGlobalHookRunner();
  await state.cleanup();
});

it("refreshes discovery for a committed write even when the change log fails", async () => {
  const hook = vi.fn();
  initializeGlobalHookRunner(
    createMockPluginRegistry([{ hookName: "skill_changed", handler: hook }]),
  );
  const reasons: string[] = [];
  const unregister = registerSkillsChangeListener((event) => reasons.push(event.reason));
  try {
    await expect(
      createWorkshopSkill(
        { config: {}, agentId: "main", actor: "agent" },
        {
          name: "deploy",
          content: "---\nname: deploy\ndescription: Deploy staging builds\n---\n\nRun it.\n",
        },
      ),
    ).rejects.toThrow("change log unavailable");
  } finally {
    unregister();
  }
  await expect(
    fs.readFile(path.join(resolveWorkshopSkillsDir({}, "main"), "deploy", "SKILL.md"), "utf8"),
  ).resolves.toContain("name: deploy");
  expect(reasons).toContain("workshop");
  // As before: an unrecorded change is not announced.
  expect(hook).not.toHaveBeenCalled();
});
