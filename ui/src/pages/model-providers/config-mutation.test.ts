// @vitest-environment node
import { describe, expect, it } from "vitest";
import { applyMergePatch } from "../../../../src/config/merge-patch.js";
import {
  buildDefaultsPatch,
  modelProviderErrorMessage,
  modelDefaultsActions,
  readModelBehaviorConfig,
} from "./config-mutation.ts";
import { readModelProviderConfig } from "./data.ts";

describe("model provider config patches", () => {
  it.each([
    "fixture/utility",
    { primary: "fixture/utility", fallbacks: ["fixture/backup", "fixture/last"] },
    { fallbacks: ["fixture/backup"] },
    { primary: "fixture/utility", fallbacks: [] },
  ])("preserves utility setting %j when another default changes", (utilityModel) => {
    const config = { agents: { defaults: { utilityModel } } };
    const defaults = readModelProviderConfig(config).defaults;
    const patch = buildDefaultsPatch({
      ...defaults,
      ...readModelBehaviorConfig({}),
      thinkingLevel: "high",
      thinkingOverridden: true,
    });
    expect(applyMergePatch(config, patch)).toMatchObject({
      agents: { defaults: { utilityModel } },
    });
  });

  it("edits utility defaults without changing the regular model chain", () => {
    let defaults = readModelProviderConfig({
      agents: {
        defaults: {
          model: { primary: "fixture/chat", fallbacks: ["fixture/chat-backup"] },
          utilityModel: {
            primary: "fixture/utility",
            fallbacks: ["fixture/backup", "fixture/last"],
          },
        },
      },
    }).defaults;
    const actions = modelDefaultsActions(
      () => defaults,
      (patch) => {
        defaults = { ...defaults, ...patch };
      },
    );
    actions.onUtilityChange("fixture/next");
    expect(defaults.utilityModel).toEqual({
      primary: "fixture/next",
      fallbacks: ["fixture/backup", "fixture/last"],
    });
    actions.onUtilityFallbackChange("fixture/new-backup");
    expect(defaults.utilityModel).toEqual({
      primary: "fixture/next",
      fallbacks: ["fixture/new-backup", "fixture/last"],
    });
    actions.onUtilityChange(null);
    expect(defaults.utilityModel).toEqual({ fallbacks: ["fixture/new-backup", "fixture/last"] });
    actions.onUtilityFallbackChange(null);
    expect(defaults.utilityModel).toEqual({ fallbacks: [] });
    expect(defaults.primary).toBe("fixture/chat");
    expect(defaults.fallbacks).toEqual(["fixture/chat-backup"]);
    actions.onUtilityChange("");
    expect(defaults.utilityModel).toEqual({ primary: "", fallbacks: [] });
  });

  it("restores automatic utility routing without losing its fallbacks through a merge patch", () => {
    const config = {
      agents: {
        defaults: { utilityModel: { primary: "fixture/utility", fallbacks: ["fixture/backup"] } },
      },
    };
    let defaults = readModelProviderConfig(config).defaults;
    modelDefaultsActions(
      () => defaults,
      (patch) => {
        defaults = { ...defaults, ...patch };
      },
    ).onUtilityChange(null);
    expect(
      applyMergePatch(config, buildDefaultsPatch({ ...defaults, ...readModelBehaviorConfig({}) })),
    ).toEqual({ agents: { defaults: { utilityModel: { fallbacks: ["fixture/backup"] } } } });
  });

  it("preserves a configured Ultrafast preference when another default is saved", () => {
    const behavior = readModelBehaviorConfig({ fastModeDefault: "ultrafast" });
    expect(behavior.fastMode).toBe("ultrafast");
    expect(
      buildDefaultsPatch({
        primary: "openai/model",
        fallbacks: [],
        utilityModel: null,
        ...behavior,
      }),
    ).toMatchObject({ agents: { defaults: { fastModeDefault: "ultrafast" } } });
  });
  it("redacts secrets in displayed mutation failures", () => {
    expect(modelProviderErrorMessage(new Error("OPENAI_API_KEY=sk-1234567890abcdef"))).toBe(
      "OPENAI_API_KEY=sk-123...cdef",
    );
  });

  it("batches model and behavior defaults into one patch", () => {
    expect(
      buildDefaultsPatch({
        primary: "openai/gpt-5",
        fallbacks: [],
        utilityModel: null,
        thinkingLevel: "high",
        thinkingOverridden: true,
        fastMode: false,
        fastModeOverridden: true,
      }),
    ).toEqual({
      agents: {
        defaults: {
          model: "openai/gpt-5",
          utilityModel: null,
          thinkingDefault: "high",
          fastModeDefault: false,
        },
      },
    });
    expect(
      buildDefaultsPatch({
        primary: "openai/gpt-5",
        fallbacks: ["anthropic/claude-sonnet-4-5"],
        utilityModel: "openai/gpt-5-mini",
        thinkingLevel: undefined,
        thinkingOverridden: false,
        fastMode: undefined,
        fastModeOverridden: false,
      }),
    ).toEqual({
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-5",
            fallbacks: ["anthropic/claude-sonnet-4-5"],
          },
          utilityModel: "openai/gpt-5-mini",
          thinkingDefault: null,
          fastModeDefault: null,
        },
      },
    });
  });

  it.each(["openai/gpt-5-mini", "", null])(
    "persists utility setting %j without an explicit primary model",
    (utilityModel) => {
      expect(
        buildDefaultsPatch({
          primary: "",
          fallbacks: [],
          utilityModel,
          thinkingLevel: undefined,
          thinkingOverridden: false,
          fastMode: undefined,
          fastModeOverridden: false,
        }),
      ).toEqual({
        agents: { defaults: { utilityModel, thinkingDefault: null, fastModeDefault: null } },
      });
    },
  );
});
