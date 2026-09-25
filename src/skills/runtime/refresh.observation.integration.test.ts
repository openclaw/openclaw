import fs from "node:fs/promises";
import path from "node:path";
import type { WatchFunction } from "@openclaw/fs-safe/watch";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { loadWorkspaceSkills } from "../loading/workspace-skill-loader.js";
import { resolveWorkspaceSkillSourcePlan } from "../loading/workspace-skill-sources.js";
import { writeSkill } from "../test-support/e2e-test-helpers.js";
import { useSkillsWatcherFixture } from "./refresh.watcher.test-support.js";

const starts: Promise<void>[] = [];
vi.mock("@openclaw/fs-safe/watch", async () => {
  const { createRequire } = await import("node:module");
  // Keep the private Root registry in the same native module graph as /root.
  const actual = createRequire(import.meta.url)(
    "@openclaw/fs-safe/watch",
  ) as typeof import("@openclaw/fs-safe/watch");
  const watch: WatchFunction = (root, options) => {
    // Keep the consumer mode and real engine; a periodic fallback must not
    // make this native-delivery regression green.
    const subscription = actual.watch(root, { ...options, intervalMs: 2_147_483_647 });
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

// A real later edit must cross native notification -> domain invalidation ->
// cached loader. Explicit reconcile() and synthetic hints cannot prove this flow.
it
  .runIf(process.platform === "linux" && !process.versions.bun && !process.versions.deno)
  .each(["root", "workspace"] as const)(
  "observes a later native edit after replacing the %s",
  async (replacement) => {
    starts.length = 0;
    vi.stubEnv("CHOKIDAR_USEPOLLING", "false");
    // Exclusions apply below each selected source, not to its admitted ancestors.
    const workspaceDir = await fixture.createFixtureDirectory(".cache/workspace");
    const sourceRoot = path.join(workspaceDir, "skills");
    const write = (description: string) =>
      writeSkill({ dir: path.join(sourceRoot, "guide"), name: "guide", description });
    await write("Original instructions");
    const owner = await import("./refresh-observation-source.js");
    const plan = owner.skillsObservationScope;
    const planning: Promise<unknown>[] = [];
    vi.spyOn(owner, "skillsObservationScope").mockImplementation((...args) => {
      const pending = plan(...args);
      planning.push(pending);
      return pending;
    });
    refresh.ensureSkillsWatcher({
      workspaceDir,
      sourcePlan: resolveWorkspaceSkillSourcePlan(workspaceDir, { workspaceOnly: true }),
    });
    await Promise.resolve();
    const { pathWatchers } = await import("./refresh-watch-registry.js");
    await Promise.all(
      [...pathWatchers.values()].flatMap((state) => (state.authority ? [state.authority] : [])),
    );
    await Promise.all(planning);
    await Promise.all(starts);
    const read = () =>
      loadWorkspaceSkills(workspaceDir, { workspaceOnly: true }).map(
        (entry) => entry.skill.description,
      );
    expect(read()).toEqual(["Original instructions"]);
    let expected = "Replacement instructions";
    let changed = createDeferred();
    const unsubscribe = refresh.registerSkillsChangeListener((event) => {
      if (event.workspaceDir !== workspaceDir) {
        return;
      }
      try {
        if (read().includes(expected)) {
          changed.resolve();
        }
      } catch (error) {
        changed.reject(error);
      }
    });
    try {
      await fs.rename(
        replacement === "root" ? sourceRoot : workspaceDir,
        path.join(fixture.root, "retired"),
      );
      await write(expected);
      await changed.promise;
      expect(read()).toEqual([expected]);
      expected = "Later independent edit";
      changed = createDeferred();
      await write(expected);
      await changed.promise;
      expect(read()).toEqual([expected]);
    } finally {
      unsubscribe();
      await refresh.closeSkillsWatchers();
    }
  },
);
