import { describe, expect, it } from "vitest";
import { analyzeConfigSchema } from "../../ui/src/ui/views/config-form.analyze.ts";

describe("config form schema analysis", () => {
  it("keeps SecretInput-like string-or-object unions editable under models.providers", () => {
    const schema = {
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
                  apiKey: {
                    anyOf: [
                      { type: "string" },
                      {
                        type: "object",
                        properties: {
                          source: { type: "string", enum: ["env", "file", "exec"] },
                          name: { type: "string" },
                        },
                        additionalProperties: false,
                      },
                    ],
                  },
                  baseUrl: { type: "string" },
                },
                additionalProperties: false,
              },
            },
          },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    };

    const analysis = analyzeConfigSchema(schema);
    expect(analysis.unsupportedPaths).not.toContain("models.providers");
    expect(analysis.unsupportedPaths).not.toContain("models.providers.*.apiKey");

    const root = analysis.schema as {
      properties?: Record<string, unknown>;
    };
    const models = root.properties?.models as {
      properties?: Record<string, unknown>;
    };
    const providers = models.properties?.providers as {
      additionalProperties?: unknown;
    };
    const providerEntry = providers.additionalProperties as {
      properties?: Record<string, unknown>;
    };
    const apiKey = providerEntry.properties?.apiKey as {
      anyOf?: unknown[];
      oneOf?: unknown[];
    };
    expect(Array.isArray(apiKey.anyOf) || Array.isArray(apiKey.oneOf)).toBe(true);
  });

  it("does not mark simple string-or-object unions as unsupported", () => {
    const schema = {
      type: "object",
      properties: {
        mixed: {
          anyOf: [
            { type: "string" },
            { type: "object", properties: {}, additionalProperties: false },
          ],
        },
      },
      additionalProperties: false,
    };

    const analysis = analyzeConfigSchema(schema);
    expect(analysis.unsupportedPaths).not.toContain("mixed");
  });
});
