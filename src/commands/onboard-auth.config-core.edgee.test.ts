import { describe, expect, it } from "vitest";
import { applyEdgeeConfig, applyEdgeeProviderConfig } from "./onboard-auth.config-core.js";

describe("Edgee onboarding config", () => {
  it("applyEdgeeProviderConfig registers model alias without setting default primary", () => {
    const cfg = applyEdgeeProviderConfig({});
    expect(cfg.agents?.defaults?.models?.["edgee/openai/gpt-4o"]?.alias).toBe("Edgee");
    expect(
      (cfg.agents?.defaults?.model as { primary?: string } | undefined)?.primary,
    ).toBeUndefined();
  });

  it("applyEdgeeConfig sets edgee default model", () => {
    const cfg = applyEdgeeConfig({});
    expect((cfg.agents?.defaults?.model as { primary?: string } | undefined)?.primary).toBe(
      "edgee/openai/gpt-4o",
    );
  });
});
