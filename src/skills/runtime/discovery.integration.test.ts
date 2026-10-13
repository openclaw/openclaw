import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { getTrackedWorkerPoolSnapshot } from "../../infra/worker-cpu.js";
import type { WorkspaceSkillSourceRequest } from "../loading/workspace-skill-sources.types.js";
import { writeSkill } from "../test-support/e2e-test-helpers.js";
import { getSkillsResourceVersion, getSkillsSnapshotVersion } from "./refresh-state.js";
import {
  closeSkillsWatchers,
  prepareLocalSkillSources,
  prepareSkillSourcePlan,
  projectSkillSnapshot,
  refreshSkillsDiscovery,
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
  await vi.advanceTimersByTimeAsync(1);
  expect(await descriptions()).toEqual(["Final"]);
  expect(await descriptions(request(other))).toEqual(["Other"]);
});

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
  await vi.advanceTimersByTimeAsync(60_000);
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
  await vi.advanceTimersByTimeAsync(60_000);
  expect(await descriptions()).toEqual(["Replacement"]);
  await fs.rm(path.join(workspace, "skills"), { recursive: true });
  await vi.advanceTimersByTimeAsync(60_000);
  expect(await descriptions()).toEqual([]);
  await write("Recreated");
  await vi.advanceTimersByTimeAsync(60_000);
  expect(await descriptions()).toEqual(["Recreated"]);
});

it("refreshes supporting resources without publishing an unchanged catalog", async () => {
  await write("Stable catalog");
  await descriptions();
  const version = getSkillsSnapshotVersion(workspace);
  const resources = getSkillsResourceVersion(workspace);
  await fs.writeFile(path.join(workspace, "skills", "guide", "helper.txt"), "changed");
  await vi.advanceTimersByTimeAsync(60_000);
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
  await vi.advanceTimersByTimeAsync(60_000);
  expect(await names()).toContain("second");
});
