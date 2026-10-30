import nativeFs, { writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { setImmediate as nextImmediate } from "node:timers/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { getTrackedWorkerPoolSnapshot } from "../../infra/worker-cpu.js";
import { WorkerTaskPool } from "../../infra/worker-task-pool.js";
import { resolveSkillDiscoveryLimits } from "../loading/skill-root-discovery.js";
import type { WorkspaceSkillSourceRequest } from "../loading/workspace-skill-sources.types.js";
import { writeSkill } from "../test-support/e2e-test-helpers.js";
import { completePassiveScan } from "./discovery.test-support.js";
import * as remoteRefresh from "./refresh-remote.js";
import { getSkillsResourceVersion, getSkillsSnapshotVersion } from "./refresh-state.js";
import {
  closeSkillsWatchers,
  ensureSkillsWatcher,
  prepareLocalSkillSources,
  prepareSkillSourcePlan,
  projectSkillSnapshot,
  refreshSkillsDiscovery,
} from "./refresh.js";

const temporary = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    vi.restoreAllMocks();
    await closeSkillsWatchers(true);
    vi.unstubAllEnvs();
    vi.useRealTimers();
    cleanup();
  }),
);
let workspace: string;
beforeEach(() => {
  workspace = temporary.make("skills-discovery-");
  vi.useFakeTimers({
    toFake: ["Date", "performance", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
  });
  vi.setSystemTime(0);
});
function request(dir = workspace): WorkspaceSkillSourceRequest {
  const skills = path.join(dir, "skills");
  return {
    sourcePlan: {
      workspaceDir: dir,
      roots: [{ dir: skills, source: "openclaw-workspace", tier: "workspace" }],
      pluginSkillRoots: [],
      managedSkillsDir: skills,
    },
    limits: resolveSkillDiscoveryLimits(),
    additionalBins: [],
  };
}
const descriptions = async (input = request(), watch = true) =>
  (await prepareLocalSkillSources(input, { watch })).entries.map(
    (entry) => entry.skill.description,
  );
const write = (description: string, dir = workspace, relative = "skills/guide") =>
  writeSkill({ dir: path.join(dir, relative), name: path.basename(relative), description });
async function waitForLiveWatch(directory: string, workspaceDir = workspace) {
  const version = getSkillsResourceVersion(workspaceDir);
  const marker = path.join(directory, ".watch-ready");
  // Native registration can miss startup writes. Establish the live stream before
  // the single edit under test; missed events are covered by safety reconciliation.
  const pulse = setInterval(() => writeFileSync(marker, "ready"), 100);
  try {
    await expect
      .poll(() => getSkillsResourceVersion(workspaceDir), { timeout: 10_000 })
      .toBeGreaterThan(version);
  } finally {
    clearInterval(pulse);
    await fs.rm(marker, { force: true });
  }
}
function trackSettlement(promise: Promise<unknown>) {
  const settled = vi.fn();
  void promise.then(settled, settled);
  return settled;
}
function pauseAfter<T extends unknown[]>(operation: (...args: T) => Promise<void>) {
  const entered = createDeferred();
  const released = createDeferred();
  return {
    entered: entered.promise,
    release: released.resolve,
    run: async (...args: T) => {
      await operation(...args);
      entered.resolve();
      await released.promise;
    },
  };
}
const discoveryPools = () =>
  getTrackedWorkerPoolSnapshot().workerPools.filter(
    (entry) => entry.script === "discovery.worker.js",
  );
const agentConfig = (entries: Record<string, { workspace: string }>) => ({
  agents: { entries },
  plugins: { enabled: false },
});
async function plannedSource(dir: string, options: Parameters<typeof prepareSkillSourcePlan>[1]) {
  const { plan, input } = await prepareSkillSourcePlan(dir, options);
  return {
    plan,
    read: () =>
      prepareLocalSkillSources(
        { ...request(dir), sourcePlan: plan, limits: resolveSkillDiscoveryLimits(options?.config) },
        { plan: { input } },
      ),
  };
}

it("publishes explicit additions, edits, and removals before refresh resolves", async () => {
  expect(await descriptions()).toEqual([]);
  for (const text of ["Added", "Edited", undefined]) {
    await (text ? write(text) : fs.rm(path.join(workspace, "skills"), { recursive: true }));
    await refreshSkillsDiscovery({ workspaceDir: workspace });
    expect(await descriptions()).toEqual(text ? [text] : []);
  }
});

it("serves published skills while discovery is scanning another workspace", async () => {
  await write("Published instructions");
  const source = request();
  expect(await descriptions(source)).toEqual(["Published instructions"]);
  const other = temporary.make("skills-pending-discovery-");
  await write("New workspace", other);
  const blocked = pauseAfter(() => Promise.resolve());
  // The wrapper below forwards the original receiver with apply.
  // oxlint-disable-next-line typescript/unbound-method
  const run = WorkerTaskPool.prototype.run;
  vi.spyOn(WorkerTaskPool.prototype, "run").mockImplementationOnce(async function (
    this: WorkerTaskPool<unknown, unknown>,
    ...args
  ) {
    await blocked.run();
    return run.apply(this, args);
  });
  const cold = descriptions(request(other));
  const coldSettled = trackSettlement(cold);
  let warm: Promise<string[]> | undefined;
  try {
    await blocked.entered;
    warm = descriptions(source);
    const warmSettled = trackSettlement(warm);
    await nextImmediate();
    expect(warmSettled).toHaveBeenCalledOnce();
    expect(coldSettled).not.toHaveBeenCalled();
    expect(await warm).toEqual(["Published instructions"]);
  } finally {
    blocked.release();
    await Promise.allSettled([warm, cold]);
  }
  expect(await cold).toEqual(["New workspace"]);
});

it("does no discovery work during five unchanged minutes", async () => {
  await descriptions();
  const tasks = vi.spyOn(WorkerTaskPool.prototype, "run");
  for (let minute = 0; minute < 5; minute++) {
    await vi.advanceTimersByTimeAsync(60_000);
    await Promise.all(tasks.mock.results.map((result) => result.value));
  }
  expect(tasks).not.toHaveBeenCalled();
});

it("discovers external edits without waiting for a periodic scan and shares one worker", async () => {
  vi.useRealTimers();
  const other = temporary.make("skills-discovery-other-");
  await write("Original");
  await write("Other original", other);
  expect(await descriptions()).toEqual(["Original"]);
  expect(await descriptions(request(other))).toEqual(["Other original"]);
  await waitForLiveWatch(path.join(workspace, "skills"));
  await waitForLiveWatch(path.join(other, "skills"), other);
  expect(discoveryPools()).toEqual([expect.objectContaining({ workerCount: 1 })]);
  await write("First");
  await write("Final");
  await write("Other", other);
  await expect.poll(() => descriptions(), { timeout: 10_000 }).toEqual(["Final"]);
  await expect.poll(() => descriptions(request(other)), { timeout: 10_000 }).toEqual(["Other"]);
});

it("observes edits inside an admitted external symlink target", async () => {
  vi.useRealTimers();
  const external = temporary.make("skills-external-target-");
  const target = path.join(external, "guide");
  await writeSkill({ dir: target, name: "guide", description: "Original target" });
  await fs.mkdir(path.join(workspace, "skills"));
  await fs.symlink(target, path.join(workspace, "skills", "guide"), "junction");
  const input = request();
  input.sourcePlan.allowSymlinkTargets = [external];
  expect(await descriptions(input)).toEqual(["Original target"]);
  await waitForLiveWatch(target);
  await writeSkill({ dir: target, name: "guide", description: "Edited target" });
  await expect.poll(() => descriptions(input), { timeout: 10_000 }).toEqual(["Edited target"]);
});

it("applies config refresh on the healthy worker and drops departed sources", async () => {
  const nextWorkspace = temporary.make("skills-config-successor-");
  const config = (dir: string) => agentConfig({ main: { workspace: dir } });
  const discoveryPool = () => discoveryPools()[0];
  await write("Original");
  await refreshSkillsDiscovery({ config: config(workspace), reason: "config-change" });
  expect(await descriptions()).toEqual(["Original"]);
  const originalPool = discoveryPool();
  expect(originalPool).toMatchObject({ workerCount: 1 });

  await write("Successor", nextWorkspace);
  await refreshSkillsDiscovery({ config: config(nextWorkspace), reason: "config-change" });
  expect(await descriptions(request(nextWorkspace))).toEqual(["Successor"]);
  expect(discoveryPool()).toEqual(originalPool);

  const retiredVersion = getSkillsSnapshotVersion(workspace);
  await write("Departed change");
  await write("Current change", nextWorkspace);
  await completePassiveScan();
  expect(getSkillsSnapshotVersion(workspace)).toBe(retiredVersion);
  expect(await descriptions(request(nextWorkspace))).toEqual(["Current change"]);
  await closeSkillsWatchers();
  expect(discoveryPool()).toBeUndefined();
});

it("batches fresh agent discovery without separate root-planning passes", async () => {
  const other = temporary.make("skills-batch-agent-");
  vi.stubEnv("OPENCLAW_BUNDLED_SKILLS_DIR", temporary.make("skills-batch-bundled-"));
  const config = agentConfig({ main: { workspace }, second: { workspace: other } });
  await Promise.all([write("Original"), write("Other", other)]);
  const tasks = vi.spyOn(WorkerTaskPool.prototype, "run");
  const instructions = async (workspaceDir: string, agentId: string) => {
    const prepared = await plannedSource(workspaceDir, { config, agentId });
    return (await prepared.read()).entries.find((entry) => entry.skill.name === "guide")?.skill
      .description;
  };
  for (const description of ["Original", "Edited"]) {
    await write(description);
    tasks.mockClear();
    await refreshSkillsDiscovery({ config, reason: "config-change" });
    expect(tasks).toHaveBeenCalledTimes(1);
    expect(await instructions(workspace, "main")).toBe(description);
    expect(await instructions(other, "second")).toBe("Other");
    expect(tasks).toHaveBeenCalledTimes(1);
  }
});

it.each([false, true])(
  "joins a concurrent reset before source registration (selected: %s)",
  async (selected) => {
    await write("Current instructions");
    const disposal = pauseAfter(remoteRefresh.disposeRemoteSkillsWatcher);
    const closing = pauseAfter(remoteRefresh.closeRemoteSkillsWatchers);
    vi.spyOn(remoteRefresh, "disposeRemoteSkillsWatcher").mockImplementationOnce(disposal.run);
    vi.spyOn(remoteRefresh, "closeRemoteSkillsWatchers").mockImplementationOnce(closing.run);
    const read = ensureSkillsWatcher({
      workspaceDir: workspace,
      ...(selected ? { sourcePlan: request().sourcePlan } : {}),
    });
    const settled = trackSettlement(read);
    let reset: Promise<void> | undefined;
    try {
      await disposal.entered;
      reset = refreshSkillsDiscovery({ reason: "config-change" });
      await closing.entered;
      disposal.release();
      await nextImmediate();
      expect(settled).not.toHaveBeenCalled();
      closing.release();
      await Promise.all([read, reset]);
      expect(await descriptions()).toEqual(["Current instructions"]);
    } finally {
      disposal.release();
      closing.release();
      await Promise.allSettled([read, reset]);
    }
  },
);

it("keeps each source environment while refreshing a reused worker's plans and prompt paths", async () => {
  const firstHome = temporary.make("skills-first-home-");
  const secondHome = temporary.make("skills-second-home-");
  const writeManaged = (home: string, text: string) => write(text, home, ".openclaw/skills/guide");
  const config = { plugins: { enabled: false }, skills: { load: { extraDirs: ["~/extra"] } } };
  const prepare = async (home: string, description: string) => {
    await writeManaged(home, description);
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);
    vi.stubEnv("OPENCLAW_HOME", path.join(home, "effective-home"));
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(home, ".openclaw"));
    vi.stubEnv("OPENCLAW_CONFIG_PATH", undefined);
    vi.stubEnv("OPENCLAW_BUNDLED_SKILLS_DIR", path.join(home, "bundled"));
    const planned = await plannedSource(workspace, { config });
    expect(planned.plan).toMatchObject({
      userHomeDir: home,
      stateDir: path.join(home, ".openclaw"),
      managedSkillsDir: path.join(home, ".openclaw", "skills"),
      bundledSkillsDir: path.join(home, "bundled"),
      roots: expect.arrayContaining([
        expect.objectContaining({ dir: path.join(home, "effective-home", "extra") }),
      ]),
    });
    const read = async () => (await planned.read()).entries.map(({ skill }) => skill.description);
    expect(await read()).toEqual([description]);
    return read;
  };
  const first = await prepare(firstHome, "First namespace");
  const second = await prepare(secondHome, "Second namespace");
  await write("Second workspace", secondHome);
  const workspaceSources = await prepareLocalSkillSources(request(secondHome));
  const snapshot = await projectSkillSnapshot({
    workspaceDir: workspace,
    eligible: workspaceSources.entries,
  });
  expect(snapshot.prompt).toContain("~/skills/guide/SKILL.md");
  expect(snapshot.prompt).not.toContain(secondHome);

  await writeManaged(firstHome, "First namespace updated");
  await completePassiveScan();
  expect(await first()).toEqual(["First namespace updated"]);
  expect(await second()).toEqual(["Second namespace"]);
});

