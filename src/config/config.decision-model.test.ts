import { describe, expect, it } from "vitest";
import {
  getConfiguredDecisionProviderIds,
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
});
