// Embedded run entry tests cover runtime skill entries serialized into agent runs.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
  type OpenClawConfig,
} from "../../config/config.js";
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
