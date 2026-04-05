import { describe, expect, it } from "vitest";
import { SENSITIVE_URL_HINT_TAG } from "../shared/net/redact-sensitive-url.js";
import { computeBaseConfigSchemaResponse } from "./schema-base.js";
import { GENERATED_BASE_CONFIG_SCHEMA } from "./schema.base.generated.js";

type JsonSchemaNode = {
  readonly anyOf?: readonly JsonSchemaNode[];
  readonly items?: JsonSchemaNode;
  readonly properties?: Readonly<Record<string, JsonSchemaNode>>;
  readonly type?: string;
};

function getObjectVariant(node: JsonSchemaNode | undefined): JsonSchemaNode | undefined {
  return node?.anyOf?.find((entry) => entry.type === "object");
}

describe("generated base config schema", () => {
  it("matches the computed base config schema payload", () => {
    expect(
      computeBaseConfigSchemaResponse({
        generatedAt: GENERATED_BASE_CONFIG_SCHEMA.generatedAt,
      }),
    ).toEqual(GENERATED_BASE_CONFIG_SCHEMA);
  });

  it("includes explicit URL-secret tags for sensitive URL fields", () => {
    expect(GENERATED_BASE_CONFIG_SCHEMA.uiHints["mcp.servers.*.url"]?.tags).toContain(
      SENSITIVE_URL_HINT_TAG,
    );
    expect(GENERATED_BASE_CONFIG_SCHEMA.uiHints["models.providers.*.baseUrl"]?.tags).toContain(
      SENSITIVE_URL_HINT_TAG,
    );
  });

  it("omits legacy hooks.internal.handlers from the public schema payload", () => {
    const hooksInternalProperties = (
      GENERATED_BASE_CONFIG_SCHEMA.schema as {
        properties?: {
          hooks?: {
            properties?: {
              internal?: {
                properties?: Record<string, unknown>;
              };
            };
          };
        };
      }
    ).properties?.hooks?.properties?.internal?.properties;
    const uiHints = GENERATED_BASE_CONFIG_SCHEMA.uiHints as Record<string, unknown>;

    expect(hooksInternalProperties?.handlers).toBeUndefined();
    expect(uiHints["hooks.internal.handlers"]).toBeUndefined();
  });

  it("only exposes fallbacksFromModels on agents.defaults.model", () => {
    const root = GENERATED_BASE_CONFIG_SCHEMA.schema as JsonSchemaNode;
    const agents = root.properties?.agents?.properties;
    const defaults = agents?.defaults?.properties;
    const listItem = agents?.list?.items;
    const subagents = defaults?.subagents?.properties;

    expect(getObjectVariant(defaults?.model)?.properties?.fallbacksFromModels).toBeDefined();
    expect(getObjectVariant(defaults?.imageModel)?.properties?.fallbacksFromModels).toBeUndefined();
    expect(
      getObjectVariant(defaults?.imageGenerationModel)?.properties?.fallbacksFromModels,
    ).toBeUndefined();
    expect(getObjectVariant(defaults?.pdfModel)?.properties?.fallbacksFromModels).toBeUndefined();
    expect(
      getObjectVariant(listItem?.properties?.model)?.properties?.fallbacksFromModels,
    ).toBeUndefined();
    expect(getObjectVariant(subagents?.model)?.properties?.fallbacksFromModels).toBeUndefined();
  });
});
