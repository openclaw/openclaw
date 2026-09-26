import fs from "node:fs/promises";
import path from "node:path";
import type { WatchSubscription } from "@openclaw/fs-safe/watch";
import { expect, it, vi } from "vitest";
import { loadWorkspaceSkills } from "../loading/workspace-skill-loader.js";
import { resolveWorkspaceSkillSourcePlan } from "../loading/workspace-skill-sources.js";
import { writeSkill } from "../test-support/e2e-test-helpers.js";
import {
  useSkillsWatcherFixture,
  waitForSkillsWatcherTurn,
} from "./refresh.watcher.test-support.js";

const subscriptions: WatchSubscription[] = [];
const starts: Promise<void>[] = [];
vi.mock("@openclaw/fs-safe/watch", async () => {
  const { createRequire } = await import("node:module");
  // Keep the private Root registry in the same native module graph as /root.
  const actual = createRequire(import.meta.url)(
    "@openclaw/fs-safe/watch",
  ) as typeof import("@openclaw/fs-safe/watch");
  const watch: typeof actual.watch = (root, options) => {
    const subscription = actual.watch(root, {
      ...options,
      mode: "poll",
      intervalMs: 2_147_483_647,
    });
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

// Installed-package integration. Explicit reconciliation avoids OS-delivery sleeps;
// native event delivery/platform qualification remains the library's separate gate.
it.each(["missing", "root", "intermediate", "symbolic"] as const)(
  "reads a later edit after replacing a %s descendant",
  async (replacement) => {
    subscriptions.length = 0;
    starts.length = 0;
    const workspaceDir = fixture.workspaceDir;
    const root = path.join(workspaceDir, "skills");
    const write = (description: string) =>
      writeSkill({ dir: path.join(root, "guide"), name: "guide", description });
    const linked = await fixture.createFixtureDirectory("linked-target");
    if (replacement === "missing" || replacement === "symbolic") {
      await fs.rm(root, { recursive: true });
    }
    if (replacement === "symbolic") {
      await fs.symlink(linked, root, process.platform === "win32" ? "junction" : "dir");
    }
    if (replacement !== "missing") {
      await write("Original instructions");
    }
    const settling = await import("./refresh-file-stability.js");
    const createScheduler = settling.createSkillFileScheduler;
    const samples: Promise<unknown>[] = [];
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
    const settleContent = async () => {
      // Fake clock advancement does not complete real guarded filesystem I/O.
      // Join each sample before advancing the next actual settling interval.
      for (const delay of [0, 100, 100, 50]) {
        await vi.advanceTimersByTimeAsync(delay);
        await Promise.all(samples.splice(0));
      }
      await vi.advanceTimersByTimeAsync(250);
    };
    const owner = await import("./refresh-observation-source.js");
    const scope = owner.skillsObservationScope;
    const planning: Promise<unknown>[] = [];
    vi.spyOn(owner, "skillsObservationScope").mockImplementation((...args) => {
      const work = scope(...args);
      planning.push(work);
      return work;
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    const config = { skills: { load: { allowSymlinkTargets: [linked] } } };
    const sourcePlan = resolveWorkspaceSkillSourcePlan(workspaceDir, {
      workspaceOnly: true,
      config,
    });
    refresh.ensureSkillsWatcher({ workspaceDir, sourcePlan });
    await Promise.resolve();
    const { pathWatchers } = await import("./refresh-watch-registry.js");
    await Promise.all(
      [...pathWatchers.values()].flatMap((state) => (state.authority ? [state.authority] : [])),
    );
    await Promise.all(planning);
    await Promise.all(starts);
    const read = () =>
      loadWorkspaceSkills(workspaceDir, { workspaceOnly: true, config }).map(
        (entry) => entry.skill.description,
      );
    expect(read()).toEqual(replacement === "missing" ? [] : ["Original instructions"]);
    if (replacement === "symbolic") {
      await fs.unlink(root);
    }
    if (replacement === "root") {
      await fs.rename(root, path.join(workspaceDir, "old-skills"));
    }
    if (replacement === "intermediate") {
      await fs.rename(workspaceDir, path.join(fixture.root, "old-workspace"));
    }
    await write("Replacement instructions");
    const reconciled = await Promise.allSettled(
      subscriptions.map((subscription) => subscription.reconcile()),
    );
    for (const result of reconciled) {
      if (result.status === "rejected") {
        expect(replacement).toBe("symbolic");
        expect(result.reason).toMatchObject({ name: "AbortError" });
      }
    }
    await waitForSkillsWatcherTurn();
    await Promise.all(
      [...pathWatchers.values()].flatMap((state) => (state.authority ? [state.authority] : [])),
    );
    await Promise.all(planning);
    await Promise.all(starts);
    await vi.advanceTimersByTimeAsync(250);
    expect(read()).toEqual(["Replacement instructions"]);
    // Library reconciliation already emitted the domain hint; send no synthetic event.
    // Reconcile once with a fresh actual edit while the domain clock is controlled.
    await write("Later independent edit");
    await Promise.all(
      subscriptions
        .filter((subscription) => subscription.health().state === "ready")
        .map((subscription) => subscription.reconcile()),
    );
    await settleContent();
    expect(read()).toEqual(["Later independent edit"]);
    await fs.rm(root, { recursive: true });
    await write("Second replacement under the same parent");
    await Promise.all(
      subscriptions
        .filter((subscription) => subscription.health().state === "ready")
        .map((subscription) => subscription.reconcile()),
    );
    await vi.advanceTimersByTimeAsync(250);
    expect(read()).toEqual(["Second replacement under the same parent"]);
    await fs.rm(root, { recursive: true });
    await Promise.all(
      subscriptions
        .filter((subscription) => subscription.health().state === "ready")
        .map((subscription) => subscription.reconcile()),
    );
    await vi.advanceTimersByTimeAsync(250);
    expect(read()).toEqual([]);
    await refresh.closeSkillsWatchers();
    expect(subscriptions.every((subscription) => subscription.health().state === "closed")).toBe(
      true,
    );
  },
);
