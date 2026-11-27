import { describe, expect, it } from "vitest";
import type { JsonSchema } from "./config-form.shared.ts";
import { splitConfigSchemaByTier } from "./config-form.tiers.ts";

describe("splitConfigSchemaByTier", () => {
  it("keeps a nested group whole in the tier of its common fields", () => {
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
      reload: {
        type: "object",
        properties: { mode: { type: "string" }, debounceMs: { type: "integer" } },
      },
    });
    expect(split.common?.required).toEqual(["port", "reload"]);
    expect(split.advanced).toBeNull();
  });

  it("splits inside a group the form renders in place", () => {
    const split = splitConfigSchemaByTier({
      path: ["gateway"],
      schema: {
        type: "object",
        properties: {
          names: { type: "array", items: { type: "string" } },
          reload: {
            type: "object",
            properties: { mode: { type: "string" }, debounceMs: { type: "integer" } },
          },
        },
      },
      hints: {
        "gateway.names": { advanced: false },
        "gateway.reload.mode": { advanced: false },
        "gateway.reload.debounceMs": { advanced: true },
      },
    });
    expect(split.common?.properties?.reload?.properties).toEqual({ mode: { type: "string" } });
    expect(split.advanced?.properties?.reload?.properties).toEqual({
      debounceMs: { type: "integer" },
    });
  });

  it("keeps a string-or-object setting whole in the tier of its common fields", () => {
    const model = {
      anyOf: [
        { type: "string" },
        {
          type: "object",
          properties: { primary: { type: "string" }, fallbacks: { type: "string" } },
        },
      ],
    } satisfies JsonSchema;
    const split = splitConfigSchemaByTier({
      path: ["agents"],
      schema: { type: "object", properties: { mode: { type: "string" }, model } },
      hints: {
        "agents.mode": { advanced: false },
        "agents.model.primary": { advanced: false },
        "agents.model.fallbacks": { advanced: true },
      },
    });
    expect(split.common?.properties?.model).toEqual(model);
    expect(split.advanced).toBeNull();
  });

  it("keeps a list of objects whole so its Add appears once", () => {
    const entry = {
      type: "object",
      properties: { id: { type: "string" }, url: { type: "string" } },
    } as const;
    const split = splitConfigSchemaByTier({
      path: ["gateway"],
      schema: {
        type: "object",
        properties: {
          port: { type: "integer" },
          entries: { type: "array", items: entry },
        },
      },
      hints: {
        "gateway.port": { advanced: false },
        "gateway.entries.*.id": { advanced: false },
        "gateway.entries.*.url": { advanced: true },
      },
    });
    expect(split.common?.properties?.entries).toEqual({ type: "array", items: entry });
    expect(split.advanced).toBeNull();
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
});
