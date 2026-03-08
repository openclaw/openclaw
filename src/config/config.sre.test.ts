import { describe, expect, it } from "vitest";
import { OpenClawSchema } from "./zod-schema.js";

describe("sre config schema", () => {
  it("accepts optional nested feature flags", () => {
    const result = OpenClawSchema.safeParse({
      sre: {
        repoOwnership: {
          enabled: true,
          filePath: "/home/node/.openclaw/state/sre-index/repo-ownership.json",
        },
        relationshipIndex: { enabled: false },
        multiRepoPr: { enabled: false },
        stateRoots: {
          graphDir: "/home/node/.openclaw/state/sre-graph",
          dossiersDir: "/home/node/.openclaw/state/sre-dossiers",
          indexDir: "/home/node/.openclaw/state/sre-index",
          plansDir: "/home/node/.openclaw/state/sre-plans",
        },
        repoBootstrap: {
          rootDir: "/Users/florian/morpho",
        },
      },
    });

    expect(result.success).toBe(true);
  });

  it("rejects non-boolean enabled values", () => {
    const result = OpenClawSchema.safeParse({
      sre: {
        provenance: { enabled: "yes" },
      },
    });

    expect(result.success).toBe(false);
  });

  it("emits the sre block in generated schema", () => {
    const schema = OpenClawSchema.toJSONSchema({
      target: "draft-7",
      io: "input",
      reused: "ref",
    }) as {
      definitions?: Record<string, { properties?: Record<string, unknown> }>;
      properties?: Record<string, { $ref?: string }>;
    };
    const sreRef = schema.properties?.sre?.$ref;
    const definitionKey = sreRef?.split("/").pop();
    const sreSchema = definitionKey ? schema.definitions?.[definitionKey] : undefined;

    expect(sreRef).toBeDefined();
    expect(sreSchema?.properties?.repoOwnership).toBeDefined();
    expect(sreSchema?.properties?.relationshipIndex).toBeDefined();
  });
});
