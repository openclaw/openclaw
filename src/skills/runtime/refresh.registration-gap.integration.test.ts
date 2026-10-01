import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { loadWorkspaceSkills } from "../loading/workspace-skill-loader.js";
import { writeSkill } from "../test-support/e2e-test-helpers.js";
import {
  createSkillsWatcherMock,
  useSkillsWatcherFixture,
} from "./refresh.watcher.test-support.js";
const observer = createSkillsWatcherMock();
vi.mock("@openclaw/fs-safe/watch", () => ({ watch: observer.watchMock }));
vi.mock("../loading/plugin-skills.js", () => ({
  resolvePluginSkillRoots: () => [],
  resolvePluginSkillRootsFromMetadata: () => [],
}));
const fixture = useSkillsWatcherFixture(observer);
const refresh = await import("./refresh.js");

// Domain integration: admission/ready is controlled; parsing and cached reads are real.
it.each(["create", "edit", "rename"] as const)(
  "invalidates cached discovery after %s during initial registration",
  async (operation) => {
    const workspaceDir = fixture.workspaceDir;
    const skill = path.join(workspaceDir, "skills", "guide");
    if (operation !== "create") {
      await writeSkill({ dir: skill, name: "guide", description: "Before registration" });
    }
    const options = { workspaceOnly: true };
    refresh.ensureSkillsWatcher({ workspaceDir });
    await observer.started();
    const before = loadWorkspaceSkills(workspaceDir, options);
    expect(before.map((entry) => entry.skill.name)).toEqual(
      operation === "create" ? [] : ["guide"],
    );
    if (operation === "rename") {
      await fs.rename(skill, path.join(workspaceDir, "skills", "moved"));
    }
    await writeSkill({
      dir: operation === "rename" ? path.join(workspaceDir, "skills", "moved") : skill,
      name: "guide",
      description: "After registration",
    });
    await observer.readyAll();
    const after = loadWorkspaceSkills(workspaceDir, options);
    expect(after[0]!.skill.description).toBe("After registration");
    if (operation === "rename") {
      expect(after[0]!.skill.filePath).toContain(path.join("moved", "SKILL.md"));
    }
  },
);

it.each(["initial", "closed", "disabled", "evicted"] as const)(
  "reads repaired skills before asynchronous %s acquisition completes",
  async (lifecycle) => {
    const workspaceDir = fixture.workspaceDir;
    const dir = path.join(workspaceDir, "skills", "guide");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "SKILL.md"), "invalid skill frontmatter\n");
    if (lifecycle !== "initial") {
      refresh.ensureSkillsWatcher({ workspaceDir });
      await observer.readyAll();
    }
    const read = () =>
      loadWorkspaceSkills(workspaceDir, { workspaceOnly: true }).map((entry) => entry.skill.name);
    expect(read()).toEqual([]);
    if (lifecycle === "closed") {
      await refresh.closeSkillsWatchers();
    }
    if (lifecycle === "disabled") {
      refresh.ensureSkillsWatcher({ workspaceDir, config: { skills: { load: { watch: false } } } });
    }
    if (lifecycle === "evicted") {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
      vi.setSystemTime(Date.now() + 60 * 60_000 + 1);
      refresh.ensureSkillsWatcher({ workspaceDir: await fixture.createFixtureDirectory("other") });
    }
    await writeSkill({ dir, name: "guide", description: "Repaired before acquisition" });
    refresh.ensureSkillsWatcher({ workspaceDir });
    expect(read()).toEqual(["guide"]);
  },
);
