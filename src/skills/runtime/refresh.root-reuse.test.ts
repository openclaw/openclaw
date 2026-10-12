import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import "../../test-utils/prepare-compiled-subprocesses.js";
import { writeSkill } from "../test-support/e2e-test-helpers.js";
import {
  createSkillsWatcherMock,
  useSkillsWatcherFixture,
} from "./refresh.watcher.test-support.js";

const observer = createSkillsWatcherMock();
const warnings = vi.hoisted(() => vi.fn());
vi.mock("@openclaw/fs-safe/watch", () => ({ watch: observer.watchMock }));
vi.mock("../../logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../logging/subsystem.js")>();
  return {
    ...actual,
    createSubsystemLogger: (subsystem: string) => {
      const logger = actual.createSubsystemLogger(subsystem);
      return subsystem === "skills" ? { ...logger, warn: warnings } : logger;
    },
  };
});
// mock-isolation: Keep plugin publication and its process-wide metadata outside this fixture.
vi.mock("../loading/plugin-skills.js", () => ({
  resolvePluginSkillRoots: vi.fn(() => []),
  resolvePluginSkillRootsFromMetadata: vi.fn(() => []),
}));
const fixture = useSkillsWatcherFixture(observer);

it("reuses quiet roots across unrelated invalidations and rescans changed or unverified roots", async () => {
  const discovery = await import("../loading/skill-root-discovery.js");
  const discover = vi.spyOn(discovery, "discoverSkillCandidates");
  const { loadWorkspaceSkills } = await import("../loading/workspace-skill-loader.js");
  const { ensureSkillsWatcher } = await import("./refresh.js");
  const { bumpSkillsSnapshotVersion } = await import("./refresh-state.js");
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
  warnings.mockClear();
  const workspaceDir = fixture.workspaceDir;
  const shared = await fixture.createFixtureDirectory("shared");
  const outside = await fixture.createFixtureDirectory("outside");
  const trusted = await fixture.createFixtureDirectory("trusted");
  await writeSkill({ dir: path.join(shared, "real"), name: "real", description: "Real skill" });
  await writeSkill({ dir: outside, name: "escaped", description: "Escaped skill" });
  await fs.symlink(outside, path.join(shared, "escaped"), "junction");
  const config = { skills: { load: { extraDirs: [shared], allowSymlinkTargets: [trusted] } } };
  const load = () => loadWorkspaceSkills(workspaceDir, { config }).map(({ skill }) => skill.name);
  const discoveryCount = () =>
    discover.mock.calls.filter(([params]) => params.dir === shared).length;
  const escapeWarnings = () =>
    warnings.mock.calls.filter(
      ([message, meta]) =>
        message === "Skipping escaped skill path outside its configured root." &&
        meta?.path === path.join(shared, "escaped"),
    );

  ensureSkillsWatcher({ workspaceDir, config });
  expect(load()).toContain("real");
  await observer.readyAll();
  expect(load()).toContain("real");
  const settledCount = discoveryCount();

  bumpSkillsSnapshotVersion({ reason: "remote-node" });
  expect(load()).toContain("real");
  expect(discoveryCount()).toBe(settledCount);

  const localSkill = path.join(workspaceDir, "skills", "local");
  await writeSkill({ dir: localSkill, name: "local", description: "Local skill" });
  observer.forRoot(path.join(workspaceDir, "skills")).change(localSkill, "structural");
  await vi.advanceTimersByTimeAsync(250);
  expect(load()).toEqual(expect.arrayContaining(["real", "local"]));
  expect(discoveryCount()).toBe(settledCount);
  expect(escapeWarnings()).toHaveLength(1);

  const addedSkill = path.join(shared, "added");
  await writeSkill({ dir: addedSkill, name: "added", description: "Added skill" });
  observer.forRoot(shared).change(addedSkill, "structural");
  await vi.advanceTimersByTimeAsync(250);
  expect(load()).toEqual(expect.arrayContaining(["real", "added"]));
  expect(discoveryCount()).toBe(settledCount + 1);
  expect(escapeWarnings()).toHaveLength(1);

  // A new allowed symlink can reach a directory the plan does not watch yet.
  const linkedSkill = path.join(trusted, "linked");
  await writeSkill({ dir: linkedSkill, name: "linked", description: "Linked skill" });
  await fs.symlink(linkedSkill, path.join(shared, "linked"), "junction");
  observer.forRoot(shared).change(path.join(shared, "linked"), "structural");
  await vi.advanceTimersByTimeAsync(250);
  expect(load()).toContain("linked");
  const linkedCount = discoveryCount();
  bumpSkillsSnapshotVersion({ reason: "remote-node" });
  expect(load()).toContain("linked");
  expect(discoveryCount()).toBe(linkedCount + 1);

  ensureSkillsWatcher({ workspaceDir, config });
  await observer.readyAll();
  bumpSkillsSnapshotVersion({ reason: "remote-node" });
  load();
  const replannedCount = discoveryCount();
  bumpSkillsSnapshotVersion({ reason: "remote-node" });
  expect(load()).toContain("linked");
  expect(discoveryCount()).toBe(replannedCount);

  // A link inside the root can expose a skill below the root's bounded watch depth.
  const deepSkill = path.join(shared, "a", "b", "c", "deep");
  await writeSkill({ dir: deepSkill, name: "deep", description: "Deep skill" });
  await fs.symlink(deepSkill, path.join(shared, "deep"), "junction");
  observer.forRoot(shared).change(path.join(shared, "deep"), "structural");
  await vi.advanceTimersByTimeAsync(250);
  expect(load()).toContain("deep");
  const deepCount = discoveryCount();
  bumpSkillsSnapshotVersion({ reason: "remote-node" });
  expect(load()).toContain("deep");
  expect(discoveryCount()).toBe(deepCount + 1);

  // A dangling allowed link has no observable destination; its later creation must still show up.
  const pendingSkill = path.join(trusted, "pending");
  await fs.symlink(pendingSkill, path.join(shared, "pending"), "junction");
  observer.forRoot(shared).change(path.join(shared, "pending"), "structural");
  await vi.advanceTimersByTimeAsync(250);
  ensureSkillsWatcher({ workspaceDir, config });
  await observer.readyAll();
  load();
  await writeSkill({ dir: pendingSkill, name: "pending", description: "Pending skill" });
  bumpSkillsSnapshotVersion({ reason: "remote-node" });
  expect(load()).toContain("pending");

  // Watchers do not observe intermediate links, so a retargeted chain must not be served stale.
  for (const version of ["v1", "v2"]) {
    await writeSkill({
      dir: path.join(trusted, `chain-${version}`),
      name: `chain-${version}`,
      description: `Chain ${version}`,
    });
  }
  const current = path.join(trusted, "current");
  await fs.symlink(path.join(trusted, "chain-v1"), current, "junction");
  await fs.symlink(current, path.join(shared, "chain"), "junction");
  observer.forRoot(shared).change(path.join(shared, "chain"), "structural");
  await vi.advanceTimersByTimeAsync(250);
  await observer.readyAll();
  expect(load()).toContain("chain-v1");
  await fs.rm(current);
  await fs.symlink(path.join(trusted, "chain-v2"), current, "junction");
  bumpSkillsSnapshotVersion({ reason: "remote-node" });
  expect(load()).toContain("chain-v2");
  await fs.rm(path.join(shared, "chain"));
  observer.forRoot(shared).change(path.join(shared, "chain"), "structural");
  await vi.advanceTimersByTimeAsync(250);
  await observer.readyAll();

  // A rejected chain can become admissible when an unwatched intermediate link moves.
  const hop = path.join(outside, "hop");
  await writeSkill({
    dir: path.join(trusted, "admitted"),
    name: "admitted",
    description: "Admitted",
  });
  await fs.symlink(outside, hop, "junction");
  await fs.symlink(hop, path.join(shared, "rejected"), "junction");
  observer.forRoot(shared).change(path.join(shared, "rejected"), "structural");
  await vi.advanceTimersByTimeAsync(250);
  await observer.readyAll();
  expect(load()).not.toContain("admitted");
  bumpSkillsSnapshotVersion({ reason: "remote-node" });
  expect(load()).not.toContain("admitted");
  await fs.rm(hop);
  await fs.symlink(path.join(trusted, "admitted"), hop, "junction");
  bumpSkillsSnapshotVersion({ reason: "remote-node" });
  expect(load()).toContain("admitted");
  await fs.rm(path.join(shared, "rejected"));
  observer.forRoot(shared).change(path.join(shared, "rejected"), "structural");
  await vi.advanceTimersByTimeAsync(250);
  await observer.readyAll();

  // Discovery inspects directories the watcher excludes; their results are never reused.
  const excluded = path.join(shared, "build");
  await fs.mkdir(excluded);
  bumpSkillsSnapshotVersion({ reason: "remote-node" });
  expect(load()).not.toContain("excluded");
  await writeSkill({ dir: excluded, name: "excluded", description: "Excluded" });
  bumpSkillsSnapshotVersion({ reason: "remote-node" });
  expect(load()).toContain("excluded");
  await fs.rm(excluded, { recursive: true });

  // A link that currently resolves to a file can later reach a skill through an unwatched hop.
  const fileHop = path.join(outside, "file-hop");
  await fs.writeFile(path.join(outside, "notes.txt"), "notes");
  await writeSkill({
    dir: path.join(trusted, "relinked"),
    name: "relinked",
    description: "Relinked",
  });
  await fs.symlink(path.join(outside, "notes.txt"), fileHop);
  await fs.symlink(fileHop, path.join(shared, "file-link"));
  observer.forRoot(shared).change(path.join(shared, "file-link"), "structural");
  await vi.advanceTimersByTimeAsync(250);
  await observer.readyAll();
  bumpSkillsSnapshotVersion({ reason: "remote-node" });
  expect(load()).not.toContain("relinked");
  await fs.rm(fileHop);
  await fs.symlink(path.join(trusted, "relinked"), fileHop, "junction");
  bumpSkillsSnapshotVersion({ reason: "remote-node" });
  expect(load()).toContain("relinked");
  await fs.rm(path.join(shared, "file-link"));
  observer.forRoot(shared).change(path.join(shared, "file-link"), "structural");
  await vi.advanceTimersByTimeAsync(250);
  await observer.readyAll();

  // An aliased SKILL.md changes through a name the watcher treats as a supporting file.
  const aliased = path.join(shared, "aliased");
  await fs.mkdir(aliased);
  const body = (name: string) => `---\nname: ${name}\ndescription: Aliased\n---\nbody\n`;
  await fs.writeFile(path.join(aliased, "body.md"), body("alias-v1"));
  await fs.symlink("body.md", path.join(aliased, "SKILL.md"));
  observer.forRoot(shared).change(aliased, "structural");
  await vi.advanceTimersByTimeAsync(250);
  await observer.readyAll();
  bumpSkillsSnapshotVersion({ reason: "remote-node" });
  expect(load()).toContain("alias-v1");
  await fs.writeFile(path.join(aliased, "body.md"), body("alias-v2"));
  observer.forRoot(shared).change(path.join(aliased, "body.md"), "content");
  await vi.advanceTimersByTimeAsync(250);
  bumpSkillsSnapshotVersion({ reason: "remote-node" });
  expect(load()).toContain("alias-v2");
  await fs.rm(aliased, { recursive: true });
  observer.forRoot(shared).change(aliased, "structural");
  await vi.advanceTimersByTimeAsync(250);
  await observer.readyAll();

  const beforeFailure = discoveryCount();
  observer.forRoot(shared).fail(new Error("boom"), { operation: "scan" });
  expect(load()).toEqual(expect.arrayContaining(["real", "added"]));
  expect(discoveryCount()).toBe(beforeFailure + 1);

  // Recovery republishes the root; reuse resumes once the replacement watcher is ready.
  await observer.readyAll();
  bumpSkillsSnapshotVersion({ reason: "remote-node" });
  load();
  const recoveredCount = discoveryCount();
  bumpSkillsSnapshotVersion({ reason: "remote-node" });
  load();
  expect(discoveryCount()).toBe(recoveredCount);
  expect(escapeWarnings()).toHaveLength(1);
});

