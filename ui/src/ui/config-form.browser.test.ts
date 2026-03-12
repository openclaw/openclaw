import { describe, expect, it } from "vitest";
import { buildConfigSchema } from "../../../src/config/schema.ts";
import { analyzeConfigSchema } from "./views/config-form.ts";

const rootSchema = {
  type: "object",
  properties: {
    gateway: {
      type: "object",
      properties: {
        auth: {
          type: "object",
          properties: {
            token: { type: "string" },
          },
        },
      },
    },
    allowFrom: {
      type: "array",
      items: { type: "string" },
    },
    mode: {
      type: "string",
      enum: ["off", "token"],
    },
    enabled: {
      type: "boolean",
    },
    bind: {
      anyOf: [{ const: "auto" }, { const: "lan" }, { const: "tailnet" }, { const: "loopback" }],
    },
  },
};

describe("config form analyzer", () => {
  it("normalizes basic field types", () => {
    const analysis = analyzeConfigSchema(rootSchema);
    expect(analysis.unsupportedPaths).toEqual([]);
    expect(analysis.schema?.properties?.gateway?.properties?.auth?.properties?.token?.type).toBe(
      "string",
    );
    expect(analysis.schema?.properties?.allowFrom?.type).toBe("array");
    expect(analysis.schema?.properties?.mode?.enum).toEqual(["off", "token"]);
    expect(analysis.schema?.properties?.enabled?.type).toBe("boolean");
  });

  it("normalizes literal unions into enums", () => {
    const analysis = analyzeConfigSchema(rootSchema);
    expect(analysis.unsupportedPaths).not.toContain("bind");
    expect(analysis.schema?.properties?.bind?.enum).toEqual(["auto", "lan", "tailnet", "loopback"]);
  });

  it("supports typed additionalProperties maps", () => {
    const schema = {
      type: "object",
      properties: {
        slack: {
          type: "object",
          additionalProperties: {
            type: "string",
          },
        },
      },
    };
    const analysis = analyzeConfigSchema(schema);
    expect(analysis.unsupportedPaths).toEqual([]);
    expect(analysis.schema?.properties?.slack?.additionalProperties).toEqual({ type: "string" });
  });

  it("supports SecretInput unions in additionalProperties maps", () => {
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
                        oneOf: [
                          {
                            type: "object",
                            properties: {
                              source: { type: "string", const: "env" },
                              provider: { type: "string" },
                              id: { type: "string" },
                            },
                            required: ["source", "provider", "id"],
                            additionalProperties: false,
                          },
                          {
                            type: "object",
                            properties: {
                              source: { type: "string", const: "file" },
                              provider: { type: "string" },
                              id: { type: "string" },
                            },
                            required: ["source", "provider", "id"],
                            additionalProperties: false,
                          },
                        ],
                      },
                    ],
                  },
                },
              },
            },
          },
        },
      },
    };
    const analysis = analyzeConfigSchema(schema);
    expect(analysis.unsupportedPaths).not.toContain("models.providers");
    expect(analysis.unsupportedPaths).not.toContain("models.providers.*.apiKey");
    const providersSchema = analysis.schema?.properties?.models?.properties?.providers;
    const providerEntrySchema =
      providersSchema &&
      typeof providersSchema.additionalProperties === "object" &&
      providersSchema.additionalProperties !== null
        ? providersSchema.additionalProperties
        : undefined;
    expect(providerEntrySchema?.properties?.apiKey?.type).toBe("string");
  });

  it("prefers string variants over structured unions", () => {
    const schema = {
      type: "object",
      properties: {
        model: {
          anyOf: [
            { type: "string" },
            {
              type: "object",
              properties: {
                primary: { type: "string" },
                fallbacks: {
                  type: "array",
                  items: { type: "string" },
                },
              },
              additionalProperties: false,
            },
          ],
        },
      },
    };
    const analysis = analyzeConfigSchema(schema);
    expect(analysis.unsupportedPaths).not.toContain("model");
    expect(analysis.schema?.properties?.model?.type).toBe("string");
  });

  it("merges discriminated object unions into editable object fields", () => {
    const schema = {
      type: "object",
      properties: {
        runtime: {
          anyOf: [
            {
              type: "object",
              properties: {
                type: { type: "string", const: "embedded" },
              },
              required: ["type"],
              additionalProperties: false,
            },
            {
              type: "object",
              properties: {
                type: { type: "string", const: "acp" },
                acp: {
                  type: "object",
                  properties: {
                    backend: { type: "string" },
                  },
                  additionalProperties: false,
                },
              },
              required: ["type"],
              additionalProperties: false,
            },
          ],
        },
      },
    };
    const analysis = analyzeConfigSchema(schema);
    expect(analysis.unsupportedPaths).not.toContain("runtime");
    expect(analysis.schema?.properties?.runtime?.type).toBe("object");
    expect(analysis.schema?.properties?.runtime?.properties?.type?.enum).toEqual([
      "embedded",
      "acp",
    ]);
    expect(analysis.schema?.properties?.runtime?.properties?.acp?.type).toBe("object");
  });

  it("prefers string variants over string-array unions", () => {
    const schema = {
      type: "object",
      properties: {
        setupCommand: {
          anyOf: [
            { type: "string" },
            {
              type: "array",
              items: { type: "string" },
            },
          ],
        },
      },
    };
    const analysis = analyzeConfigSchema(schema);
    expect(analysis.unsupportedPaths).not.toContain("setupCommand");
    expect(analysis.schema?.properties?.setupCommand?.type).toBe("string");
  });

  it("prefers primitive record values over mixed unions", () => {
    const schema = {
      type: "object",
      properties: {
        ulimits: {
          type: "object",
          additionalProperties: {
            anyOf: [
              { type: "string" },
              { type: "number" },
              {
                type: "object",
                properties: {
                  soft: { type: "integer" },
                  hard: { type: "integer" },
                },
                additionalProperties: false,
              },
            ],
          },
        },
      },
    };
    const analysis = analyzeConfigSchema(schema);
    expect(analysis.unsupportedPaths).not.toContain("ulimits");
    const ulimitsSchema = analysis.schema?.properties?.ulimits;
    const ulimitValueSchema =
      ulimitsSchema &&
      typeof ulimitsSchema.additionalProperties === "object" &&
      ulimitsSchema.additionalProperties !== null
        ? ulimitsSchema.additionalProperties
        : undefined;
    expect(ulimitValueSchema?.anyOf).toEqual([{ type: "string" }, { type: "number" }]);
  });

  it("supports generated agents config schema without known union failures", () => {
    const agentsSchema = buildConfigSchema().schema.properties?.agents;
    const analysis = analyzeConfigSchema(agentsSchema);

    expect(analysis.unsupportedPaths).toEqual([]);
    expect(analysis.unsupportedPaths).not.toContain("defaults.model");
    expect(analysis.unsupportedPaths).not.toContain("defaults.imageModel");
    expect(analysis.unsupportedPaths).not.toContain("defaults.pdfModel");
    expect(analysis.unsupportedPaths).not.toContain("defaults.subagents.model");
    expect(analysis.unsupportedPaths).not.toContain("defaults.runtime");
    expect(analysis.unsupportedPaths).not.toContain("defaults.sandbox.docker.setupCommand");
    expect(analysis.unsupportedPaths).not.toContain("defaults.sandbox.docker.ulimits");
    expect(analysis.unsupportedPaths).not.toContain("list");
  });

  it("flags unsupported non-discriminated complex unions", () => {
    const schema = {
      type: "object",
      properties: {
        mixed: {
          anyOf: [
            { type: "array", items: { type: "string" } },
            { type: "object", properties: {} },
          ],
        },
      },
    };
    const analysis = analyzeConfigSchema(schema);
    expect(analysis.unsupportedPaths).toContain("mixed");
  });

  it("supports nullable types", () => {
    const schema = {
      type: "object",
      properties: {
        note: { type: ["string", "null"] },
      },
    };
    const analysis = analyzeConfigSchema(schema);
    expect(analysis.unsupportedPaths).not.toContain("note");
    expect(analysis.schema?.properties?.note?.nullable).toBe(true);
  });

  it("ignores untyped additionalProperties schemas", () => {
    const schema = {
      type: "object",
      properties: {
        channels: {
          type: "object",
          properties: {
            whatsapp: {
              type: "object",
              properties: {
                enabled: { type: "boolean" },
              },
            },
          },
          additionalProperties: {},
        },
      },
    };
    const analysis = analyzeConfigSchema(schema);
    expect(analysis.unsupportedPaths).not.toContain("channels");
    expect(analysis.schema?.properties?.channels?.additionalProperties).toEqual({});
  });

  it("treats additionalProperties true as editable map fields", () => {
    const schema = {
      type: "object",
      properties: {
        accounts: {
          type: "object",
          additionalProperties: true,
        },
      },
    };
    const analysis = analyzeConfigSchema(schema);
    expect(analysis.unsupportedPaths).not.toContain("accounts");
    expect(analysis.schema?.properties?.accounts?.additionalProperties).toEqual({});
  });
});
