import { describe, expect, it } from "vitest";
import type { EasyHubConfig } from "../config/config.js";
import {
  applyGoogleGeminiModelDefault,
  GOOGLE_GEMINI_DEFAULT_MODEL,
} from "./google-gemini-model-default.js";

describe("applyGoogleGeminiModelDefault", () => {
  it("sets gemini default when model is unset", () => {
    const cfg: EasyHubConfig = { agents: { defaults: {} } };
    const applied = applyGoogleGeminiModelDefault(cfg);
    expect(applied.changed).toBe(true);
    expect(applied.next.agents?.defaults?.model).toEqual({
      primary: GOOGLE_GEMINI_DEFAULT_MODEL,
    });
  });

  it("overrides existing model", () => {
    const cfg: EasyHubConfig = {
      agents: { defaults: { model: "anthropic/claude-opus-4-5" } },
    };
    const applied = applyGoogleGeminiModelDefault(cfg);
    expect(applied.changed).toBe(true);
    expect(applied.next.agents?.defaults?.model).toEqual({
      primary: GOOGLE_GEMINI_DEFAULT_MODEL,
    });
  });

  it("no-ops when already gemini default", () => {
    const cfg: EasyHubConfig = {
      agents: { defaults: { model: GOOGLE_GEMINI_DEFAULT_MODEL } },
    };
    const applied = applyGoogleGeminiModelDefault(cfg);
    expect(applied.changed).toBe(false);
    expect(applied.next).toEqual(cfg);
  });
});