it("retains rejected-file warnings across quiet root reuse and clears them after repair", async () => {
  const discovery = await import("../loading/skill-root-discovery.js");
  const discover = vi.spyOn(discovery, "discoverSkillCandidates");
  const { loadSkillRootRecords } = await import("../loading/skill-root-loader.js");
  const { loadWorkspaceSkillDiscovery } = await import("../loading/workspace-skill-loader.js");
  const settling = await import("./refresh-file-stability.js");
  const createScheduler = settling.createSkillFileScheduler;
  const samples: Promise<unknown>[] = [];
  vi.spyOn(settling, "createSkillFileScheduler").mockImplementation((options) =>
    createScheduler({
      ...options,
      sample(changedPath) {
        const work = options.sample(changedPath);
        samples.push(work);
        return work;
      },
    }),
  );
  const { ensureSkillsWatcher } = await import("./refresh.js");
  const { bumpSkillsSnapshotVersion } = await import("./refresh-state.js");
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
  const workspaceDir = fixture.workspaceDir;
  const root = path.join(workspaceDir, "skills");
  const broken = path.join(root, "broken");
  const brokenFile = path.join(broken, "SKILL.md");
  await writeSkill({ dir: path.join(root, "valid"), name: "valid", description: "Valid sibling" });
  await fs.mkdir(broken);
  await fs.writeFile(brokenFile, "---\nname: broken\n---\n");
  const config = { plugins: { enabled: false } };
  const options = { config, workspaceOnly: true };
  ensureSkillsWatcher({ workspaceDir, config });
  await observer.readyAll();
  // A runtime root read must retain warnings even when its caller only consumes records.
  expect(loadSkillRootRecords({ dir: root, source: "openclaw-workspace", config })).toHaveLength(1);
  const scans = () => discover.mock.calls.filter(([params]) => params.dir === root).length;
  const initialScans = scans();
  const load = () => loadWorkspaceSkillDiscovery(workspaceDir, options);
  const expected = {
    items: [{ kind: "invalid", path: brokenFile, message: "description is required" }],
    omitted: 0,
  };
  const first = load();
  expect(first.entries.map(({ skill }) => skill.name)).toEqual(["valid"]);
  expect(first.diagnostics).toEqual(expected);
  expect(scans()).toBe(initialScans);
  bumpSkillsSnapshotVersion({ reason: "remote-node" });
  expect(load().diagnostics).toEqual(expected);
  expect(scans()).toBe(initialScans);

  await writeSkill({ dir: broken, name: "broken", description: "Repaired skill" });
  observer.forRoot(root).change(brokenFile, "content");
  // Join real samples while advancing the existing settling/debounce clock.
  for (const elapsed of [0, 100, 100, 50, 250]) {
    await vi.advanceTimersByTimeAsync(elapsed);
    await Promise.all(samples.splice(0));
  }
  const repaired = load();
  expect(repaired.entries.map(({ skill }) => skill.name)).toEqual(["broken", "valid"]);
  expect(repaired.diagnostics).toEqual({ items: [], omitted: 0 });
  expect(scans()).toBe(initialScans + 1);
  expect(first.diagnostics).toEqual(expected);
});
