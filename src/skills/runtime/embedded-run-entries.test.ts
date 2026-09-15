// Embedded run entry tests cover runtime skill entries serialized into agent runs.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
  type OpenClawConfig,
} from "../../config/config.js";
import { createDeferredCore } from "../../shared/deferred.js";
import * as librarySelectionModule from "../library/selection.js";
import * as skillsLoaderModule from "../loading/workspace-skill-loader.js";
import { createCanonicalFixtureSkill } from "../test-support/test-helpers.js";
import type { SkillEntry, SkillSnapshot } from "../types.js";
import { resolveEmbeddedRunSkillEntries } from "./embedded-run-entries.js";

describe("resolveEmbeddedRunSkillEntries", () => {
  const prepareWorkspaceSkillsSpy = vi.spyOn(skillsLoaderModule, "prepareWorkspaceSkills");

  beforeEach(() => {
    clearRuntimeConfigSnapshot();
    prepareWorkspaceSkillsSpy.mockReset();
    prepareWorkspaceSkillsSpy.mockResolvedValue([]);
  });

  it("loads skill entries with config when no resolved snapshot skills exist", async () => {
    const config: OpenClawConfig = {
      plugins: {
        entries: {
          diffs: { enabled: true },
        },
      },
    };

    const result = await resolveEmbeddedRunSkillEntries({
      workspaceDir: "/tmp/workspace",
      config,
      skillsSnapshot: {
        prompt: "skills prompt",
        skills: [],
      },
    });

    expect(result.shouldLoadSkillEntries).toBe(true);
    expect(prepareWorkspaceSkillsSpy).toHaveBeenCalledTimes(1);
    expect(prepareWorkspaceSkillsSpy).toHaveBeenCalledWith("/tmp/workspace", { config }, undefined);
  });

  it("threads agentId through live skill loading", async () => {
    await resolveEmbeddedRunSkillEntries({
      workspaceDir: "/tmp/workspace",
      config: {},
      agentId: "writer",
      skillsSnapshot: {
        prompt: "skills prompt",
        skills: [],
      },
    });

    expect(prepareWorkspaceSkillsSpy).toHaveBeenCalledWith(
      "/tmp/workspace",
      {
        config: {},
        agentId: "writer",
      },
      undefined,
    );
  });

  it("can constrain live loading to materialized workspace skills", async () => {
    const eligibility = {
      remote: {
        platforms: ["linux"],
        hasBin: () => false,
        hasAnyBin: () => true,
        note: "sandbox",
      },
    };

    await resolveEmbeddedRunSkillEntries({
      workspaceDir: "/tmp/workspace/.openclaw/sandbox-skills",
      config: {},
      eligibility,
      skillsSnapshot: {
        prompt: "skills prompt",
        skills: [],
      },
      workspaceOnly: true,
    });

    expect(prepareWorkspaceSkillsSpy).toHaveBeenCalledWith(
      "/tmp/workspace/.openclaw/sandbox-skills",
      {
        config: {},
        eligibility,
        workspaceOnly: true,
      },
      undefined,
    );
  });

  it("prefers the active runtime snapshot when caller config still contains SecretRefs", async () => {
    const sourceConfig: OpenClawConfig = {
      skills: {
        entries: {
          diffs: {
            apiKey: {
              source: "file",
              provider: "default",
              id: "/skills/entries/diffs/apiKey",
            },
          },
        },
      },
    };
    const runtimeConfig: OpenClawConfig = {
      skills: {
        entries: {
          diffs: {
            apiKey: "resolved-key",
          },
        },
      },
    };
    setRuntimeConfigSnapshot(runtimeConfig, sourceConfig);

    await resolveEmbeddedRunSkillEntries({
      workspaceDir: "/tmp/workspace",
      config: sourceConfig,
      skillsSnapshot: {
        prompt: "skills prompt",
        skills: [],
      },
    });

    expect(prepareWorkspaceSkillsSpy).toHaveBeenCalledWith(
      "/tmp/workspace",
      {
        config: runtimeConfig,
      },
      undefined,
    );
  });

  it("prefers caller config when the active runtime snapshot still contains raw skill SecretRefs", async () => {
    const sourceConfig: OpenClawConfig = {
      skills: {
        entries: {
          diffs: {
            apiKey: {
              source: "file",
              provider: "default",
              id: "/skills/entries/diffs/apiKey",
            },
          },
        },
      },
    };
    const runtimeConfig: OpenClawConfig = structuredClone(sourceConfig);
    const callerConfig: OpenClawConfig = {
      skills: {
        entries: {
          diffs: {
            apiKey: "resolved-key",
          },
        },
      },
    };
    setRuntimeConfigSnapshot(runtimeConfig, sourceConfig);

    await resolveEmbeddedRunSkillEntries({
      workspaceDir: "/tmp/workspace",
      config: callerConfig,
      skillsSnapshot: {
        prompt: "skills prompt",
        skills: [],
      },
    });

    expect(prepareWorkspaceSkillsSpy).toHaveBeenCalledWith(
      "/tmp/workspace",
      {
        config: callerConfig,
      },
      undefined,
    );
  });

  it("skips skill entry loading when resolved snapshot skills are present", async () => {
    const snapshot: SkillSnapshot = {
      prompt: "skills prompt",
      skills: [{ name: "diffs" }],
      resolvedSkills: [],
    };

    const result = await resolveEmbeddedRunSkillEntries({
      workspaceDir: "/tmp/workspace",
      config: {},
      skillsSnapshot: snapshot,
    });

    expect(result.shouldLoadSkillEntries).toBe(false);
    expect(result.skillEntries).toEqual([]);
    expect(prepareWorkspaceSkillsSpy).not.toHaveBeenCalled();
  });

  it("exposes a cached lazy loader without eagerly loading a modern snapshot", async () => {
    const loadedEntries: SkillEntry[] = [
      {
        skill: createCanonicalFixtureSkill({
          name: "healthy",
          description: "healthy",
          filePath: "/tmp/workspace/skills/healthy/SKILL.md",
          baseDir: "/tmp/workspace/skills/healthy",
          source: "test",
        }),
        frontmatter: {},
      },
    ];
    prepareWorkspaceSkillsSpy.mockResolvedValue(loadedEntries);
    const result = await resolveEmbeddedRunSkillEntries({
      workspaceDir: "/tmp/workspace",
      config: {},
      skillsSnapshot: {
        prompt: "skills prompt",
        skills: [{ name: "healthy", skillKey: "healthy" }],
        resolvedSkills: [],
      },
    });

    expect(prepareWorkspaceSkillsSpy).not.toHaveBeenCalled();
    expect(await result.loadSkillEntries()).toBe(loadedEntries);
    expect(await result.loadSkillEntries()).toBe(loadedEntries);
    expect(prepareWorkspaceSkillsSpy).toHaveBeenCalledOnce();
  });
});

