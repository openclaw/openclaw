import fs from "node:fs/promises";
import path from "node:path";
import type { WatchSubscription } from "@openclaw/fs-safe/watch";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { loadWorkspaceSkills } from "../loading/workspace-skill-loader.js";
import { resolveWorkspaceSkillSourcePlan } from "../loading/workspace-skill-sources.js";
import { writeSkill } from "../test-support/e2e-test-helpers.js";
import { useSkillsWatcherFixture } from "./refresh.watcher.test-support.js";

const starts: Promise<void>[] = [];
const subscriptions: WatchSubscription[] = [];
vi.mock("@openclaw/fs-safe/watch", async () => {
  const { createRequire } = await import("node:module");
  // Keep the private Root registry in the same native module graph as /root.
  const actual = createRequire(import.meta.url)(
    "@openclaw/fs-safe/watch",
  ) as typeof import("@openclaw/fs-safe/watch");
  const watch: typeof actual.watch = (root, options) => {
    // Native proof disables periodic repair. Explicit polling proof uses real
    // scans on hosts whose event service is unavailable; it cannot claim events.
    const subscription = actual.watch(root, {
      ...options,
      intervalMs: options.mode === "poll" ? 100 : 2_147_483_647,
    });
    starts.push(subscription.ready);
    subscriptions.push(subscription);
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

// Real observation must reach cached loading without synthetic hints or manual
// reconcile(). Polling is an explicit qualification mode, never a native fallback.
it
  .runIf(
    ["linux", "darwin", "win32"].includes(process.platform) &&
      !process.versions.bun &&
      !process.versions.deno,
  )
  .each(["root", "workspace"] as const)(
  "observes a later edit after replacing the %s",
  async (replacement) => {
    starts.length = 0;
    subscriptions.length = 0;
    const mode = process.env.OPENCLAW_WATCH_PROOF_MODE === "poll" ? "poll" : "events";
    vi.stubEnv("CHOKIDAR_USEPOLLING", mode === "poll" ? "true" : "false");
    vi.stubEnv("CHOKIDAR_INTERVAL", "100");
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
    expect(subscriptions.length).toBeGreaterThan(0);
    expect(subscriptions.every((subscription) => subscription.health().mode === mode)).toBe(true);
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
        if (expected ? read().includes(expected) : read().length === 0) {
          changed.resolve();
        }
      } catch (error) {
        changed.reject(error);
      }
    });
    try {
      if (process.platform === "win32" && replacement === "workspace") {
        // Windows forbids renaming an ancestor of an open directory handle.
        // Move the observed child first, then replace its workspace without
        // closing observation or skipping the later independent edit proof.
        await fs.rename(sourceRoot, path.join(fixture.root, "retired-skills"));
      }
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
      changed = createDeferred();
      expected = "";
      await fs.rm(sourceRoot, { recursive: true });
      await changed.promise;
      expect(read()).toEqual([]);
    } finally {
      unsubscribe();
      await refresh.closeSkillsWatchers();
      expect(subscriptions.every((subscription) => subscription.health().state === "closed")).toBe(
        true,
      );
    }
    console.log(
      JSON.stringify({
        owner: "skills",
        platform: process.platform,
        mode,
        edit: true,
        delete: true,
        replacement,
        closed: true,
      }),
    );
  },
);
