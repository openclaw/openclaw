import { describe, expect, it } from "vitest";
import {
  getConfiguredDecisionProviderIds,
  resolveDecisionModelSelection,
  resolveDecisionModelSetting,
} from "../agents/decision-model-setting.js";
import type { OpenClawConfig } from "./types.openclaw.js";
import { OpenClawSchema } from "./zod-schema.js";

describe("decision model configuration", () => {
  it("keeps decision routing independent of chat and utility models and preserves agent disablement", () => {
    const config: OpenClawConfig = {
      agents: {
        ownership: "explicit",
        defaults: {
          model: "chat/large",
          utilityModel: "chat/small",
          decisionModel: " typesafe/jev-latest ",
        },
        entries: {
          inherited: {},
          disabled: { decisionModel: "" },
          overridden: { decisionModel: "local/fast" },
        },
      },
    };
    const parsed = OpenClawSchema.parse(config);
    expect(parsed.agents?.defaults?.decisionModel).toBe("typesafe/jev-latest");
    expect(resolveDecisionModelSetting(config)).toEqual({
      provider: "typesafe",
      model: "jev-latest",
    });
    expect(resolveDecisionModelSetting(config, "inherited")).toEqual({
      provider: "typesafe",
      model: "jev-latest",
    });
    expect(resolveDecisionModelSetting(config, "disabled")).toBeUndefined();
    expect(resolveDecisionModelSetting(config, "overridden")).toEqual({
      provider: "local",
      model: "fast",
    });
    expect(getConfiguredDecisionProviderIds(config)).toEqual(["typesafe", "local"]);
    expect(
      resolveDecisionModelSetting({ agents: { defaults: { model: "chat/large" } } }),
    ).toBeUndefined();
  });

  it("resolves task overrides before scalar defaults and supports task-only agents", () => {
    const config: OpenClawConfig = {
      agents: {
        defaults: {
          decisionModel: "fallback/scalar",
          decisionModelsByTask: {
            decision_evaluate: "global/task",
            [`${"x".repeat(128)}/review`]: "global/plugin-task",
            "@P/Entry.v2/off": "",
          },
        },
        entries: {
          worker: { decisionModelsByTask: { decision_evaluate: "agent/task" } },
          disabled: {
            decisionModel: "",
            decisionModelsByTask: { decision_evaluate: "should/not/run" },
          },
          taskDisabled: { decisionModelsByTask: { decision_evaluate: "" } },
        },
      },
    };

    OpenClawSchema.parse({ agents: { ...config.agents, ownership: "explicit" } });
    expect(resolveDecisionModelSelection(config, "worker", "decision_evaluate")).toMatchObject({
      source: "agent-task",
      disabled: false,
      selection: { provider: "agent", model: "task" },
    });
    expect(resolveDecisionModelSetting(config, "worker", `${"x".repeat(128)}/review`)).toEqual({
      provider: "global",
      model: "plugin-task",
    });
    expect(resolveDecisionModelSetting(config, "worker")).toEqual({
      provider: "fallback",
      model: "scalar",
    });
    const taskOnlyConfig: OpenClawConfig = {
      agents: {
        entries: { taskOnly: { decisionModelsByTask: { decision_evaluate: "task/only" } } },
      },
    };
    expect(resolveDecisionModelSetting(taskOnlyConfig, "taskOnly", "decision_evaluate")).toEqual({
      provider: "task",
      model: "only",
    });
    expect(resolveDecisionModelSetting(config, "disabled", "decision_evaluate")).toBeUndefined();
    expect(
      resolveDecisionModelSetting(config, "taskDisabled", "decision_evaluate"),
    ).toBeUndefined();
    expect(resolveDecisionModelSetting(config, "worker", "@P/Entry.v2/off")).toBeUndefined();
    expect(getConfiguredDecisionProviderIds(config)).toEqual(["fallback", "global", "agent"]);
  });

  it.each(["bare-model", "/model", "provider/", null, false, 7, {}, "x".repeat(513)])(
    "rejects an invalid decision model at global and agent scope: %j",
    (decisionModel) => {
      expect(
        OpenClawSchema.safeParse({
          agents: { ownership: "explicit", defaults: { decisionModel }, entries: { worker: {} } },
        }).success,
      ).toBe(false);
      expect(
        OpenClawSchema.safeParse({
          agents: { ownership: "explicit", entries: { worker: { decisionModel } } },
        }).success,
      ).toBe(false);
    },
  );

  it("accepts opt-in and explicit disablement, without the unpublished judgments selector", () => {
    expect(OpenClawSchema.safeParse({}).success).toBe(true);
    expect(
      OpenClawSchema.safeParse({
        agents: { ownership: "explicit", defaults: { decisionModel: "" }, entries: { worker: {} } },
      }).success,
    ).toBe(true);
    expect(OpenClawSchema.safeParse({ judgments: { provider: "typesafe" } }).success).toBe(false);
  });

  it.each(["not-a-task", "plugin//", "plugin/task\n", "x".repeat(129)])(
    "rejects an invalid task selector key: %j",
    (taskId) => {
      expect(
        OpenClawSchema.safeParse({
          agents: {
            defaults: { decisionModelsByTask: { [taskId]: "provider/model" } },
          },
        }).success,
      ).toBe(false);
    },
  );
});
