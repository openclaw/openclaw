import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
function pause(stage: "workspace" | "library", once = true) {
  const gate = createDeferredCore<SkillEntry[]>();
  const entered = createDeferredCore();
  const implementation = () => {
    entered.resolve();
    return gate.promise;
  };
  const mock = stage === "workspace" ? workspace : library;
  if (once) {
    mock.mockImplementationOnce(implementation);
  } else {
    mock.mockImplementation(implementation);
  }
  return { gate, entered };
}

describe("resolveEmbeddedRunSkillEntries", () => {
  beforeEach(() => {
    clearRuntimeConfigSnapshot();
    workspace.mockReset().mockResolvedValue([]);
  });

  it.each(["canonical", "materialized", "legacy"] as const)(
    "loads %s roots with agent and eligibility context",
    async (mode) => {
      const workspaceDir = path.resolve("/synthetic/materialized");
      const roots = rootsFor("canonical");
      const { agentWorkspaceDir, executionWorkspaceDir } = roots;
      const workspaceOnly = mode === "materialized";
      const eligibility = { nodeSkills: { canExec: true } };
      const skillsSnapshot: SkillSnapshot = {
        prompt: "Hydrate selected skills",
        skills: [],
        promptFormatVersion: mode === "legacy" ? 6 : WORKSPACE_SKILLS_PROMPT_FORMAT_VERSION,
        skillRoots:
          mode === "legacy"
            ? rootsFor("stale")
            : recordSkillRootsExecutionFileHost(roots, "gateway"),
      };
      const serialized = JSON.stringify(skillsSnapshot);
      const hydrated: SkillSnapshot = JSON.parse(serialized);
      const context = { config: {}, agentId: "writer", eligibility };
      await resolveEmbeddedRunSkillEntries({
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
      setRuntimeConfigSnapshot(
        rawRuntime ? structuredClone(sourceConfig) : resolvedConfig,
        sourceConfig,
      );
      await resolveEmbeddedRunSkillEntries({
        workspaceDir: "/tmp/workspace",
        config: rawRuntime ? resolvedConfig : sourceConfig,
        skillsSnapshot: { prompt: "skills prompt", skills: [] },
      });
      expect(workspace).toHaveBeenCalledWith(
        "/tmp/workspace",
        { config: resolvedConfig },
        undefined,
      );
    },
  );
});

describe("embedded library cache publication", () => {
  const workspaceEntries = [entry("workspace")];
  const libraryEntries = [entry("library")];
  const snapshot: SkillSnapshot = {
    prompt: "cached prompt",
    skills: [],
    resolvedSkills: [],
    librarySelections: [
      { skillId: "library", revision: "0".repeat(64), name: "library", ownerProfileId: null },
    ],
    skillFilter: ["workspace"],
  };
  const resolve = (options: { assertCurrent?: () => void; workspaceOnly?: boolean } = {}) =>
    resolveEmbeddedRunSkillEntries({
      workspaceDir: "/synthetic/workspace",
      config,
      skillsSnapshot: snapshot,
      ...options,
    });

  beforeEach(() => {
    clearRuntimeConfigSnapshot();
    workspace.mockReset().mockResolvedValue(workspaceEntries);
    library.mockReset().mockResolvedValue(libraryEntries);
  });

  it("keeps concurrent lazy reads private until complete and preserves append order", async () => {
    const { gate, entered } = pause("library", false);
    const result = await resolve();
    expect(workspace).not.toHaveBeenCalled();
    expect(library).not.toHaveBeenCalled();
    const completedNames: string[][] = [];
    const captureCompletion = (entries: SkillEntry[]) => {
      completedNames.push(names(entries));
      return entries;
    };
    const first = result.loadSkillEntries().then(captureCompletion);
    await entered.promise;
    const second = result.loadSkillEntries().then(captureCompletion);
    gate.resolve(libraryEntries);
    const results = await Promise.all([first, second]);
    expect(completedNames).toEqual([
      ["workspace", "library"],
      ["workspace", "library"],
    ]);
    expect(results).toContain(await result.loadSkillEntries());
    expect(names(workspaceEntries)).toEqual(["workspace"]);
  });

  it.each(["retry", "concurrent"] as const)(
    "publishes current workspace entries after a library wait (%s)",
    async (mode) => {
      const base = `/synthetic/embedded-${mode}`;
      const roots = {
        agentWorkspaceDir: `${base}/agent/../agent`,
        executionWorkspaceDir: `${base}/execution/../execution`,
      };
      const bumpSources = () =>
        bumpSkillsSnapshotVersion({
          workspaceDir: path.resolve(roots.agentWorkspaceDir),
          sourceScopes: [{ executionWorkspaceDir: path.resolve(roots.executionWorkspaceDir) }],
        });
      const currentWorkspaceEntries = [entry("workspace-current")];
      workspace
        .mockResolvedValueOnce([entry("workspace-stale")])
        .mockResolvedValue(currentWorkspaceEntries);
      const { gate, entered } = pause("library");
      const result = await resolveEmbeddedRunSkillEntries({
        workspaceDir: "/synthetic/fallback-workspace",
        agentId: "fixture",
        config,
        skillsSnapshot: {
          ...snapshot,
          promptFormatVersion: WORKSPACE_SKILLS_PROMPT_FORMAT_VERSION,
          skillRoots: roots,
        },
      });
      const first = result.loadSkillEntries();
      await entered.promise;
      bumpSources();
      const winner = mode === "concurrent" ? await result.loadSkillEntries() : undefined;
      if (winner) {
        workspace.mockResolvedValue([entry("workspace-after-publication")]);
        bumpSources();
      }
      gate.resolve(libraryEntries);
      const entries = await first;
      expect(names(entries)).toEqual(["workspace-current", "library"]);
      if (winner) {
        expect(entries).toBe(winner);
      }
      workspace.mockResolvedValue([entry("workspace-after-publication")]);
      bumpSources();
      expect(await result.loadSkillEntries()).toBe(entries);
      expect(names(entries)).toEqual(["workspace-current", "library"]);
    },
  );

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
      let current = true;
      const result = await resolve({
        assertCurrent() {
          if (!current) {
            throw failure;
          }
        },
      });
      const rejected = expect(result.loadSkillEntries()).rejects.toBe(failure);
      if (paused) {
        await paused.entered.promise;
        current = false;
        paused.gate.resolve(stage === "workspace" ? workspaceEntries : libraryEntries);
      }
      await rejected;
      current = true;
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
});
