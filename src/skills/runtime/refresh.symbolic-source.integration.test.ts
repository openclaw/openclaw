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

it.each([false, true])(
  "observes a lexical link and selects its target only under source policy, trusted=%s",
  async (trusted) => {
    const outside = await fixture.createFixtureDirectory("outside");
    await writeSkill({
      dir: path.join(outside, "guide"),
      name: "guide",
      description: "Target content",
    });
    const workspaceDir = await fixture.createFixtureDirectory(".cache/symbolic-workspace");
    await fs.mkdir(path.join(workspaceDir, "skills"));
    const link = path.join(workspaceDir, "skills", "linked");
    await fs.symlink(outside, link, process.platform === "win32" ? "junction" : "dir");
    const config = { skills: { load: { allowSymlinkTargets: trusted ? [outside] : [] } } };
    refresh.ensureSkillsWatcher({ workspaceDir, config });
    await observer.readyAll();
    const targetSelected = observer.subscriptions.some((entry) =>
      entry.options.scopes.some(
        (scope) => path.resolve(entry.authority.rootDir, scope.path) === outside,
      ),
    );
    expect(targetSelected).toBe(trusted);
    const read = () =>
      loadWorkspaceSkills(workspaceDir, { config, workspaceOnly: true }).map(
        (entry) => entry.skill.description,
      );
    expect(read()).toEqual(trusted ? ["Target content"] : []);
    if (!trusted) {
      return;
    }
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    await writeSkill({
      dir: path.join(outside, "guide"),
      name: "guide",
      description: "Later target edit",
    });
    observer.forRoot(outside).change(path.join(outside, "guide", "SKILL.md"));
    await vi.advanceTimersByTimeAsync(250);
    expect(read()).toEqual(["Later target edit"]);
  },
);

it("rediscovers a replaced symbolic source and its later independent edit", async () => {
  const workspaceDir = fixture.workspaceDir;
  const source = path.join(workspaceDir, "skills");
  const target = await fixture.createFixtureDirectory("target");
  await fs.rm(source, { recursive: true });
  await fs.symlink(target, source, process.platform === "win32" ? "junction" : "dir");
  await writeSkill({
    dir: path.join(target, "guide"),
    name: "guide",
    description: "Linked instructions",
  });
  const config = { skills: { load: { allowSymlinkTargets: [target] } } };
  const params = { workspaceDir, config };
  refresh.ensureSkillsWatcher(params);
  await observer.readyAll();
  const lexical = observer.forRoot(source);
  expect(lexical.options.scopes[0]!.kind).toBe("entry");
  const read = () =>
    loadWorkspaceSkills(workspaceDir, { config, workspaceOnly: true })[0]?.skill.description;
  expect(read()).toBe("Linked instructions");
  await fs.unlink(source);
  await writeSkill({
    dir: path.join(source, "guide"),
    name: "guide",
    description: "Replacement instructions",
  });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
  lexical.change(source);
  await vi.advanceTimersByTimeAsync(250);
  expect(read()).toBe("Replacement instructions");
  // The caller must reconcile lexical entry-to-tree scope changes at preparation.
  refresh.ensureSkillsWatcher(params);
  await observer.readyAll();
  const replacement = observer.forRoot(source);
  expect(replacement.options.scopes[0]!.kind).toBe("tree");
  await writeSkill({
    dir: path.join(source, "guide"),
    name: "guide",
    description: "Later replacement edit",
  });
  replacement.change(path.join(source, "guide", "SKILL.md"));
  await vi.advanceTimersByTimeAsync(250);
  expect(read()).toBe("Later replacement edit");
});