describe("embedded library cache publication", () => {
  const workspace = vi.spyOn(skillsLoaderModule, "prepareWorkspaceSkills");
  const library = vi.spyOn(librarySelectionModule, "prepareSkillLibrarySelection");
  const entry = (name: string): SkillEntry => ({
    skill: createCanonicalFixtureSkill({
      name,
      description: name,
      filePath: `/synthetic/${name}/SKILL.md`,
      baseDir: `/synthetic/${name}`,
      source: "test",
    }),
    frontmatter: {},
  });
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
      config: { plugins: { enabled: false } },
      skillsSnapshot: snapshot,
      ...options,
    });

  beforeEach(() => {
    clearRuntimeConfigSnapshot();
    workspace.mockReset().mockResolvedValue(workspaceEntries);
    library.mockReset().mockResolvedValue(libraryEntries);
  });

  it("keeps concurrent lazy reads private until complete and preserves append order", async () => {
    const gate = createDeferredCore<SkillEntry[]>();
    const entered = createDeferredCore();
    library.mockImplementation(() => {
      entered.resolve();
      return gate.promise;
    });
    const result = await resolve();
    expect(workspace).not.toHaveBeenCalled();
    expect(library).not.toHaveBeenCalled();
    const completedNames: string[][] = [];
    const captureCompletion = (entries: SkillEntry[]) => {
      completedNames.push(entries.map(({ skill }) => skill.name));
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
    expect(workspaceEntries.map(({ skill }) => skill.name)).toEqual(["workspace"]);
  });

  it.each(["workspace", "library"] as const)(
    "retries complete loading after a rejected %s stage",
    async (stage) => {
      const failure = new Error(`Synthetic ${stage} rejection`);
      (stage === "workspace" ? workspace : library).mockRejectedValueOnce(failure);
      const result = await resolve();
      await expect(result.loadSkillEntries()).rejects.toBe(failure);
      expect((await result.loadSkillEntries()).map(({ skill }) => skill.name)).toEqual([
        "workspace",
        "library",
      ]);
      expect(workspaceEntries).toHaveLength(1);
    },
  );

  it.each(["workspace", "library"] as const)(
    "rejects an obsolete owner after awaiting %s without publishing its entries",
    async (stage) => {
      const gate = createDeferredCore<SkillEntry[]>();
      const entered = createDeferredCore();
      (stage === "workspace" ? workspace : library).mockImplementationOnce(() => {
        entered.resolve();
        return gate.promise;
      });
      const failure = new Error("Synthetic embedded owner closed");
      let current = true;
      const result = await resolve({
        assertCurrent() {
          if (!current) {
            throw failure;
          }
        },
      });
      const pending = result.loadSkillEntries();
      const rejected = expect(pending).rejects.toBe(failure);
      await entered.promise;
      current = false;
      gate.resolve(stage === "workspace" ? workspaceEntries : libraryEntries);
      await rejected;
      current = true;
      expect((await result.loadSkillEntries()).map(({ skill }) => skill.name)).toEqual([
        "workspace",
        "library",
      ]);
      expect(workspaceEntries).toHaveLength(1);
    },
  );

  it("excludes pinned libraries from workspace-only loads and retains workspace array identity", async () => {
    const result = await resolve({ workspaceOnly: true });
    expect(await result.loadSkillEntries()).toBe(workspaceEntries);
    expect(await result.loadSkillEntries()).toBe(workspaceEntries);
    expect(library).not.toHaveBeenCalled();
  });
});
