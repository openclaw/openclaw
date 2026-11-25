// Onboarding target tests keep workspace, auth directory, and sessions on one agent owner.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { applyPrimaryModel } from "../plugins/provider-model-primary.js";
import type { RuntimeEnv } from "../runtime.js";
import { createCanonicalAgentConfigFixture } from "../test-utils/config-roster.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  applyOnboardingPrimaryModel,
  applyOnboardingUtilityModel,
  applyAgentModelDefaults,
  ensureOnboardingAgentWorkspace,
  resolveOnboardingAgentTarget,
  resolveOnboardingSetupTarget,
} from "./onboard-agent-target.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function modelSettings(primary: string, alias: string) {
  return {
    model: { primary },
    models: { [primary]: { alias } },
    modelPolicy: { allow: [primary] },
  };
}

function fleet<T extends NonNullable<OpenClawConfig["agents"]>["entries"]>(
  entries: T,
  defaults: NonNullable<OpenClawConfig["agents"]>["defaults"] = {},
) {
  return { agents: { ownership: "explicit" as const, defaults, entries } };
}

describe("onboarding agent target", () => {
  it.each([undefined, "explicit"] as const)(
    "keeps utility selection on its %s owner",
    (ownership) => {
      const config: OpenClawConfig = {
        agents: {
          ...(ownership ? { ownership } : {}),
          defaults: {
            model: { primary: "openai/gpt-5.5", fallbacks: ["openai/gpt-5.4"] },
            utilityModel: "local-utility/shared",
          },
          entries: {
            main: { utilityModel: "local-utility/main" },
            OPS: { model: "openai/gpt-5.4", agentDir: "/tmp/ops-auth" },
          },
        },
      };
      const original = structuredClone(config);
      const target = resolveOnboardingAgentTarget(config, "ops");

      const result = applyOnboardingUtilityModel(config, target, "local-utility/tiny");

      expect(result.agents?.defaults).toEqual({
        ...config.agents?.defaults,
        utilityModel: ownership ? "local-utility/shared" : "local-utility/tiny",
      });
      expect(result.agents?.entries).toEqual({
        ...config.agents?.entries,
        OPS: {
          ...config.agents?.entries?.OPS,
          ...(ownership ? { utilityModel: "local-utility/tiny" } : {}),
        },
      });
      expect(config).toEqual(original);
    },
  );

  it.each(["defaults", "agent"] as const)(
    "preserves a %s utility fallback chain when changing its primary",
    (owner) => {
      const utilityModel = { primary: "local/old", fallbacks: ["local/backup"] };
      const config: OpenClawConfig = {
        agents: {
          defaults: { utilityModel },
          entries: { main: owner === "agent" ? { utilityModel } : {} },
        },
      };
      const result = applyOnboardingUtilityModel(
        config,
        resolveOnboardingAgentTarget(config, "main"),
        "local/new",
      );
      expect(
        owner === "agent"
          ? result.agents?.entries?.main?.utilityModel
          : result.agents?.defaults?.utilityModel,
      ).toEqual({ primary: "local/new", fallbacks: ["local/backup"] });
      expect(utilityModel).toEqual({ primary: "local/old", fallbacks: ["local/backup"] });
    },
  );

  it("projects a provider utility mutation only onto the selected agent", () => {
    const config = fleet(
      {
        main: { utilityModel: "local-utility/main" },
        OPS: {
          model: { primary: "openai/gpt-5.4", fallbacks: ["openai/gpt-5.5"] },
        },
      },
      { model: "openai/gpt-5.5", utilityModel: "local-utility/shared" },
    );
    const target = resolveOnboardingAgentTarget(config, "ops");

    const updated = applyAgentModelDefaults(config, target, (projected) => {
      expect(projected.agents?.defaults?.utilityModel).toBe("local-utility/shared");
      return {
        ...projected,
        plugins: { entries: { "local-utility": { enabled: true } } },
        agents: {
          ...projected.agents,
          defaults: { ...projected.agents?.defaults, utilityModel: "local-utility/tiny" },
        },
      };
    });

    expect(updated.agents?.defaults).toEqual(config.agents?.defaults);
    expect(updated.agents?.entries).toEqual({
      ...config.agents?.entries,
      OPS: { ...config.agents?.entries?.OPS, utilityModel: "local-utility/tiny" },
    });
    expect(updated.plugins?.entries?.["local-utility"]?.enabled).toBe(true);
  });

  it("uses the system agent for explicit fleets without changing legacy ownership", () => {
    const entries = {
      main: { workspace: "/srv/main" },
      ops: { workspace: "/srv/ops" },
    };
    const pendingAgent = { name: "robby", workspaceDir: "/srv/robby" };

    const defaults = { systemAgent: { agentId: "main" } };
    expect(resolveOnboardingSetupTarget(fleet(entries, defaults), pendingAgent)).toMatchObject({
      agentId: "main",
      workspaceDir: "/srv/main",
    });
    expect(resolveOnboardingSetupTarget(fleet({ main: {} }, defaults), pendingAgent)).toMatchObject(
      { agentId: "main" },
    );
    const legacyConfig = createCanonicalAgentConfigFixture({
      agents: { entries: { ...entries, ops: { ...entries.ops, default: true } } },
    }).config;
    expect(resolveOnboardingSetupTarget(legacyConfig)).toMatchObject({
      agentId: "ops",
      workspaceDir: "/srv/ops",
    });
  });

  it("resolves a pending first agent without nesting the selected workspace", async () => {
    const stateDir = tempDirs.make("openclaw-pending-onboard-target-");
    const workspaceDir = path.join(stateDir, "requested-workspace");

    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      for (const entries of [undefined, { main: {} }] as const) {
        const config = {
          agents: { defaults: { workspace: workspaceDir }, ...(entries ? { entries } : {}) },
        };

        expect(resolveOnboardingSetupTarget(config, { name: " Robby! ", workspaceDir })).toEqual({
          agentId: "robby",
          agentDir: path.join(stateDir, "agents", "robby", "agent"),
          workspaceDir,
        });
        expect(resolveOnboardingSetupTarget(config)).toMatchObject({
          agentId: "main",
          workspaceDir,
        });
      }
      expect(
        resolveOnboardingSetupTarget({
          agents: {
            entries: { main: { name: "Authored main", workspace: "/srv/main" } },
          },
        }),
      ).toMatchObject({ agentId: "main", workspaceDir: "/srv/main" });
    });
  });

  it("preserves unrelated global defaults while projecting model changes onto the authored agent", () => {
    const config = fleet(
      {
        main: { model: { primary: "openai/sibling" }, modelPolicy: { allow: ["openai/main"] } },
        OPS: modelSettings("openai/old", "Old"),
      },
      modelSettings("openai/global", "Global"),
    );
    const target = resolveOnboardingAgentTarget(config, "ops");

    const updated = applyAgentModelDefaults(config, target, (projected) => ({
      ...projected,
      plugins: { entries: { fixture: { enabled: true } } },
      agents: {
        ...projected.agents,
        defaults: {
          ...projected.agents?.defaults,
          model: { primary: "provider/selected" },
          models: {
            ...projected.agents?.defaults?.models,
            "provider/selected": { alias: "Selected" },
          },
          modelPolicy: { allow: ["provider/selected"] },
          mediaModels: { video: { primary: "media/video" } },
          experimental: { localModelLean: true },
        },
      },
    }));

    expect(updated.agents?.defaults).toEqual({
      ...modelSettings("openai/global", "Global"),
      mediaModels: { video: { primary: "media/video" } },
      experimental: { localModelLean: true },
    });
    expect(updated.agents).not.toHaveProperty("list");
    expect(updated.agents?.entries).toEqual({
      main: config.agents.entries.main,
      OPS: {
        model: { primary: "provider/selected" },
        models: {
          "openai/old": { alias: "Old" },
          "provider/selected": { alias: "Selected" },
        },
        modelPolicy: { allow: ["provider/selected"] },
      },
    });
    expect(updated.plugins?.entries?.fixture?.enabled).toBe(true);
  });

  it("keeps fleet model aliases and policy inherited when selecting a model", () => {
    const config = fleet(
      { main: { model: "openai/main" }, ops: {} },
      { ...modelSettings("openai/global", "Global"), model: "openai/global" },
    );
    const updated = applyAgentModelDefaults(
      config,
      resolveOnboardingAgentTarget(config, "ops"),
      (projected) => applyPrimaryModel(projected, "provider/selected"),
    );

    expect(updated.agents?.defaults).toEqual(config.agents.defaults);
    expect(updated.agents?.entries?.ops?.model).toEqual({ primary: "provider/selected" });
    expect(updated.agents?.entries?.ops?.models).toEqual({ "provider/selected": {} });
    expect(updated.agents?.entries?.ops?.modelPolicy).toBeUndefined();
    expect(updated.agents?.entries?.main?.model).toEqual("openai/main");
  });

  it("preserves every agent when applying the primary model", () => {
    const config = fleet({
      main: { name: "Main", model: { primary: "openai/main" } },
      OPS: {
        name: "Operations",
        model: { primary: "openai/old", fallbacks: ["openai/fallback"] },
        models: { "openai/old": { alias: "Old" } },
      },
    });
    const target = resolveOnboardingAgentTarget(config, "ops");

    const updated = applyOnboardingPrimaryModel(config, target, "openai/new");

    expect(updated.agents).not.toHaveProperty("list");
    expect(updated.agents?.entries).toEqual({
      main: config.agents.entries.main,
      OPS: {
        name: "Operations",
        model: { primary: "openai/new", fallbacks: ["openai/fallback"] },
        models: { "openai/old": { alias: "Old" }, "openai/new": {} },
      },
    });
  });

  it("provisions the sole configured agent workspace and sessions", async () => {
    const stateDir = tempDirs.make("openclaw-onboard-target-");
    const globalWorkspace = path.join(stateDir, "global-workspace");
    const opsWorkspace = path.join(stateDir, "ops-workspace");
    const runtime = { log: vi.fn() } as unknown as RuntimeEnv;

    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      const config = {
        agents: {
          defaults: { workspace: globalWorkspace },
          entries: { ops: { workspace: opsWorkspace } },
        },
      };
      const target = resolveOnboardingAgentTarget(config);

      expect(target).toEqual({
        agentId: "ops",
        agentDir: path.join(stateDir, "agents", "ops", "agent"),
        workspaceDir: opsWorkspace,
      });
      expect(resolveOnboardingAgentTarget(config, " OPS ")).toEqual(target);
      await ensureOnboardingAgentWorkspace(target, runtime, { skipBootstrap: true });

      expect((await fs.stat(opsWorkspace)).isDirectory()).toBe(true);
      expect((await fs.stat(path.join(stateDir, "agents", "ops", "sessions"))).isDirectory()).toBe(
        true,
      );
      await expect(fs.access(globalWorkspace)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        fs.access(path.join(stateDir, "agents", "main", "sessions")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    });
  });
});
