import path from "node:path";

// A file that leaves real skills watchers open must fail its own teardown, and the
// runner must close those watchers before the next file can install a fake clock,
// including generations a test erased with vi.resetModules() or shadowed by a
// same-file instance.
export function skillsWatcherFixtureFiles(
  repoRoot: string,
  fixtureRoot: string,
): Record<string, string> {
  const sourcePath = (name: string) => JSON.stringify(path.join(repoRoot, "src", name));
  const workspaceRoot = JSON.stringify(path.join(fixtureRoot, "skills-watcher-workspaces"));
  return {
    "12-a-skills-watcher-leak.test.ts": `import { mkdirSync } from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
it("starts real skills watchers and resets modules before returning", async () => {
  const registries = [];
  for (const name of ["first", "second"]) {
    vi.resetModules();
    const { ensureSkillsWatcher } = await import(${sourcePath("skills/runtime/refresh.ts")});
    const registry = await import(${sourcePath("skills/runtime/refresh-watch-registry.ts")});
    const workspaceDir = path.join(${workspaceRoot}, name);
    mkdirSync(path.join(workspaceDir, "skills"), { recursive: true });
    ensureSkillsWatcher({ workspaceDir, config: {} });
    expect(registry.workspaceWatchOwners.size).toBe(1);
    expect(registry.pathWatchers.size).toBeGreaterThan(0);
    // A same-file instance with empty maps must not hide the live registry.
    const shadow = await import(${sourcePath("skills/runtime/refresh-watch-registry.ts")} + "?shadow-" + name);
    expect(shadow.pathWatchers).not.toBe(registry.pathWatchers);
    expect(shadow.pathWatchers.size).toBe(0);
    registries.push(registry);
  }
  vi.resetModules();
  Reflect.set(globalThis, Symbol.for("fixture.leakedSkillsWatchRegistries"), registries);
});
`,
    "12-b-skills-watcher-observer.test.ts": `import { expect, it } from "vitest";
it("starts after the runner closed every prior skills watcher generation", () => {
  const key = Symbol.for("fixture.leakedSkillsWatchRegistries");
  const registries = Reflect.get(globalThis, key);
  Reflect.deleteProperty(globalThis, key);
  expect(registries, "leak fixture must run first").toHaveLength(2);
  for (const registry of registries) {
    expect(registry.workspaceWatchOwners.size).toBe(0);
    expect(registry.pathWatchers.size).toBe(0);
  }
});
`,
  };
}
