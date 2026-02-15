import { describe, expect, it } from "vitest";
import { z } from "zod";
import { __test__, isSensitiveConfigPath } from "./schema.hints.js";
import { OpenClawSchema } from "./zod-schema.js";
import { sensitive } from "./zod-schema.sensitive.js";

const { mapSensitivePaths } = __test__;

describe("isSensitiveConfigPath", () => {
  it("matches whitelist suffixes case-insensitively", () => {
    const whitelistedPaths = [
      "maxTokens",
      "maxOutputTokens",
      "maxInputTokens",
      "maxCompletionTokens",
      "contextTokens",
      "totalTokens",
      "tokenCount",
      "tokenLimit",
      "tokenBudget",
      "channels.irc.nickserv.passwordFile",
    ];
    for (const path of whitelistedPaths) {
      expect(isSensitiveConfigPath(path)).toBe(false);
      expect(isSensitiveConfigPath(path.toUpperCase())).toBe(false);
    }
  });

  it("keeps true sensitive keys redacted", () => {
    expect(isSensitiveConfigPath("channels.slack.token")).toBe(true);
    expect(isSensitiveConfigPath("models.providers.openai.apiKey")).toBe(true);
    expect(isSensitiveConfigPath("channels.irc.nickserv.password")).toBe(true);
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
  });

  it("should not detect non-sensitive fields nested inside all structural Zod types", () => {
    const GrandSchema = z.object({
      simple: z.string().optional(),
      simpleReversed: z.string().optional(),
      nested: z.object({
        nested: z.string(),
      }),
      list: z.array(z.string()),
      listOfObjects: z.array(z.object({ nested: z.string() })),
      headers: z.record(z.string(), z.string()),
      headersNested: z.record(z.string(), z.object({ nested: z.string() })),
      auth: z.union([
        z.object({ type: z.literal("none") }),
        z.object({ type: z.literal("token"), value: z.string() }),
      ]),
      merged: z.object({ id: z.string() }).and(z.object({ nested: z.string() })),
    });

    const result = mapSensitivePaths(GrandSchema, "", {});

    expect(result["simple"]?.sensitive).toBe(undefined);
    expect(result["simpleReversed"]?.sensitive).toBe(undefined);
    expect(result["nested.nested"]?.sensitive).toBe(undefined);
    expect(result["list[]"]?.sensitive).toBe(undefined);
    expect(result["listOfObjects[].nested"]?.sensitive).toBe(undefined);
    expect(result["headers.*"]?.sensitive).toBe(undefined);
    expect(result["headersNested.*.nested"]?.sensitive).toBe(undefined);
    expect(result["auth.value"]?.sensitive).toBe(undefined);
    expect(result["merged.nested"]?.sensitive).toBe(undefined);
  });

  it("main schema yields correct hints (samples)", () => {
    const schema = OpenClawSchema.toJSONSchema({
      target: "draft-07",
      unrepresentable: "any",
    });
    schema.title = "OpenClawConfig";
    const hints = mapSensitivePaths(OpenClawSchema, "", {});

    expect(hints["agents.defaults.memorySearch.remote.apiKey"]?.sensitive).toBe(true);
    expect(hints["agents.list[].memorySearch.remote.apiKey"]?.sensitive).toBe(true);
    expect(hints["channels.discord.accounts.*.token"]?.sensitive).toBe(true);
    expect(hints["gateway.auth.token"]?.sensitive).toBe(true);
    expect(hints["skills.entries.*.apiKey"]?.sensitive).toBe(true);
  });
});
