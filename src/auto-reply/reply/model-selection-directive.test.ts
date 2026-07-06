import { describe, expect, it } from "vitest";
import { buildModelAliasIndex } from "../../agents/model-selection-shared.js";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveModelRefFromDirectiveString } from "./model-selection-directive.js";

describe("resolveModelRefFromDirectiveString", () => {
  it("resolves duplicate display aliases within the requested provider", () => {
    const cfg = {
      agents: {
        defaults: {
          models: {
            "local-a/model-a": { alias: "Local" },
            "local-b/model-b": { alias: "Local" },
          },
        },
      },
    } as OpenClawConfig;
    const aliasIndex = buildModelAliasIndex({ cfg, defaultProvider: "openai" });

    expect(
      resolveModelRefFromDirectiveString({
        raw: "local-a/Local",
        defaultProvider: "openai",
        aliasIndex,
      }),
    ).toEqual({ ref: { provider: "local-a", model: "model-a" }, alias: "Local" });
  });
});
