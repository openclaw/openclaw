import path from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
  type OpenClawConfig,
} from "../../config/config.js";
import type { SkillConfig } from "../../config/types.skills.js";
import { createDeferredCore } from "../../shared/deferred.js";
import * as librarySelectionModule from "../library/selection.js";
import * as skillsLoaderModule from "../loading/workspace-skill-loader.js";
import { createFixtureSkillEntry as entry } from "../test-support/test-helpers.js";
import {
  WORKSPACE_SKILLS_PROMPT_FORMAT_VERSION,
  type SkillEntry,
  type SkillSnapshot,
} from "../types.js";
import { resolveEmbeddedRunSkillEntries } from "./embedded-run-entries.js";
import { bumpSkillsSnapshotVersion } from "./refresh-state.js";
import { recordSkillRootsExecutionFileHost } from "./skill-snapshot-provenance.js";

const workspace = vi.spyOn(skillsLoaderModule, "prepareWorkspaceSkills");
const library = vi.spyOn(librarySelectionModule, "prepareSkillLibrarySelection");
const names = (entries: SkillEntry[]) => entries.map(({ skill }) => skill.name);
const config = { plugins: { enabled: false } };
const skillConfig = (apiKey: SkillConfig["apiKey"]): OpenClawConfig => ({
  skills: { entries: { diffs: { apiKey } } },
});
const rootsFor = (name: string) => ({
  agentWorkspaceDir: path.resolve(`/synthetic/${name}/agent`),
  executionWorkspaceDir: path.resolve(`/synthetic/${name}/execution`),
});
const workspaceEntries = [entry("workspace")];
const libraryEntries = [entry("library")];
const workspaceRoot = "/synthetic/workspace";
const snapshot: SkillSnapshot = {
  prompt: "cached prompt",
  skills: [],
  resolvedSkills: [],
  librarySelections: [
    { skillId: "library", revision: "0".repeat(64), name: "library", ownerProfileId: null },
  ],
  skillFilter: ["workspace"],
};
const defaults = { workspaceDir: workspaceRoot, config, skillsSnapshot: snapshot };
const resolve = (options: Partial<Parameters<typeof resolveEmbeddedRunSkillEntries>[0]> = {}) =>
  resolveEmbeddedRunSkillEntries({ ...defaults, ...options });

beforeEach(() => {
  clearRuntimeConfigSnapshot();
  workspace.mockReset().mockResolvedValue(workspaceEntries);
  library.mockReset().mockResolvedValue(libraryEntries);
});

function pause(stage: "workspace" | "library", once = true) {
  const gate = createDeferredCore<SkillEntry[]>();
  const entered = createDeferredCore();
  const mock = stage === "workspace" ? workspace : library;
  mock[once ? "mockImplementationOnce" : "mockImplementation"](() => {
    entered.resolve();
    return gate.promise;
  });
  return { gate, entered };
}

it.each(["canonical", "materialized", "legacy"] as const)(
  "loads %s roots with agent and eligibility context",
  async (mode) => {
    const workspaceDir = path.resolve("/synthetic/materialized");
    const roots = rootsFor("canonical");
    const { agentWorkspaceDir, executionWorkspaceDir } = roots;
    const workspaceOnly = mode === "materialized";
    const skillsSnapshot: SkillSnapshot = {
      prompt: "Hydrate selected skills",
      skills: [],
      promptFormatVersion: mode === "legacy" ? 6 : WORKSPACE_SKILLS_PROMPT_FORMAT_VERSION,
      skillRoots:
        mode === "legacy" ? rootsFor("stale") : recordSkillRootsExecutionFileHost(roots, "gateway"),
    };
    const serialized = JSON.stringify(skillsSnapshot);
    const hydrated: SkillSnapshot = JSON.parse(serialized);
    const eligibility = { nodeSkills: { canExec: true } };
    const context = { config: {}, agentId: "writer", eligibility };
    await resolve({
      workspaceDir,
      workspaceOnly,
      ...context,
      ...(mode === "legacy"
        ? ({ executionWorkspaceDir, executionWorkspaceFileHost: "gateway" } as const)
        : {}),
      skillsSnapshot: hydrated,
    });
    expect(workspace).toHaveBeenCalledWith(
      mode === "canonical" ? agentWorkspaceDir : workspaceDir,
      {
        ...context,
        executionWorkspaceDir: workspaceOnly ? undefined : executionWorkspaceDir,
        executionWorkspaceFileHost: workspaceOnly ? undefined : "gateway",
        ...(workspaceOnly ? { workspaceOnly: true } : {}),
      },
      undefined,
    );
  },
);

