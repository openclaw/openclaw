/** Unsloth Studio tokens are sent as bearer auth unless config opts out. */
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { applyAuthHeaderOverride } from "./model-auth-model.js";

const TOKEN = "sk-unsloth-test";

function config(authHeader?: boolean): OpenClawConfig {
  return {
    models: {
      providers: {
        unsloth: {
          baseUrl: "http://127.0.0.1:8888",
          api: "anthropic-messages",
          ...(authHeader === undefined ? {} : { authHeader }),
          models: [],
        },
      },
    },
  };
}

describe("unsloth auth header", () => {
  it("sends the token as a bearer header when authHeader is omitted", () => {
    const model = applyAuthHeaderOverride(
      { provider: "unsloth", headers: {} },
      { apiKey: TOKEN, source: "env: UNSLOTH_API_KEY", mode: "api-key" },
      config(),
    );

    expect(model.headers?.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("leaves vendor auth alone when authHeader is false", () => {
    const model = applyAuthHeaderOverride(
      { provider: "unsloth", headers: {} },
      { apiKey: TOKEN, source: "env: UNSLOTH_API_KEY", mode: "api-key" },
      config(false),
    );

    expect(model.headers?.Authorization).toBeUndefined();
  });
});
