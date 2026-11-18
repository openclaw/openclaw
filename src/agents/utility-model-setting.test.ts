import { describe, expect, it } from "vitest";
import type { AgentModelConfig } from "../config/types.agents-shared.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { readUtilityModelSetting } from "./utility-model-setting.js";

const defaults = { primary: "local/small", fallbacks: ["local/backup"] };

describe("utility model inheritance", () => {
  it.each<{
    value: AgentModelConfig | undefined;
    expected: ReturnType<typeof readUtilityModelSetting>;
  }>([
    {
      value: undefined,
      expected: { kind: "explicit", modelRef: "local/small", fallbacks: ["local/backup"] },
    },
    {
      value: {},
      expected: { kind: "explicit", modelRef: "local/small", fallbacks: ["local/backup"] },
    },
    {
      value: { fallbacks: [] },
      expected: { kind: "explicit", modelRef: "local/small", fallbacks: [] },
    },
    {
      value: { fallbacks: ["other/backup"] },
      expected: { kind: "explicit", modelRef: "local/small", fallbacks: ["other/backup"] },
    },
    {
      value: " local/override ",
      expected: { kind: "explicit", modelRef: "local/override", fallbacks: [] },
    },
    {
      value: { primary: "local/override" },
      expected: { kind: "explicit", modelRef: "local/override", fallbacks: [] },
    },
    {
      value: { primary: "local/override", fallbacks: ["other/backup"] },
      expected: { kind: "explicit", modelRef: "local/override", fallbacks: ["other/backup"] },
    },
    { value: " ", expected: { kind: "disabled" } },
    { value: { primary: "", fallbacks: ["other/backup"] }, expected: { kind: "disabled" } },
  ])("resolves the agent selection $value", ({ value, expected }) => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          model: { primary: "main/large", fallbacks: ["main/expensive"] },
          utilityModel: defaults,
        },
        entries: { main: { utilityModel: value } },
      },
    };
    expect(readUtilityModelSetting(cfg, "main")).toEqual(expected);
  });

  it("retains automatic provider routing with an independent configured backup", () => {
    expect(
      readUtilityModelSetting({
        agents: { defaults: { utilityModel: { fallbacks: ["local/backup"] } } },
      }),
    ).toEqual({ kind: "auto", fallbacks: ["local/backup"] });
    expect(readUtilityModelSetting({})).toEqual({ kind: "auto", fallbacks: [] });
  });
});
