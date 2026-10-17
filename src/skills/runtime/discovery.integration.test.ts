import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { getTrackedWorkerPoolSnapshot } from "../../infra/worker-cpu.js";
import { WorkerTaskPool } from "../../infra/worker-task-pool.js";
import { resolveSkillDiscoveryLimits } from "../loading/skill-root-discovery.js";
import type { WorkspaceSkillSourceRequest } from "../loading/workspace-skill-sources.types.js";
import { writeSkill } from "../test-support/e2e-test-helpers.js";
import * as remoteRefresh from "./refresh-remote.js";
import { getSkillsResourceVersion, getSkillsSnapshotVersion } from "./refresh-state.js";
import {
  closeSkillsWatchers,
  ensureSkillsWatcher,
  prepareLocalSkillSources,
  prepareSkillSourcePlan,
  projectSkillSnapshot,
  refreshSkillsDiscovery,
  registerSkillsChangeListener,
} from "./refresh.js";

const temporary = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeSkillsWatchers(true);
    vi.unstubAllEnvs();
    vi.useRealTimers();
    cleanup();
  }),
);
let workspace: string;
beforeEach(async () => {
  workspace = temporary.make("skills-discovery-");
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
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
    limits: {
      maxCandidatesPerRoot: 300,
      maxSkillsLoadedPerSource: 200,
      maxSkillFileBytes: 256_000,
    },
    additionalBins: [],
  };
}
const descriptions = async (input = request(), watch = true) =>
  (await prepareLocalSkillSources(input, { watch })).entries.map(
    (entry) => entry.skill.description,
  );
async function completePassiveScan(milliseconds = 60_000) {
  const tasks = vi.spyOn(WorkerTaskPool.prototype, "run");
  try {
    await vi.advanceTimersByTimeAsync(milliseconds);
    await Promise.all(tasks.mock.results.map((result) => result.value));
  } finally {
    tasks.mockRestore();
  }
}
const write = (description: string, dir = workspace) =>
  writeSkill({ dir: path.join(dir, "skills", "guide"), name: "guide", description });

it("publishes explicit additions, edits, and removals before refresh resolves", async () => {
  expect(await descriptions()).toEqual([]);
  for (const text of ["Added", "Edited"]) {
    await write(text);
    await refreshSkillsDiscovery({ workspaceDir: workspace });
    expect(await descriptions()).toEqual([text]);
  }
  await fs.rm(path.join(workspace, "skills"), { recursive: true });
  await refreshSkillsDiscovery({ workspaceDir: workspace });
  expect(await descriptions()).toEqual([]);
});

