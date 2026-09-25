import path from "node:path";
import type { WatchEntry } from "@openclaw/fs-safe/watch";
import { expect, it, vi } from "vitest";
import { getSkillsResourceVersion, getSkillsSourceVersion } from "./refresh-state.js";
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

async function start() {
  refresh.ensureSkillsWatcher({ workspaceDir: fixture.workspaceDir });
  await observer.readyAll();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
  const sourceRoot = path.join(fixture.workspaceDir, "skills");
  const watcher = observer.forRoot(sourceRoot);
  const absolute = path.join(sourceRoot, "guide", "README.md");
  const relative = path.relative(watcher.authority.rootDir, absolute);
  const begin = (kind?: WatchEntry["kind"]) => {
    watcher.options.onHealth?.({ ...watcher.subscription.health(), state: "reconciling" });
    if (kind) {
      watcher.options.exclude?.({ path: relative, kind });
    }
  };
  const ready = () =>
    watcher.options.onHealth?.({ ...watcher.subscription.health(), state: "ready" });
  return { watcher, absolute, relative, begin, ready };
}

it.each([
  ["creation", undefined, "file"],
  ["deletion", "file", undefined],
  ["atomic replacement", "file", "file"],
] as const)(
  "keeps regular supporting-file %s out of source invalidation",
  async (_name, before, after) => {
    const f = await start();
    f.begin(before);
    f.ready();
    const sourceVersion = getSkillsSourceVersion(fixture.workspaceDir);
    const resourceVersion = getSkillsResourceVersion(fixture.workspaceDir);
    f.begin(after);
    f.watcher.change(f.absolute, "structural");
    f.ready();
    await vi.advanceTimersByTimeAsync(250);
    expect(getSkillsSourceVersion(fixture.workspaceDir)).toBe(sourceVersion);
    expect(getSkillsResourceVersion(fixture.workspaceDir)).toBeGreaterThan(resourceVersion);
  },
);

it.each([
  ["directory becomes file", "directory", "file"],
  ["file becomes directory", "file", "directory"],
  ["link becomes file", "symlink", "file"],
  ["unknown entry", undefined, undefined],
] as const)("retains discovery invalidation when %s", async (_name, before, after) => {
  const f = await start();
  f.begin(before);
  f.ready();
  const sourceVersion = getSkillsSourceVersion(fixture.workspaceDir);
  f.begin(after);
  f.watcher.change(f.absolute, "structural");
  f.ready();
  await vi.advanceTimersByTimeAsync(250);
  expect(getSkillsSourceVersion(fixture.workspaceDir)).toBeGreaterThan(sourceVersion);
});

it("preserves whole-scope invalidation and bounds optional entry-kind detail", async () => {
  const f = await start();
  f.begin("file");
  f.ready();
  const sourceVersion = getSkillsSourceVersion(fixture.workspaceDir);
  f.begin("file");
  f.watcher.dirty(undefined, "overflow");
  f.ready();
  await vi.advanceTimersByTimeAsync(250);
  expect(getSkillsSourceVersion(fixture.workspaceDir)).toBeGreaterThan(sourceVersion);

  const afterUnknown = getSkillsSourceVersion(fixture.workspaceDir);
  f.begin("file");
  for (let index = 0; index < 4096; index += 1) {
    f.watcher.options.exclude?.({
      path: path.join(path.dirname(f.relative), "support-" + index),
      kind: "file",
    });
  }
  // Unknown kinds after the finite detail budget cannot suppress discovery.
  f.watcher.change(f.absolute, "structural");
  f.ready();
  await vi.advanceTimersByTimeAsync(250);
  expect(getSkillsSourceVersion(fixture.workspaceDir)).toBeGreaterThan(afterUnknown);
});