it.each([false, true])(
  "prefers resolved skill secrets when runtime contains raw refs: %s",
  async (rawRuntime) => {
    const sourceConfig = skillConfig({
      source: "file",
      provider: "default",
      id: "/skills/entries/diffs/apiKey",
    });
    const resolvedConfig = skillConfig("resolved-key");
    const runtimeConfig = rawRuntime ? structuredClone(sourceConfig) : resolvedConfig;
    setRuntimeConfigSnapshot(runtimeConfig, sourceConfig);
    await resolve({
      config: rawRuntime ? resolvedConfig : sourceConfig,
      skillsSnapshot: { prompt: "skills prompt", skills: [] },
    });
    expect(workspace).toHaveBeenCalledWith(workspaceRoot, { config: resolvedConfig }, undefined);
  },
);
it("keeps concurrent lazy reads private until complete and preserves append order", async () => {
  const { gate, entered } = pause("library", false);
  const result = await resolve();
  expect(workspace).not.toHaveBeenCalled();
  expect(library).not.toHaveBeenCalled();
  const capture = (entries: SkillEntry[]) => {
    expect(names(entries)).toEqual(["workspace", "library"]);
    return entries;
  };
  const first = result.loadSkillEntries().then(capture);
  await entered.promise;
  const second = result.loadSkillEntries().then(capture);
  gate.resolve(libraryEntries);
  const results = await Promise.all([first, second]);
  expect(results).toContain(await result.loadSkillEntries());
  expect(names(workspaceEntries)).toEqual(["workspace"]);
});

it("preserves the first complete publication across concurrent lazy reads", async () => {
  const base = "/synthetic/embedded-concurrent";
  const roots = {
    agentWorkspaceDir: `${base}/agent/../agent`,
    executionWorkspaceDir: `${base}/execution/../execution`,
  };
  const bumpSources = () =>
    bumpSkillsSnapshotVersion({
      workspaceDir: path.resolve(roots.agentWorkspaceDir),
      sourceScopes: [{ executionWorkspaceDir: path.resolve(roots.executionWorkspaceDir) }],
    });
  workspace
    .mockResolvedValueOnce([entry("workspace-stale")])
    .mockResolvedValue([entry("workspace-current")]);
  const { gate, entered } = pause("library");
  const result = await resolve({
    workspaceDir: "/synthetic/fallback-workspace",
    agentId: "fixture",
    skillsSnapshot: {
      ...snapshot,
      promptFormatVersion: WORKSPACE_SKILLS_PROMPT_FORMAT_VERSION,
      skillRoots: roots,
    },
  });
  const first = result.loadSkillEntries();
  await entered.promise;
  bumpSources();
  const winner = await result.loadSkillEntries();
  workspace.mockResolvedValue([entry("workspace-after-publication")]);
  bumpSources();
  gate.resolve(libraryEntries);
  const entries = await first;
  expect(names(entries)).toEqual(["workspace-current", "library"]);
  expect(entries).toBe(winner);
  workspace.mockResolvedValue([entry("workspace-after-publication")]);
  bumpSources();
  expect(await result.loadSkillEntries()).toBe(entries);
  expect(names(entries)).toEqual(["workspace-current", "library"]);
});

it.each([
  ["workspace", "rejection"],
  ["library", "rejection"],
  ["workspace", "obsolete owner"],
  ["library", "obsolete owner"],
] as const)(
  "retries complete loading after %s stage %s without publishing failed entries",
  async (stage, mode) => {
    const paused = mode === "obsolete owner" ? pause(stage) : undefined;
    const failure = new Error(`Synthetic ${stage} ${mode}`);
    if (!paused) {
      (stage === "workspace" ? workspace : library).mockRejectedValueOnce(failure);
    }
    const assertCurrent = vi.fn();
    const result = await resolve({ assertCurrent });
    const rejected = expect(result.loadSkillEntries()).rejects.toBe(failure);
    if (paused) {
      await paused.entered.promise;
      assertCurrent.mockImplementation(() => {
        throw failure;
      });
      paused.gate.resolve(stage === "workspace" ? workspaceEntries : libraryEntries);
    }
    await rejected;
    assertCurrent.mockReset();
    expect(names(await result.loadSkillEntries())).toEqual(["workspace", "library"]);
    expect(workspaceEntries).toHaveLength(1);
  },
);

it("excludes pinned libraries from workspace-only loads and retains workspace array identity", async () => {
  const result = await resolve({ workspaceOnly: true });
  expect(result).toMatchObject({ shouldLoadSkillEntries: false, skillEntries: [] });
  expect(workspace).not.toHaveBeenCalled();
  expect(await result.loadSkillEntries()).toBe(workspaceEntries);
  expect(await result.loadSkillEntries()).toBe(workspaceEntries);
  expect(library).not.toHaveBeenCalled();
  expect(workspace).toHaveBeenCalledOnce();
});
