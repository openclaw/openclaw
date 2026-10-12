import { describe, expect, it } from "vitest";
import { splitConfigSchemaByTier } from "./config-form.tiers.ts";

describe("splitConfigSchemaByTier", () => {
  it("preserves nested containers while separating common and advanced leaves", () => {
    const split = splitConfigSchemaByTier({
      path: ["gateway"],
      schema: {
        type: "object",
        required: ["port", "reload"],
        properties: {
          port: { type: "integer" },
          reload: {
            type: "object",
            properties: {
              mode: { type: "string" },
              debounceMs: { type: "integer" },
            },
          },
        },
      },
      hints: {
        "gateway.port": { advanced: false },
        "gateway.reload.mode": { advanced: false },
        "gateway.reload.debounceMs": { advanced: true },
      },
    });

    expect(split.common?.properties).toEqual({
      port: { type: "integer" },
      reload: { type: "object", properties: { mode: { type: "string" } } },
    });
    expect(split.common?.required).toEqual(["port", "reload"]);
    expect(split.advanced?.properties).toEqual({
      reload: { type: "object", properties: { debounceMs: { type: "integer" } } },
    });
    expect(split.advanced?.required).toEqual(["reload"]);
  });

  it("defaults unresolved leaves to advanced", () => {
    const split = splitConfigSchemaByTier({
      path: ["future"],
      schema: { type: "object", properties: { option: { type: "boolean" } } },
      hints: {},
    });
    expect(split.common).toBeNull();
    expect(split.advanced).toEqual({
      type: "object",
      properties: { option: { type: "boolean" } },
    });
  });

  it("keeps positional tuples atomic so tier projection cannot shift indexes", () => {
    const tuple = {
      type: "array",
      items: [{ type: "string" }, { type: "integer" }],
    };
    const split = splitConfigSchemaByTier({
      path: ["pair"],
      schema: tuple,
      hints: { pair: { advanced: false } },
    });
    expect(split.common).toEqual(tuple);
    expect(split.advanced).toBeNull();
  });

  it("keeps open-ended objects atomic so fixed keys cannot reappear as extras", () => {
    const split = splitConfigSchemaByTier({
      path: ["env"],
      schema: {
        type: "object",
        properties: { enabled: { type: "boolean" } },
        additionalProperties: true,
      },
      hints: { env: { advanced: true }, "env.enabled": { advanced: false } },
    });
    expect(split.common).toBeNull();
    expect(split.advanced?.properties).toEqual({ enabled: { type: "boolean" } });
    expect(split.advanced?.additionalProperties).toBe(true);
  });

  it("keeps named properties in mixed typed maps split across tiers", () => {
    const split = splitConfigSchemaByTier({
      path: ["tools", "web", "search"],
      schema: {
        type: "object",
        properties: {
          enabled: { type: "boolean" },
          maxResults: { type: "integer" },
        },
        additionalProperties: { type: "string" },
      },
      hints: { "tools.web.search.enabled": { advanced: false } },
    });
    expect(split.common?.properties).toEqual({ enabled: { type: "boolean" } });
    expect(split.advanced?.properties).toEqual({ maxResults: { type: "integer" } });
    expect(split.common?.additionalProperties).toBeUndefined();
    expect(split.advanced?.additionalProperties).toEqual({ type: "string" });
  });

  it("keeps typed map entries whole so drafts cannot reject cross-tier fields", () => {
    const entrySchema = {
      type: "object",
      properties: {
        enabled: { type: "boolean" },
        clientId: { type: "string" },
        clientSecret: { type: "string" },
      },
      additionalProperties: false,
    };
    const split = splitConfigSchemaByTier({
      path: ["channels", "demo", "accounts"],
      schema: {
        type: "object",
        additionalProperties: entrySchema,
      },
      hints: { "channels.demo.accounts.*.enabled": { advanced: false } },
    });
    // Entry fields hinted common must not shard the map into partial copies:
    // the whole entry schema belongs to the map tier, and the other tier has no map.
    expect(split.common).toBeNull();
    expect(split.advanced?.additionalProperties).toEqual(entrySchema);
  });
});
