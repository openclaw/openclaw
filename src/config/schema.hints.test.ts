// Verifies schema hint metadata and sensitive path handling.
import { SENSITIVE_URL_HINT_TAG } from "@openclaw/net-policy/redact-sensitive-url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { mapSensitivePaths, testApi } from "./schema.hints.js";
import { buildConfigSchemaCore } from "./schema.js";
import { OpenClawSchema } from "./zod-schema.js";
import { OpenClawSchemaShape } from "./zod-schema.root-shape.js";
import { sensitive } from "./zod-schema.sensitive.js";

const { SECTION_DOCS_URLS } = testApi;
// Root sections without beginner-worthy pages stay explicit. Adding a root config key
// requires choosing a docsUrl or listing it here.
const SECTIONS_WITHOUT_DOCS = ["$schema", "meta", "attachments"] as const;

describe("section docs URLs", () => {
  it("accounts for every root config section", () => {
    const sectionsWithDocsDecisions = new Set([
      ...Object.keys(SECTION_DOCS_URLS),
      ...SECTIONS_WITHOUT_DOCS,
    ]);
    const undecidedSections = Object.keys(OpenClawSchemaShape).filter(
      (section) => !sectionsWithDocsDecisions.has(section),
    );

    expect(undecidedSections).toEqual([]);
  });
});

describe("inherited defaults", () => {
  it("describes omitted settings without adding them to authored config", () => {
    const { uiHints } = buildConfigSchemaCore();
    expect(uiHints["cron.enabled"]?.placeholder).toBe("Default: On");
    expect(uiHints["plugins.enabled"]?.placeholder).toBe("Default: On");

    const config = OpenClawSchema.parse({ cron: {}, plugins: {} });
    expect(config.cron).not.toHaveProperty("enabled");
    expect(config.plugins).not.toHaveProperty("enabled");
  });
});

