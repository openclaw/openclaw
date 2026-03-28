import { describe, expect, it } from "vitest";
import type { ConfigSchemaResponse, ConfigUiHints } from "./schema.js";
import { validateConfigPath } from "./validate-config-path.js";

function createSchemaInfo(schema: Record<string, unknown>, uiHints: ConfigUiHints = {}) {
  return {
    schema,
    uiHints,
    version: "test",
    generatedAt: "2026-03-28T00:00:00.000Z",
  } satisfies ConfigSchemaResponse;
}

describe("validateConfigPath", () => {
  it("allows nested paths under unconstrained object maps", () => {
    const schemaInfo = createSchemaInfo({
      type: "object",
      properties: {
        plugins: {
          type: "object",
          properties: {
            entries: {
              type: "object",
              additionalProperties: {
                type: "object",
                properties: {
                  config: {
                    type: "object",
                    additionalProperties: {},
                  },
                },
                additionalProperties: false,
              },
            },
          },
        },
      },
    });

    expect(
      validateConfigPath(
        ["plugins", "entries", "my-plugin", "config", "runtime", "endpoint"],
        schemaInfo,
      ).valid,
    ).toBe(true);
  });

  it("rejects invalid descendants under known properties even when parent allows unknown keys", () => {
    const schemaInfo = createSchemaInfo({
      type: "object",
      properties: {
        channels: {
          type: "object",
          properties: {
            telegram: {
              type: "object",
              properties: {
                token: { type: "string" },
              },
              additionalProperties: false,
            },
          },
          additionalProperties: true,
        },
      },
    });

    expect(validateConfigPath(["channels", "telegram", "token", "foo"], schemaInfo).valid).toBe(
      false,
    );
  });

  it("keeps hybrid array object schemas reachable by property name", () => {
    const schemaInfo = createSchemaInfo({
      type: "object",
      properties: {
        hybrid: {
          type: ["array", "object"],
          items: { type: "string" },
          properties: {
            meta: { type: "string" },
          },
        },
      },
    });

    expect(validateConfigPath(["hybrid", "meta"], schemaInfo).valid).toBe(true);
  });

  it("caps suggestions at two visible entries", () => {
    const schemaInfo = createSchemaInfo(
      {
        type: "object",
        properties: {
          tools: {
            type: "object",
            properties: {
              fs: {
                type: "object",
                properties: {
                  workspaceOnly: { type: "boolean" },
                },
              },
            },
          },
          agents: {
            type: "object",
            properties: {
              list: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    tools: {
                      type: "object",
                      properties: {
                        fs: {
                          type: "object",
                          properties: {
                            workspaceOnly: { type: "boolean" },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      {
        "tools.fs.workspaceOnly": {},
        "agents.list[].tools.fs.workspaceOnly": {},
        "tools.fs.workspaceWrite": {},
      },
    );

    const result = validateConfigPath(
      ["agents", "defaults", "tools", "fs", "workspaceOnly"],
      schemaInfo,
    );

    expect(result.suggestions).toHaveLength(2);
    expect(result.suggestions).toEqual([
      "tools.fs.workspaceOnly",
      "agents.list[0].tools.fs.workspaceOnly",
    ]);
  });
});
