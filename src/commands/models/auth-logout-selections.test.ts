import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { removeModelAuthProfileSelections } from "./auth-logout-selections.js";

describe("utility model auth selection cleanup", () => {
  it("strips removed profiles throughout a utility chain and preserves independent agent pins", () => {
    const config: OpenClawConfig = {
      agents: {
        defaults: {
          utilityModel: {
            primary: "local/primary@local:shared",
            fallbacks: ["local/backup@local:shared", "local/other@local:keep"],
          },
        },
        entries: {
          main: {},
          independent: {},
          custom: { utilityModel: { fallbacks: ["local/custom@local:shared"] } },
          disabled: { utilityModel: "" },
        },
      },
    };
    const result = removeModelAuthProfileSelections(config, {
      shared: new Set(["local:shared"]),
      agents: new Map([
        ["main", new Set(["local:shared"])],
        ["custom", new Set(["local:shared"])],
      ]),
    });

    expect(result.agents?.defaults?.utilityModel).toEqual({
      primary: "local/primary",
      fallbacks: ["local/backup", "local/other@local:keep"],
    });
    expect(result.agents?.entries?.main?.utilityModel).toBeUndefined();
    expect(result.agents?.entries?.independent?.utilityModel).toEqual(
      config.agents?.defaults?.utilityModel,
    );
    expect(result.agents?.entries?.custom?.utilityModel).toEqual({
      fallbacks: ["local/custom"],
    });
    expect(result.agents?.entries?.disabled?.utilityModel).toBe("");
    expect(config.agents?.defaults?.utilityModel).toEqual({
      primary: "local/primary@local:shared",
      fallbacks: ["local/backup@local:shared", "local/other@local:keep"],
    });
  });
});
