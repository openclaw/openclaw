import fs from "node:fs/promises";
import path from "node:path";
import type { WatchSubscription } from "@openclaw/fs-safe/watch";
import { beforeEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { loadWorkspaceSkills } from "../loading/workspace-skill-loader.js";
import { resolveWorkspaceSkillSourcePlan } from "../loading/workspace-skill-sources.js";
import { writeSkill } from "../test-support/e2e-test-helpers.js";
import { getSkillsResourceVersion, getSkillsSourceVersion } from "./refresh-state.js";
import { toWatchRoot } from "./refresh-watch-path.js";
import { pathWatchers } from "./refresh-watch-registry.js";
import { useSkillsWatcherFixture } from "./refresh.watcher.test-support.js";

const subscriptions: WatchSubscription[] = [];
const starts: Promise<void>[] = [];
vi.mock("@openclaw/fs-safe/watch", async () => {
  const { createRequire } = await import("node:module");
  // /root and /watch must share fs-safe's private Root registry.
  const actual = createRequire(import.meta.url)(
    "@openclaw/fs-safe/watch",
  ) as typeof import("@openclaw/fs-safe/watch");
  const watch: typeof actual.watch = (root, options) => {
    const subscription = actual.watch(root, {
      ...options,
      mode: "poll",
      pollIntervalMs: 2_147_483_647,
    });
    const setScopes = subscription.setScopes.bind(subscription);
    subscription.setScopes = (scopes) => {
      const scoped = setScopes(scopes);
      starts.push(scoped);
      return scoped;
    };
    subscriptions.push(subscription);
    starts.push(subscription.ready);
    return subscription;
  };
  return { ...actual, watch };
});
vi.mock("../loading/plugin-skills.js", () => ({
  resolvePluginSkillRoots: () => [],
  resolvePluginSkillRootsFromMetadata: () => [],
}));
const fixture = useSkillsWatcherFixture();
const refresh = await import("./refresh.js");
const planning: Promise<unknown>[] = [];
const samples: Promise<unknown>[] = [];
beforeEach(async () => {
  subscriptions.length = starts.length = planning.length = samples.length = 0;
  const settling = await import("./refresh-file-stability.js");
  const createScheduler = settling.createSkillFileScheduler;
  vi.spyOn(settling, "createSkillFileScheduler").mockImplementation((options) =>
    createScheduler({
      ...options,
      sample(changedPath) {
        const sample = options.sample(changedPath);
        samples.push(sample);
        return sample;
      },
    }),
  );
  const owner = await import("./refresh-observation-source.js");
  const scope = owner.skillsObservationScope;
  vi.spyOn(owner, "skillsObservationScope").mockImplementation((...args) => {
    const work = scope(...args);
    planning.push(work);
    return work;
  });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
});

async function ready() {
  // A completed admission can discover another trusted target or widen an entry scope.
  let joined = -1;
  while (joined !== starts.length + planning.length) {
    joined = starts.length + planning.length;
    await Promise.resolve();
    await Promise.all(
      [...pathWatchers.values()].flatMap((state) => (state.authority ? [state.authority] : [])),
    );
    await Promise.all(planning);
    await Promise.all(starts);
  }
}

async function advance(elapsed: number) {
  await vi.advanceTimersByTimeAsync(elapsed);
  await Promise.all(samples.splice(0));
}

async function reconcile() {
  const results = await Promise.allSettled(
    subscriptions
      .filter((subscription) => subscription.health().state === "ready")
      .map((subscription) => subscription.reconcile()),
  );
  for (const result of results) {
    if (result.status === "rejected") {
      expect(result.reason).toMatchObject({ name: "AbortError" });
    }
  }
  await ready();
  for (const elapsed of [0, 100, 100, 50, 250]) {
    await advance(elapsed);
  }
}

const linkType = process.platform === "win32" ? "junction" : "dir";
const read = (config?: OpenClawConfig) =>
  loadWorkspaceSkills(fixture.workspaceDir, { workspaceOnly: true, config }).map(
    (entry) => entry.skill.description,
  );
const ensure = (config?: OpenClawConfig) => {
  refresh.ensureSkillsWatcher({
    workspaceDir: fixture.workspaceDir,
    config,
    sourcePlan: resolveWorkspaceSkillSourcePlan(fixture.workspaceDir, {
      workspaceOnly: true,
      config,
    }),
  });
  return ready();
};

it("discovers a newly created root and keeps observing edits and deletion", async () => {
  const root = path.join(fixture.workspaceDir, "skills");
  const write = (description: string) =>
    writeSkill({ dir: path.join(root, "guide"), name: "guide", description });
  await fs.rm(root, { recursive: true });
  await ensure();
  expect(read()).toEqual([]);
  await write("Created");
  await reconcile();
  expect(read()).toEqual(["Created"]);
  const version = getSkillsSourceVersion(fixture.workspaceDir);
  await write("Edited");
  await reconcile();
  expect(getSkillsSourceVersion(fixture.workspaceDir)).toBeGreaterThan(version);
  expect(read()).toEqual(["Edited"]);
  await fs.rm(root, { recursive: true });
  await reconcile();
  expect(read()).toEqual([]);
});

it("refreshes supporting resources without invalidating discovery, including atomic saves", async () => {
  const dir = path.join(fixture.workspaceDir, "skills", "guide");
  await writeSkill({ dir, name: "guide", description: "Stable discovery" });
  await ensure();
  expect(read()).toEqual(["Stable discovery"]);
  const file = path.join(dir, "README.md");
  const sourceVersion = getSkillsSourceVersion(fixture.workspaceDir);
  const changed = vi.fn();
  refresh.registerSkillsChangeListener(changed);
  for (const operation of ["create", "replace", "delete"] as const) {
    const before = getSkillsResourceVersion(fixture.workspaceDir);
    if (operation === "create") {
      await fs.writeFile(file, "created");
    } else if (operation === "replace") {
      const temporary = path.join(fixture.root, "replacement");
      await fs.writeFile(temporary, "replacement");
      await fs.rename(temporary, file);
    } else {
      await fs.unlink(file);
    }
    await reconcile();
    expect(getSkillsResourceVersion(fixture.workspaceDir)).toBeGreaterThan(before);
    expect(getSkillsSourceVersion(fixture.workspaceDir)).toBe(sourceVersion);
    expect(changed).not.toHaveBeenCalled();
  }
  await fs.mkdir(file);
  await reconcile();
  expect(getSkillsSourceVersion(fixture.workspaceDir)).toBeGreaterThan(sourceVersion);
});

it("observes admitted symlink targets and removes them from cached discovery on unlink", async () => {
  const target = await fixture.createFixtureDirectory("outside");
  const dir = path.join(target, "guide");
  await writeSkill({ dir, name: "guide", description: "Linked instructions" });
  const link = path.join(fixture.workspaceDir, "skills", "linked");
  await fs.symlink(target, link, linkType);
  await ensure();
  expect(read()).toEqual([]);
  const config = { skills: { load: { allowSymlinkTargets: [target] } } };
  await ensure(config);
  expect(read(config)).toEqual(["Linked instructions"]);
  await writeSkill({ dir, name: "guide", description: "Edited target" });
  await reconcile();
  expect(read(config)).toEqual(["Edited target"]);
  const observation = pathWatchers.get(toWatchRoot(target));
  expect(observation).toBeDefined();
  await fs.unlink(link);
  await reconcile();
  expect(read(config)).toEqual([]);
  await ensure(config);
  expect(observation?.closed).toBe(true);
});

it("settles an atomic SKILL.md replacement until the writer stops changing it", async () => {
  const dir = path.join(fixture.workspaceDir, "skills", "guide");
  await writeSkill({ dir, name: "guide", description: "Original" });
  await ensure();
  expect(read()).toEqual(["Original"]);
  const changed = vi.fn();
  refresh.registerSkillsChangeListener(changed);
  await fs.unlink(path.join(dir, "SKILL.md"));
  await writeSkill({ dir, name: "guide", description: "Still writing" });
  await Promise.all(subscriptions.map((subscription) => subscription.reconcile()));
  await advance(0);
  await advance(100);
  await advance(100);
  expect(changed).not.toHaveBeenCalled();
  await writeSkill({ dir, name: "guide", description: "Finished" });
  await Promise.all(subscriptions.map((subscription) => subscription.reconcile()));
  // The in-flight window samples again in 50 ms, then restarts its 250 ms settling.
  await advance(50);
  for (const elapsed of [100, 100, 50]) {
    await advance(elapsed);
  }
  expect(changed).not.toHaveBeenCalled();
  await advance(250);
  expect(read()).toEqual(["Finished"]);
  expect(changed).toHaveBeenCalledOnce();
});

it.each(["directory", "blocking file"] as const)(
  "replans a %s replaced between source planning and the first scan",
  async (kind) => {
    const root = path.join(fixture.workspaceDir, "skills");
    const target = await fixture.createFixtureDirectory("startup-target");
    const config = { skills: { load: { allowSymlinkTargets: [target] } } };
    if (kind === "blocking file") {
      await fs.rmdir(root);
      await fs.writeFile(root, "blocked");
    }
    const owner = await import("./refresh-observation-source.js");
    const plan = vi.mocked(owner.skillsObservationScope).getMockImplementation()!;
    let replaced = false;
    vi.mocked(owner.skillsObservationScope).mockImplementation((...args) => {
      const work = plan(...args).then(async (scope) => {
        if (path.resolve(args[1].path) === root && !replaced) {
          replaced = true;
          await fs.rm(root, { recursive: true });
          if (kind === "directory") {
            await fs.symlink(target, root, linkType);
          }
          await writeSkill({
            dir: path.join(root, "guide"),
            name: "guide",
            description: "At startup",
          });
        }
        return scope;
      });
      planning.push(work);
      return work;
    });
    await ensure(config);
    expect(replaced).toBe(true);
    expect(read(config)).toEqual(["At startup"]);
    await writeSkill({
      dir: path.join(root, "guide"),
      name: "guide",
      description: "After startup",
    });
    await reconcile();
    expect(read(config)).toEqual(["After startup"]);
  },
);