it("serves published skills while discovery is scanning another workspace", async () => {
  await write("Published instructions");
  const source = request();
  expect(await descriptions(source)).toEqual(["Published instructions"]);
  const other = temporary.make("skills-pending-discovery-");
  await write("New workspace", other);
  const entered = createDeferred();
  const release = createDeferred();
  // The wrapper below forwards the original receiver with apply.
  // oxlint-disable-next-line typescript/unbound-method
  const run = WorkerTaskPool.prototype.run;
  const tasks = vi.spyOn(WorkerTaskPool.prototype, "run").mockImplementationOnce(async function (
    this: WorkerTaskPool<unknown, unknown>,
    ...args
  ) {
    entered.resolve();
    await release.promise;
    return run.apply(this, args);
  });
  const cold = descriptions(request(other));
  let coldSettled = false;
  void cold.then(() => {
    coldSettled = true;
  });
  let warmSettled = false;
  let warm: Promise<string[]> | undefined;
  try {
    await entered.promise;
    warm = descriptions(source).then((result) => {
      warmSettled = true;
      return result;
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(warmSettled).toBe(true);
    expect(coldSettled).toBe(false);
    expect(await warm).toEqual(["Published instructions"]);
  } finally {
    release.resolve();
    await Promise.allSettled([warm, cold]);
    tasks.mockRestore();
  }
  expect(await cold).toEqual(["New workspace"]);
});

it("coalesces passive edits until the minute boundary and shares one worker", async () => {
  const other = temporary.make("skills-discovery-other-");
  await descriptions();
  await descriptions(request(other));
  expect(
    getTrackedWorkerPoolSnapshot().workerPools.filter(
      (entry) => entry.script === "discovery.worker.js",
    ),
  ).toEqual([expect.objectContaining({ workerCount: 1 })]);
  await write("First");
  await write("Final");
  await write("Other", other);
  await vi.advanceTimersByTimeAsync(59_999);
  expect(await descriptions()).toEqual([]);
  await completePassiveScan(1);
  expect(await descriptions()).toEqual(["Final"]);
  expect(await descriptions(request(other))).toEqual(["Other"]);
});

it("publishes diagnostic changes and removals after passive refresh with unchanged valid skills", async () => {
  const brokenFile = path.join(workspace, "skills", "broken", "SKILL.md");
  await write("Valid sibling");
  await fs.mkdir(path.dirname(brokenFile), { recursive: true });
  await fs.writeFile(brokenFile, "---\nname: broken\n---\n", "utf8");
  const input = request();
  const diagnostics = async () => {
    const sources = await prepareLocalSkillSources(input);
    expect(
      sources.entries.map((entry) => ({
        name: entry.skill.name,
        description: entry.skill.description,
      })),
    ).toEqual([{ name: "guide", description: "Valid sibling" }]);
    return sources.diagnostics;
  };
  const missingDescription = {
    items: [{ kind: "invalid", path: brokenFile, message: "description is required" }],
    omitted: 0,
  };
  const invalidFrontmatter = {
    items: [
      {
        kind: "invalid",
        path: brokenFile,
        message: "invalid frontmatter: UNTERMINATED_FRONTMATTER: missing closing --- delimiter",
      },
    ],
    omitted: 0,
  };
  expect(await diagnostics()).toEqual(missingDescription);
  const initialVersion = getSkillsSnapshotVersion(workspace);
  const changed = vi.fn<Parameters<typeof registerSkillsChangeListener>[0]>();
  const unsubscribe = registerSkillsChangeListener(changed);
  try {
    await fs.writeFile(brokenFile, "---\nname: broken\ndescription: Still rejected\n", "utf8");
    await vi.advanceTimersByTimeAsync(59_999);
    expect(await diagnostics()).toEqual(missingDescription);
    expect(getSkillsSnapshotVersion(workspace)).toBe(initialVersion);
    expect(changed).not.toHaveBeenCalled();

    await completePassiveScan(1);
    expect(await diagnostics()).toEqual(invalidFrontmatter);
    const changedVersion = getSkillsSnapshotVersion(workspace);
    expect(changedVersion).toBeGreaterThan(initialVersion);
    expect(changed).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ workspaceDir: workspace, reason: "watch" }),
    );

    changed.mockClear();
    await fs.rm(brokenFile);
    expect(await diagnostics()).toEqual(invalidFrontmatter);
    expect(getSkillsSnapshotVersion(workspace)).toBe(changedVersion);
    expect(changed).not.toHaveBeenCalled();

    await completePassiveScan();
    expect(await diagnostics()).toEqual({ items: [], omitted: 0 });
    expect(getSkillsSnapshotVersion(workspace)).toBeGreaterThan(changedVersion);
    expect(changed).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ workspaceDir: workspace, reason: "watch" }),
    );
  } finally {
    unsubscribe();
  }
});

