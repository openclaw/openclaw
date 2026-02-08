import { describe, expect, it } from "vitest";
import { ModelCompatSchema, ModelDefinitionSchema } from "./zod-schema.core.js";

describe("ModelCompatSchema", () => {
  it("accepts supportsStrictMode: true", () => {
    const result = ModelCompatSchema.safeParse({ supportsStrictMode: true });
    expect(result.success).toBe(true);
    expect(result.data?.supportsStrictMode).toBe(true);
  });

  it("accepts supportsStrictMode: false", () => {
    const result = ModelCompatSchema.safeParse({ supportsStrictMode: false });
    expect(result.success).toBe(true);
    expect(result.data?.supportsStrictMode).toBe(false);
  });

  it("accepts undefined supportsStrictMode", () => {
    const result = ModelCompatSchema.safeParse({});
    expect(result.success).toBe(true);
    expect(result.data?.supportsStrictMode).toBeUndefined();
  });
});

describe("ModelDefinitionSchema with compat.supportsStrictMode", () => {
  it("accepts model with supportsStrictMode: false", () => {
    const modelDef = {
      id: "route-llm",
      name: "RouteLLM",
      compat: { supportsStrictMode: false },
    };
    const result = ModelDefinitionSchema.safeParse(modelDef);
    expect(result.success).toBe(true);
    expect(result.data?.compat?.supportsStrictMode).toBe(false);
  });

  it("accepts model with multiple compat options including supportsStrictMode", () => {
    const modelDef = {
      id: "custom-model",
      name: "Custom Model",
      compat: {
        supportsDeveloperRole: false,
        supportsStrictMode: false,
        supportsReasoningEffort: true,
      },
    };
    const result = ModelDefinitionSchema.safeParse(modelDef);
    expect(result.success).toBe(true);
    expect(result.data?.compat?.supportsDeveloperRole).toBe(false);
    expect(result.data?.compat?.supportsStrictMode).toBe(false);
    expect(result.data?.compat?.supportsReasoningEffort).toBe(true);
  });
});