describe("mapSensitivePaths", () => {
  it("should detect sensitive fields nested inside all structural Zod types", () => {
    const GrandSchema = z.object({
      simple: z.string().register(sensitive).optional(),
      simpleReversed: z.string().optional().register(sensitive),
      nested: z.object({
        nested: z.string().register(sensitive),
      }),
      list: z.array(z.string().register(sensitive)),
      listOfObjects: z.array(z.object({ nested: z.string().register(sensitive) })),
      headers: z.record(z.string(), z.string().register(sensitive)),
      headersNested: z.record(z.string(), z.object({ nested: z.string().register(sensitive) })),
      auth: z.union([
        z.object({ type: z.literal("none") }),
        z.object({ type: z.literal("token"), value: z.string().register(sensitive) }),
      ]),
      merged: z
        .object({ id: z.string() })
        .and(z.object({ nested: z.string().register(sensitive) })),
      deferred: z.lazy(() => z.object({ value: z.string().register(sensitive) })),
      defaulted: z.string().register(sensitive).default("synthetic"),
      nullable: z.string().register(sensitive).nullable().readonly(),
      preprocessed: z.preprocess(
        (value) => value,
        z.object({ value: z.string().register(sensitive) }),
      ),
      discriminated: z.discriminatedUnion("type", [
        z.object({ type: z.literal("none") }),
        z.object({ type: z.literal("token"), value: z.string().register(sensitive) }),
      ]),
    });

    const result = mapSensitivePaths(GrandSchema, "", {});

    expect(result["simple"]?.sensitive).toBe(true);
    expect(result["simpleReversed"]?.sensitive).toBe(true);
    expect(result["nested.nested"]?.sensitive).toBe(true);
    expect(result["list[]"]?.sensitive).toBe(true);
    expect(result["listOfObjects[].nested"]?.sensitive).toBe(true);
    expect(result["headers.*"]?.sensitive).toBe(true);
    expect(result["headersNested.*.nested"]?.sensitive).toBe(true);
    expect(result["auth.value"]?.sensitive).toBe(true);
    expect(result["merged.nested"]?.sensitive).toBe(true);
    expect(result["deferred.value"]?.sensitive).toBe(true);
    expect(result["defaulted"]?.sensitive).toBe(true);
    expect(result["nullable"]?.sensitive).toBe(true);
    expect(result["preprocessed.value"]?.sensitive).toBe(true);
    expect(result["discriminated.value"]?.sensitive).toBe(true);
  });

  it("maps sensitive fields nested under object catchall schemas", () => {
    const schema = z.object({
      custom: z.object({}).catchall(
        z.object({
          apiKey: z.string().register(sensitive),
          label: z.string(),
        }),
      ),
    });

    const result = mapSensitivePaths(schema, "", {});
    expect(result["custom.*.apiKey"]?.sensitive).toBe(true);
    expect(result["custom.*.label"]?.sensitive).toBe(undefined);
  });

  it("main schema yields correct hints (samples)", () => {
    const hints = mapSensitivePaths(OpenClawSchema, "", {});

    expect(hints["memory.search.remote.apiKey"]?.sensitive).toBe(true);
    expect(hints["agents.entries.*.memory.search.remote.apiKey"]?.sensitive).toBe(true);
    expect(hints["gateway.auth.token"]?.sensitive).toBe(true);
    expect(hints["models.providers.*.headers.*"]?.sensitive).toBe(true);
    expect(hints["models.providers.*.localService.env.*"]?.sensitive).toBe(true);
    expect(hints["models.providers.*.request.headers.*"]?.sensitive).toBe(true);
    expect(hints["models.providers.*.request.proxy.tls.cert"]?.sensitive).toBe(true);
    expect(hints["proxy.proxyUrl"]?.sensitive).toBe(true);
    expect(hints["proxy.tls.caFile"]?.sensitive).toBeUndefined();
    expect(hints["skills.entries.*.apiKey"]?.sensitive).toBe(true);
  });

  it("tags base-config URL fields that may embed secrets", () => {
    const hints = mapSensitivePaths(OpenClawSchema, "", {});
    for (const path of [
      "mcp.servers.*.url",
      "models.providers.*.baseUrl",
      "models.providers.*.request.proxy.url",
      "tools.media.audio.request.proxy.url",
    ]) {
      expect(hints[path]?.tags, path).toContain(SENSITIVE_URL_HINT_TAG);
    }
  });
});

describe("authored schema hints", () => {
  it("preserves authored metadata without deriving tags from field names or tiers", () => {
    const result = buildConfigSchemaCore({
      plugins: [
        {
          id: "authored-metadata",
          configSchema: {
            type: "object",
            properties: {
              maxTokens: { type: "integer" },
              storagePath: { type: "string" },
              apiKey: { type: "string" },
            },
          },
          configUiHints: {
            maxTokens: { sensitive: false },
            storagePath: { tags: ["User-defined"], advanced: true },
            apiKey: { sensitive: true },
          },
        },
      ],
      channels: [
        {
          id: "authored-metadata-channel",
          configSchema: { type: "object", properties: { retryLimit: { type: "integer" } } },
          configUiHints: { retryLimit: { tags: ["Tuning"] } },
        },
      ],
    });
    const hints = result.uiHints;
    expect(hints["gateway.auth.token"]?.tags).toBeUndefined();
    expect(hints["plugins.entries.authored-metadata.config.maxTokens"]).toMatchObject({
      sensitive: false,
    });
    expect(hints["plugins.entries.authored-metadata.config.maxTokens"]?.tags).toBeUndefined();
    expect(hints["plugins.entries.authored-metadata.config.storagePath"]).toMatchObject({
      tags: ["User-defined"],
      advanced: true,
    });
    expect(hints["plugins.entries.authored-metadata.config.apiKey"]?.sensitive).toBe(true);
    expect(hints["plugins.entries.authored-metadata.config.apiKey"]?.tags).toBeUndefined();
    expect(hints["channels.authored-metadata-channel.retryLimit"]?.tags).toEqual(["Tuning"]);
    expect(hints["mcp.servers.*.url"]?.tags).toContain(SENSITIVE_URL_HINT_TAG);
  });
});
