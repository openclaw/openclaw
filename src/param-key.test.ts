import { describe, expect, it } from "vitest";
import { readSnakeCaseParamRaw, resolveSnakeCaseParamKey } from "./param-key.js";

describe("param-key", () => {
  it("prefers the exact key when both camelCase and snake_case exist", () => {
    const params = {
      maxTokens: 100,
      max_tokens: 200,
    };

    expect(resolveSnakeCaseParamKey(params, "maxTokens")).toBe("maxTokens");
    expect(readSnakeCaseParamRaw(params, "maxTokens")).toBe(100);
  });

  it("falls back to snake_case when the exact key is missing", () => {
    const params = {
      max_tokens: 200,
    };

    expect(resolveSnakeCaseParamKey(params, "maxTokens")).toBe("max_tokens");
    expect(readSnakeCaseParamRaw(params, "maxTokens")).toBe(200);
  });

  it("returns undefined when neither key form exists", () => {
    const params = {
      temperature: 0.7,
    };

    expect(resolveSnakeCaseParamKey(params, "maxTokens")).toBeUndefined();
    expect(readSnakeCaseParamRaw(params, "maxTokens")).toBeUndefined();
  });
});