it("applies config refresh on the healthy worker and drops departed sources", async () => {
  const nextWorkspace = temporary.make("skills-config-successor-");
  const config = (workspaceDir: string) => ({
    agents: { entries: { main: { workspace: workspaceDir } } },
    plugins: { enabled: false },
  });
  const discoveryPool = () =>
    getTrackedWorkerPoolSnapshot().workerPools.find(
      (entry) => entry.script === "discovery.worker.js",
    );
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
  const bundled = temporary.make("skills-batch-bundled-");
  vi.stubEnv("OPENCLAW_BUNDLED_SKILLS_DIR", bundled);
  const brokenFile = path.join(bundled, "broken", "SKILL.md");
  await fs.mkdir(path.dirname(brokenFile), { recursive: true });
  await fs.writeFile(brokenFile, "---\nname: broken\n---\n", "utf8");
  const config = {
    agents: { entries: { main: { workspace }, second: { workspace: other } } },
    plugins: { enabled: false },
  };
  await write("Original");
  await write("Other", other);
  const tasks = vi.spyOn(WorkerTaskPool.prototype, "run");
  const instructions = async (workspaceDir: string, agentId: string) => {
    const prepared = await prepareSkillSourcePlan(workspaceDir, { config, agentId });
    const sources = await prepareLocalSkillSources(
      {
        sourcePlan: prepared.plan,
        limits: resolveSkillDiscoveryLimits(config),
        additionalBins: [],
      },
      { plan: { input: prepared.input } },
    );
    expect(sources.diagnostics).toEqual({
      items: [{ kind: "invalid", path: brokenFile, message: "description is required" }],
      omitted: 0,
    });
    return sources.entries.find((entry) => entry.skill.name === "guide")?.skill.description;
  };
  try {
    for (const description of ["Original", "Edited"]) {
      await write(description);
      tasks.mockClear();
      await refreshSkillsDiscovery({ config, reason: "config-change" });
      expect(tasks).toHaveBeenCalledTimes(1);
      expect(tasks).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "scan", requests: expect.any(Array) }),
        expect.any(Object),
      );
      expect(await instructions(workspace, "main")).toBe(description);
      expect(await instructions(other, "second")).toBe("Other");
      expect(tasks).toHaveBeenCalledTimes(1);
    }
  } finally {
    tasks.mockRestore();
  }
});

it.each([false, true])(
  "joins a concurrent reset before source registration (selected: %s)",
  async (selected) => {
    await write("Current instructions");
    const disposalEntered = createDeferred();
    const disposalReleased = createDeferred();
    const resetEntered = createDeferred();
    const resetReleased = createDeferred();
    const dispose = remoteRefresh.disposeRemoteSkillsWatcher;
    const close = remoteRefresh.closeRemoteSkillsWatchers;
    vi.spyOn(remoteRefresh, "disposeRemoteSkillsWatcher").mockImplementationOnce(
      async (...args) => {
        await dispose(...args);
        disposalEntered.resolve();
        await disposalReleased.promise;
      },
    );
    vi.spyOn(remoteRefresh, "closeRemoteSkillsWatchers").mockImplementationOnce(async () => {
      await close();
      resetEntered.resolve();
      await resetReleased.promise;
    });
    let settled = false;
    const read = ensureSkillsWatcher({
      workspaceDir: workspace,
      ...(selected ? { sourcePlan: request().sourcePlan } : {}),
    });
    void read.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    let reset: Promise<void> | undefined;
    try {
      await disposalEntered.promise;
      reset = refreshSkillsDiscovery({ reason: "config-change" });
      await resetEntered.promise;
      disposalReleased.resolve();
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(settled).toBe(false);
      resetReleased.resolve();
      await Promise.all([read, reset]);
      expect(await descriptions()).toEqual(["Current instructions"]);
    } finally {
      disposalReleased.resolve();
      resetReleased.resolve();
      await Promise.allSettled([read, reset]);
      vi.restoreAllMocks();
    }
  },
);

