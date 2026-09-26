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

it.each(["reconcile", "overflow"] as const)(
  "invalidates cached entries on whole-scope %s and observes a later edit",
  async (reason) => {
    const workspaceDir = fixture.workspaceDir;
    const root = path.join(workspaceDir, "skills");
    const write = (description: string) =>
      writeSkill({ dir: path.join(root, "guide"), name: "guide", description });
    await write("Before reconciliation");
    refresh.ensureSkillsWatcher({ workspaceDir });
    await observer.readyAll();
    const read = () =>
      loadWorkspaceSkills(workspaceDir, { workspaceOnly: true })[0]!.skill.description;
    expect(read()).toBe("Before reconciliation");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    await write("Changed during reconciliation");
    observer.forRoot(root).dirty(undefined, reason);
    await vi.advanceTimersByTimeAsync(250);
    expect(read()).toBe("Changed during reconciliation");
    await write("Independent later edit");
    observer.forRoot(root).change(path.join(root, "guide", "SKILL.md"));
    await vi.advanceTimersByTimeAsync(250);
    expect(read()).toBe("Independent later edit");
  },
);

it("settles a real SKILL.md content hint through the caller's guarded Root sample", async () => {
  const workspaceDir = fixture.workspaceDir;
  const root = path.join(workspaceDir, "skills");
  const dir = path.join(root, "guide");
  await writeSkill({ dir, name: "guide", description: "Original content" });
  refresh.ensureSkillsWatcher({ workspaceDir });
  await observer.readyAll();
  const read = () =>
    loadWorkspaceSkills(workspaceDir, { workspaceOnly: true })[0]!.skill.description;
  expect(read()).toBe("Original content");
  const fileOwner = await import("./refresh-file-stability.js");
  const create = fileOwner.createSkillFileScheduler;
  // Hold the next acquisition so the wrapper sees the production sample callback.
  await refresh.closeSkillsWatchers();
  const samples: Promise<unknown>[] = [];
  vi.spyOn(fileOwner, "createSkillFileScheduler").mockImplementation((options) =>
    create({
      ...options,
      sample: (name) => {
        const sample = options.sample(name);
        samples.push(sample);
        return sample;
      },
    }),
  );
  refresh.ensureSkillsWatcher({ workspaceDir });
  await observer.readyAll();
  const current = observer.forRoot(root);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
  await writeSkill({ dir, name: "guide", description: "Settled content" });
  current.change(path.join(dir, "SKILL.md"), "content");
  await Promise.resolve();
  await Promise.resolve();
  await Promise.all(samples.splice(0));
  // Advance the domain clock at its sampling boundaries; reads remain genuine.
  for (const elapsed of [100, 100, 50, 250]) {
    await vi.advanceTimersByTimeAsync(elapsed);
    await Promise.all(samples.splice(0));
  }
  expect(read()).toBe("Settled content");
});

it("does not follow a discovery file symlink while settling an advisory content hint", async () => {
  const workspaceDir = fixture.workspaceDir;
  const root = path.join(workspaceDir, "skills");
  const dir = await fixture.createFixtureDirectory("workspace/skills/guide");
  const outside = path.join(fixture.root, "outside.md");
  await fs.writeFile(outside, "---\nname: outside\ndescription: Not admitted\n---\n");
  const file = path.join(dir, "SKILL.md");
  await fs.symlink(outside, file, "file");
  refresh.ensureSkillsWatcher({ workspaceDir });
  await observer.readyAll();
  const observed = observer.forRoot(root);
  const sample = vi.spyOn(observed.authority, "open");
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
  observed.change(file, "content");
  await Promise.resolve();
  await Promise.resolve();
  expect(sample).toHaveBeenCalledWith("./" + path.relative(observed.authority.rootDir, file), {
    symlinks: "reject",
  });
  await expect(sample.mock.results[0]!.value).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(250);
  expect(loadWorkspaceSkills(workspaceDir, { workspaceOnly: true })).toEqual([]);
});

it.each(["creation", "replacement"] as const)(
  "keeps a structural SKILL.md %s unpublished while later content is still settling",
  async (operation) => {
    const workspaceDir = fixture.workspaceDir;
    const root = path.join(workspaceDir, "skills");
    const dir = await fixture.createFixtureDirectory("workspace/skills/guide");
    const file = path.join(dir, "SKILL.md");
    if (operation === "replacement") {
      await writeSkill({ dir, name: "guide", description: "Previous instructions" });
    }
    const fileOwner = await import("./refresh-file-stability.js");
    const create = fileOwner.createSkillFileScheduler;
    const samples: Promise<unknown>[] = [];
    vi.spyOn(fileOwner, "createSkillFileScheduler").mockImplementation((options) =>
      create({
        ...options,
        sample(name) {
          const sample = options.sample(name);
          samples.push(sample);
          return sample;
        },
      }),
    );
    refresh.ensureSkillsWatcher({ workspaceDir });
    await observer.readyAll();
    const current = observer.forRoot(root);
    const read = () =>
      loadWorkspaceSkills(workspaceDir, { workspaceOnly: true }).map(
        (entry) => entry.skill.description,
      );
    expect(read()).toEqual(operation === "replacement" ? ["Previous instructions"] : []);
    const published: string[][] = [];
    refresh.registerSkillsChangeListener((event) => {
      if (event.workspaceDir === workspaceDir) {
        published.push(read());
      }
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    const advance = async (elapsed: number) => {
      await vi.advanceTimersByTimeAsync(elapsed);
      await Promise.all(samples.splice(0));
    };
    if (operation === "replacement") {
      await fs.unlink(file);
    }
    await writeSkill({ dir, name: "guide", description: "Partially written instructions" });
    current.options.onHealth?.({ ...current.subscription.health(), state: "reconciling" });
    current.options.exclude?.({
      path: path.relative(current.authority.rootDir, file),
      kind: "file",
    });
    current.change(file, "structural");
    current.options.onHealth?.({ ...current.subscription.health(), state: "ready" });
    await advance(0);
    await advance(100);
    await advance(100);
    await writeSkill({ dir, name: "guide", description: "Still writing instructions" });
    current.change(file, "content");
    await advance(50);
    expect(published).toEqual([]);
    await writeSkill({ dir, name: "guide", description: "Finished instructions" });
    current.change(file, "content");
    for (const elapsed of [100, 100, 100, 50, 250]) {
      await advance(elapsed);
    }
    expect(published).toEqual([["Finished instructions"]]);
  },
);