it("keeps watch=false passive state fixed while explicit refresh remains immediate", async () => {
  expect(await descriptions(request(), false)).toEqual([]);
  await write("Explicit only");
  await vi.advanceTimersByTimeAsync(120_000);
  expect(await descriptions(request(), false)).toEqual([]);
  await refreshSkillsDiscovery({ workspaceDir: workspace });
  expect(await descriptions(request(), false)).toEqual(["Explicit only"]);
});

it("rediscovers replaced workspaces and roots that disappear and return", async () => {
  await write("Original");
  expect(await descriptions(request(), false)).toEqual(["Original"]);
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const watch = vi.spyOn(nativeFs, "watch");
  // Register the Windows observation on an already prepared source, so this
  // exercises its handle boundary without changing worker launch semantics.
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  try {
    expect(await descriptions()).toEqual(["Original"]);
  } finally {
    Object.defineProperty(process, "platform", platform);
  }
  expect(watch).toHaveBeenCalledOnce();
  expect(watch.mock.calls[0]![0]).toBe(workspace);
  await fs.rename(workspace, path.join(temporary.make("skills-retired-"), "workspace"));
  for (const description of ["Replacement", undefined, "Recreated"]) {
    await (description
      ? write(description)
      : fs.rm(path.join(workspace, "skills"), { recursive: true }));
    await completePassiveScan();
    expect(await descriptions()).toEqual(description ? [description] : []);
  }
});

