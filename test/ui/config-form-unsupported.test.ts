import { describe, expect, it } from "vitest";
import { analyzeConfigSchema } from "../../ui/src/ui/views/config-form.analyze.ts";
import { isUnsupportedNodePath } from "../../ui/src/ui/views/config-form.node.ts";

const providersWithSecretUnionSchema = {
  type: "object",
  properties: {
    models: {
      type: "object",
      properties: {
        providers: {
          type: "object",
          additionalProperties: {
            type: "object",
            properties: {
              baseUrl: { type: "string" },
              apiKey: {
                anyOf: [
                  { type: "string" },
                  {
                    type: "object",
                    properties: {
                      source: { const: "env" },
                      id: { type: "string" },
                    },
                  },
                ],
              },
            },
          },
        },
      },
    },
  },
} as const;

describe("config form unsupported-path handling", () => {
  it("keeps models.providers map supported when only nested wildcard field is unsupported", () => {
    const analysis = analyzeConfigSchema(providersWithSecretUnionSchema);

    expect(analysis.unsupportedPaths).toContain("models.providers.*.apiKey");
    expect(analysis.unsupportedPaths).not.toContain("models.providers");
  });

  it("matches wildcard unsupported paths against concrete map keys", () => {
    const analysis = analyzeConfigSchema(providersWithSecretUnionSchema);
    const unsupported = new Set(analysis.unsupportedPaths);

    expect(isUnsupportedNodePath(unsupported, "models.providers.xai.apiKey")).toBe(true);
    expect(isUnsupportedNodePath(unsupported, "models.providers.openai.apiKey")).toBe(true);
    expect(isUnsupportedNodePath(unsupported, "models.providers.xai.baseUrl")).toBe(false);
  });
});
