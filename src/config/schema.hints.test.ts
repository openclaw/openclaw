import { SENSITIVE_URL_HINT_TAG } from "@openclaw/net-policy/redact-sensitive-url";
import { expect, it } from "vitest";
import { z } from "zod";
import { mapSensitivePaths } from "./schema.hints.js";
import { buildConfigSchemaCore } from "./schema.js";
import { OpenClawSchema } from "./zod-schema.js";
import { sensitive } from "./zod-schema.sensitive.js";

const secret = () => z.string().register(sensitive);
const branches = () =>
  [
    z.object({ type: z.literal("none") }),
    z.object({ type: z.literal("token"), value: secret() }),
  ] as const;
function expectSensitive(hints: ReturnType<typeof mapSensitivePaths>, paths: string) {
  const fields = paths.trim().split(/\s+/);
  expect(hints).toMatchObject(
    Object.fromEntries(fields.map((path) => [path, { sensitive: true }])),
  );
}

it("describes omitted settings without adding them to authored config", () => {
  const { uiHints } = buildConfigSchemaCore();
  const config = OpenClawSchema.parse({ cron: { triggers: {} }, plugins: {} });
  for (const section of ["cron", "plugins"] as const) {
    expect(uiHints[`${section}.enabled`]).toMatchObject({ placeholder: "Default: On" });
    expect(config[section]).not.toHaveProperty("enabled");
  }
  expect(uiHints["cron.triggers.enabled"]).toMatchObject({ placeholder: "Default: On" });
  expect(config.cron?.triggers).not.toHaveProperty("enabled");
});

it("maps sensitive fields through every structural Zod type", () => {
  for (const [kind, field, suffix] of [
    ["optional", secret().optional(), ""],
    ["optional then sensitive", z.string().optional().register(sensitive), ""],
    ["object", z.object({ nested: secret() }), ".nested"],
    ["array", z.array(secret()), "[]"],
    ["object array", z.array(z.object({ nested: secret() })), "[].nested"],
    ["record", z.record(z.string(), secret()), ".*"],
    ["object record", z.record(z.string(), z.object({ nested: secret() })), ".*.nested"],
    ["union", z.union(branches()), ".value"],
    ["intersection", z.object({ id: z.string() }).and(z.object({ nested: secret() })), ".nested"],
    ["lazy", z.lazy(() => z.object({ value: secret() })), ".value"],
    ["default", secret().default("synthetic"), ""],
    ["nullable readonly", secret().nullable().readonly(), ""],
    ["preprocess", z.preprocess((value) => value, z.object({ value: secret() })), ".value"],
    ["discriminated union", z.discriminatedUnion("type", branches()), ".value"],
  ] as const) {
    const hints = mapSensitivePaths(z.object({ field }), "", {});
    expect(hints, kind).toMatchObject({ [`field${suffix}`]: { sensitive: true } });
  }
});

it("maps sensitive fields nested under object catchall schemas", () => {
  const custom = z.object({}).catchall(z.object({ apiKey: secret(), label: z.string() }));
  const result = mapSensitivePaths(z.object({ custom }), "", {});
  expect(result["custom.*.apiKey"]?.sensitive).toBe(true);
  expect(result["custom.*.label"]?.sensitive).toBe(undefined);
});

it("main schema yields correct hints (samples)", () => {
  const hints = mapSensitivePaths(OpenClawSchema, "", {});

  expectSensitive(
    hints,
    `
    memory.search.remote.apiKey agents.entries.*.memory.search.remote.apiKey gateway.auth.token
    models.providers.*.headers.* models.providers.*.localService.env.*
    models.providers.*.request.headers.* models.providers.*.request.proxy.tls.cert
    proxy.proxyUrl skills.entries.*.apiKey
  `,
  );
  expect(hints["proxy.tls.caFile"]?.sensitive).toBeUndefined();
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

it("preserves authored metadata without deriving tags from field names or tiers", () => {
  const { uiHints: hints } = buildConfigSchemaCore({
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
  expect(hints["gateway.auth.token"]?.tags).toBeUndefined();
  const plugin = (key: string) => hints[`plugins.entries.authored-metadata.config.${key}`];
  expect([plugin("maxTokens")?.sensitive, plugin("maxTokens")?.tags]).toEqual([false, undefined]);
  expect(plugin("storagePath")).toMatchObject({ tags: ["User-defined"], advanced: true });
  expect([plugin("apiKey")?.sensitive, plugin("apiKey")?.tags]).toEqual([true, undefined]);
  expect(hints["channels.authored-metadata-channel.retryLimit"]?.tags).toEqual(["Tuning"]);
  expect(hints["mcp.servers.*.url"]?.tags).toContain(SENSITIVE_URL_HINT_TAG);
});