it("refreshes supporting resources without publishing an unchanged catalog", async () => {
  await write("Stable catalog");
  await descriptions();
  const version = getSkillsSnapshotVersion(workspace);
  const resources = getSkillsResourceVersion(workspace);
  await fs.writeFile(path.join(workspace, "skills", "guide", "helper.txt"), "changed");
  await completePassiveScan();
  await descriptions();
  expect(getSkillsSnapshotVersion(workspace)).toBe(version);
  expect(getSkillsResourceVersion(workspace)).toBeGreaterThan(resources);
});

it("invalidates an evicted workspace before accepting its next snapshot", async () => {
  await write("Original");
  const input = request();
  expect(await descriptions(input)).toEqual(["Original"]);
  const version = getSkillsSnapshotVersion(workspace);
  await Promise.all(
    Array.from({ length: 128 }, (_, index) => {
      const sourcePlan = {
        ...input.sourcePlan,
        workspaceDir: path.join(workspace, String(index)),
        roots: [],
      };
      return prepareLocalSkillSources({ ...input, sourcePlan });
    }),
  );
  expect(getSkillsSnapshotVersion(workspace)).toBeGreaterThan(version);
  await write("Changed while evicted");
  expect(await descriptions(input)).toEqual(["Changed while evicted"]);
});

it("discovers new agent-plugin children during the passive worker pass", async () => {
  const pluginRoot = path.join(workspace, "plugin");
  const skillRoot = path.join(pluginRoot, "skills");
  await write("First", skillRoot, "first");
  const input = request();
  const prepared = await prepareSkillSourcePlan(workspace, {
    config: { plugins: { enabled: false } },
    managedSkillsDir: path.join(workspace, "managed"),
    bundledSkillsDir: "",
    pluginSkillsDir: path.join(workspace, "plugin-links"),
  });
  const plan = {
    input: {
      ...prepared.input,
      pluginContributions: [
        {
          id: "fixture",
          origin: "workspace" as const,
          rootDir: pluginRoot,
          bundleFormat: "agent" as const,
          roots: ["skills"],
        },
      ],
    },
  };
  const names = async () =>
    (await prepareLocalSkillSources(input, { plan })).entries.map((entry) => entry.skill.name);
  expect(await names()).toContain("first");
  expect(await names()).not.toContain("second");
  await write("Second", skillRoot, "second");
  await completePassiveScan();
  expect(await names()).toContain("second");
});
