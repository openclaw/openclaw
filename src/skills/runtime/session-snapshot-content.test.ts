import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { WorkerTaskPool } from "../../infra/worker-task-pool.js";
import { writeSkill } from "../test-support/e2e-test-helpers.js";
import { getSkillsSnapshotVersion, registerSkillsChangeListener } from "./refresh-state.js";
import { closeSkillsWatchers, refreshSkillsDiscovery } from "./refresh.js";
import { resolveReusableWorkspaceSkillSnapshot as resolveSnapshot } from "./session-snapshot.js";

let workspaceDir: string;
let skillDir: string;
let home: string;
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeSkillsWatchers(true);
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    cleanup();
  }),
);
beforeEach(() => {
  home = tempDirs.make("skills-content-home-");
  workspaceDir = tempDirs.make("skills-content-");
  skillDir = path.join(workspaceDir, "skills", "demo");
  for (const [key, value] of Object.entries({
    HOME: home,
    USERPROFILE: home,
    OPENCLAW_HOME: home,
    OPENCLAW_STATE_DIR: workspaceDir,
    OPENCLAW_BUNDLED_SKILLS_DIR: path.join(home, "bundled-skills"),
    OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(home, "plugins"),
  })) {
    vi.stubEnv(key, value);
  }
  vi.useFakeTimers({
    toFake: ["Date", "performance", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
  });
  vi.setSystemTime(0);
});
const config = { plugins: { enabled: false } };
type SnapshotParams = Parameters<typeof resolveSnapshot>[0];
const writeDemo = (dir: string, description: string, body?: string) =>
  writeSkill({ dir, name: "demo", description, body });
const readSnapshot = (
  existingSnapshot?: SnapshotParams["existingSnapshot"],
  overrides: Partial<SnapshotParams> = {},
) => resolveSnapshot({ workspaceDir, config, existingSnapshot, ...overrides });
type SnapshotResult = Awaited<ReturnType<typeof readSnapshot>>;
const hash = (result: SnapshotResult) => result.snapshot.resolvedSkills?.[0]?.contentHash;
const skillFile = (result: SnapshotResult) => result.snapshot.resolvedSkills?.[0]?.filePath;
function expectUnchanged(result: SnapshotResult, previous: SnapshotResult) {
  expect(result.snapshot).toBe(previous.snapshot);
  expect(result.shouldRefresh).toBe(false);
}

async function completePassiveScan() {
  const tasks = vi.spyOn(WorkerTaskPool.prototype, "run");
  try {
    let settledTasks = 0;
    for (let elapsed = 0; elapsed < 30 * 60_000 + 50; elapsed += 60_000) {
      await vi.advanceTimersByTimeAsync(Math.min(60_000, 30 * 60_000 + 50 - elapsed));
      // Native events during a scan can start another pass before publication.
      while (settledTasks < tasks.mock.results.length) {
        const pending = tasks.mock.results.slice(settledTasks);
        settledTasks += pending.length;
        await Promise.all(pending.map((result) => result.value));
      }
    }
  } finally {
    tasks.mockRestore();
  }
}

it("honors a per-call passive refresh opt-out without disabling another observer", async () => {
  vi.stubEnv("OPENCLAW_STATE_DIR", path.join(home, "state"));
  const read = (existingSnapshot?: SnapshotParams["existingSnapshot"], watch = false) =>
    readSnapshot(existingSnapshot, { watch });
  await writeDemo(skillDir, "Original");
  const original = await read();
  await writeDemo(skillDir, "Passive change");
  await completePassiveScan();
  const unobserved = await read(original.snapshot);
  expect(unobserved.snapshot).toBe(original.snapshot);

  await read(undefined, true);
  await read();
  const published = new Promise<void>((resolve) => {
    const unregister = registerSkillsChangeListener((event) => {
      if (event.workspaceDir === workspaceDir && event.reason === "watch") {
        unregister();
        resolve();
      }
    });
  });
  await completePassiveScan();
  await published;
  const observed = await read(original.snapshot);
  expect(observed.shouldRefresh).toBe(true);
  expect(observed.snapshot.prompt).toContain("Passive change");
});

it("reuses session snapshots after unchanged rebuilds and refreshes instruction-only edits", async () => {
  await writeDemo(skillDir, "Demo", "Original body");
  const first = await readSnapshot();
  const version = getSkillsSnapshotVersion(workspaceDir);
  const changed = vi.fn();
  const unregister = registerSkillsChangeListener(changed);
  try {
    await completePassiveScan();
    const next = await readSnapshot(first.snapshot);
    expect(getSkillsSnapshotVersion(workspaceDir)).toBe(version);
    expectUnchanged(next, first);
    expect(changed).not.toHaveBeenCalled();
    await fs.appendFile(path.join(skillDir, "SKILL.md"), "\nNew instructions\n");
    await completePassiveScan();
    const edited = await readSnapshot(first.snapshot);
    expect(edited.shouldRefresh).toBe(true);
    expect(edited.snapshot.version).toBeGreaterThan(version);
    expect(edited.snapshot.prompt).toBe(first.snapshot.prompt);
    expect(hash(edited)).not.toBe(hash(first));
    expect(changed).toHaveBeenCalledOnce();
  } finally {
    unregister();
  }
});

it("refreshes changed installed skill identities even when instructions are identical", async () => {
  await writeDemo(skillDir, "Demo");
  const originDir = path.join(skillDir, ".openclaw");
  const originFile = path.join(originDir, "source-origin.json");
  await fs.mkdir(originDir);
  await fs.writeFile(originFile, JSON.stringify({ slug: "demo-original" }));
  const first = await readSnapshot();
  expect(first.snapshot.skills[0]?.skillKey).toBe("demo-original");
  await fs.writeFile(originFile, JSON.stringify({ slug: "demo-renamed" }));
  await refreshSkillsDiscovery({ workspaceDir });
  const next = await readSnapshot(first.snapshot);
  expect(next.shouldRefresh).toBe(true);
  expect(next.snapshot.skills[0]?.skillKey).toBe("demo-renamed");
  expect(hash(next)).toBe(hash(first));
});

it("keeps execution workspace content isolated while refreshing active sessions", async () => {
  const firstDir = path.join(workspaceDir, "first");
  const secondDir = path.join(workspaceDir, "second");
  const firstSkillDir = path.join(firstDir, "skills", "demo");
  const secondSkillDir = path.join(secondDir, "skills", "demo");
  const firstParams = { executionWorkspaceDir: path.relative(process.cwd(), firstDir) };
  const secondParams = { executionWorkspaceDir: secondDir };
  await writeDemo(firstSkillDir, "First scope");
  await writeDemo(secondSkillDir, "Second scope");
  const first = await readSnapshot(undefined, firstParams);
  const second = await readSnapshot(undefined, secondParams);
  await writeDemo(firstSkillDir, "Changed first scope");
  await refreshSkillsDiscovery({ workspaceDir });
  const refreshed = await readSnapshot(first.snapshot, firstParams);
  const unrelated = await readSnapshot(second.snapshot, secondParams);
  expect(refreshed.snapshot.prompt).toContain("Changed first scope");
  expect(unrelated.snapshot.prompt).toContain("Second scope");
  expect(unrelated.snapshot.prompt).not.toContain("Changed first scope");
  expect(skillFile(unrelated)).toBe(path.join(secondSkillDir, "SKILL.md"));
});

it("uses incoming roots before deciding whether a warm session can be reused", async () => {
  const firstRoot = path.join(workspaceDir, "first");
  const secondRoot = path.join(workspaceDir, "second");
  await writeDemo(path.join(firstRoot, "demo"), "Before");
  await writeDemo(path.join(secondRoot, "demo"), "After");
  const rootConfig = (root: string) => ({
    ...config,
    agents: { defaults: { workspace: workspaceDir } },
    skills: { load: { extraDirs: [root] } },
  });
  const nextConfig = rootConfig(secondRoot);
  const first = await readSnapshot(undefined, { config: rootConfig(firstRoot) });
  await refreshSkillsDiscovery({ workspaceDir, reason: "config-change", config: nextConfig });
  const next = await readSnapshot(first.snapshot, { config: nextConfig });
  expect(next.shouldRefresh).toBe(true);
  expect(next.snapshot.prompt).toContain("After");
  expect(next.snapshot.prompt).not.toContain("Before");
});

it("refreshes an existing session after its workspace is replaced", async () => {
  await writeDemo(skillDir, "Original workspace");
  const first = await readSnapshot();
  await fs.rename(workspaceDir, path.join(tempDirs.make("skills-content-old-"), "workspace"));
  await writeDemo(skillDir, "Replacement workspace");
  await completePassiveScan();
  const next = await readSnapshot(first.snapshot);
  expect(next.shouldRefresh).toBe(true);
  expect(next.snapshot.prompt).toContain("Replacement workspace");
  expect(next.snapshot.prompt).not.toContain("Original workspace");
  expect(skillFile(next)).toBe(path.join(skillDir, "SKILL.md"));
});

it("ignores losing skill edits but refreshes when the precedence winner disappears", async () => {
  const executionWorkspaceDir = path.join(workspaceDir, "worktree");
  const winner = path.join(workspaceDir, "skills", "demo");
  const loser = path.join(executionWorkspaceDir, "skills", "demo");
  await writeDemo(winner, "Winner");
  await writeDemo(loser, "Loser");
  const read = (existingSnapshot?: SnapshotParams["existingSnapshot"]) =>
    readSnapshot(existingSnapshot, { executionWorkspaceDir });
  const first = await read();
  expect(first.snapshot.prompt).toContain("Winner");
  const version = getSkillsSnapshotVersion(workspaceDir);
  await fs.appendFile(path.join(loser, "SKILL.md"), "\nChanged loser\n");
  await completePassiveScan();
  const unchanged = await read(first.snapshot);
  expect(getSkillsSnapshotVersion(workspaceDir)).toBe(version);
  expectUnchanged(unchanged, first);
  await fs.unlink(path.join(winner, "SKILL.md"));
  await completePassiveScan();
  const fallback = await read(first.snapshot);
  expect(getSkillsSnapshotVersion(workspaceDir)).toBeGreaterThan(version);
  expect(fallback.shouldRefresh).toBe(true);
  expect(fallback.snapshot.prompt).toContain("Loser");
  expect(skillFile(fallback)).toBe(path.join(loser, "SKILL.md"));
});
