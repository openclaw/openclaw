import { describe, expect, it } from "vitest";

import type { ClawdbotConfig } from "../config/config.js";
import {
  applyGoogleGeminiModelDefault,
  GOOGLE_GEMINI_DEFAULT_MODEL,
} from "./google-gemini-model-default.js";

describe("applyGoogleGeminiModelDefault", () => {
  it("sets gemini default when model is unset", () => {
    const cfg: ClawdbotConfig = { agent: {} };
    const applied = applyGoogleGeminiModelDefault(cfg);
    expect(applied.changed).toBe(true);
    expect(applied.next.agent?.model).toEqual({
      primary: GOOGLE_GEMINI_DEFAULT_MODEL,
    });
  });

  it("overrides existing model", () => {
    const cfg: ClawdbotConfig = {
      agent: { model: "anthropic/claude-opus-4-5" },
    };
    const applied = applyGoogleGeminiModelDefault(cfg);
    expect(applied.changed).toBe(true);
    expect(applied.next.agent?.model).toEqual({
      primary: GOOGLE_GEMINI_DEFAULT_MODEL,
    });
  });

  it("no-ops when already gemini default", () => {
    const cfg: ClawdbotConfig = {
      agent: { model: GOOGLE_GEMINI_DEFAULT_MODEL },
    };
    const applied = applyGoogleGeminiModelDefault(cfg);
    expect(applied.changed).toBe(false);
    expect(applied.next).toEqual(cfg);
  });
});