it("keeps each source environment while refreshing a reused worker's plans and prompt paths", async () => {
  const firstHome = temporary.make("skills-first-home-");
  const secondHome = temporary.make("skills-second-home-");
  const setEnvironment = (home: string) => {
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);
    vi.stubEnv("OPENCLAW_HOME", path.join(home, "effective-home"));
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(home, ".openclaw"));
    vi.stubEnv("OPENCLAW_CONFIG_PATH", undefined);
    vi.stubEnv("OPENCLAW_BUNDLED_SKILLS_DIR", path.join(home, "bundled"));
  };
  const writeManaged = (home: string, description: string) =>
    writeSkill({
      dir: path.join(home, ".openclaw", "skills", "guide"),
      name: "guide",
      description,
    });
  await writeManaged(firstHome, "First namespace");
  await writeManaged(secondHome, "Second namespace");
  const config = { plugins: { enabled: false }, skills: { load: { extraDirs: ["~/extra"] } } };
  const prepare = async (home: string) => {
    setEnvironment(home);
    const planned = await prepareSkillSourcePlan(workspace, { config });
    expect(planned.plan).toMatchObject({
      userHomeDir: home,
      stateDir: path.join(home, ".openclaw"),
      managedSkillsDir: path.join(home, ".openclaw", "skills"),
      bundledSkillsDir: path.join(home, "bundled"),
      roots: expect.arrayContaining([
        expect.objectContaining({ dir: path.join(home, "effective-home", "extra") }),
      ]),
    });
    const input = { ...request(), sourcePlan: planned.plan };
    const options = { plan: { input: planned.input } };
    return { input, options, sources: await prepareLocalSkillSources(input, options) };
  };
  const first = await prepare(firstHome);
  expect(first.sources.entries.map((entry) => entry.skill.description)).toEqual([
    "First namespace",
  ]);
  const second = await prepare(secondHome);
  expect(second.sources.entries.map((entry) => entry.skill.description)).toEqual([
    "Second namespace",
  ]);
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
  expect(
    (await prepareLocalSkillSources(first.input, first.options)).entries.map(
      (entry) => entry.skill.description,
    ),
  ).toEqual(["First namespace updated"]);
  expect(
    (await prepareLocalSkillSources(second.input, second.options)).entries.map(
      (entry) => entry.skill.description,
    ),
  ).toEqual(["Second namespace"]);
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
  expect(await descriptions()).toEqual(["Original"]);
  await fs.rename(workspace, path.join(temporary.make("skills-retired-"), "workspace"));
  await write("Replacement");
  await completePassiveScan();
  expect(await descriptions()).toEqual(["Replacement"]);
  await fs.rm(path.join(workspace, "skills"), { recursive: true });
  await completePassiveScan();
  expect(await descriptions()).toEqual([]);
  await write("Recreated");
  await completePassiveScan();
  expect(await descriptions()).toEqual(["Recreated"]);
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
    Array.from({ length: 128 }, (_, index) =>
      prepareLocalSkillSources({
        ...input,
        sourcePlan: {
          ...input.sourcePlan,
          workspaceDir: path.join(workspace, String(index)),
          roots: [],
        },
      }),
    ),
  );
  expect(getSkillsSnapshotVersion(workspace)).toBeGreaterThan(version);
  await write("Changed while evicted");
  expect(await descriptions(input)).toEqual(["Changed while evicted"]);
});

it("discovers new agent-plugin children during the passive worker pass", async () => {
  const pluginRoot = path.join(workspace, "plugin");
  const skillRoot = path.join(pluginRoot, "skills");
  await writeSkill({ dir: path.join(skillRoot, "first"), name: "first", description: "First" });
  const input = request();
  const prepared = await prepareSkillSourcePlan(workspace, { workspaceOnly: true });
  const options = {
    plan: {
      input: {
        ...prepared.input,
        workspaceDir: workspace,
        options: {
          config: { plugins: { enabled: false } },
          managedSkillsDir: path.join(workspace, "managed"),
          bundledSkillsDir: "",
          pluginSkillsDir: path.join(workspace, "plugin-links"),
        },
        acpRuntimeAvailable: false,
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
    },
  };
  const names = async () =>
    (await prepareLocalSkillSources(input, options)).entries.map((entry) => entry.skill.name);
  expect(await names()).toContain("first");
  await writeSkill({ dir: path.join(skillRoot, "second"), name: "second", description: "Second" });
  expect(await names()).not.toContain("second");
  await completePassiveScan();
  expect(await names()).toContain("second");
});
