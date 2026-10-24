// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  matchesNodeSearch,
  parseConfigSearchQuery,
  resolveConfigMapSearch,
} from "./config-form.search.ts";

const gateway = {
  type: "object",
  properties: { auth: { type: "object", properties: { token: { type: "string" } } } },
};
function matches(query: string, params: Omit<Parameters<typeof matchesNodeSearch>[0], "criteria">) {
  return matchesNodeSearch({ ...params, criteria: parseConfigSearchQuery(query) });
}
const gatewaySearch = {
  schema: gateway,
  value: {},
  path: ["gateway"],
  hints: { "gateway.auth.token": { tags: ["security", "secret"] } },
};
function matchesArray(query: string, schema: Parameters<typeof matchesNodeSearch>[0]["schema"]) {
  return matches(query, { schema, value: [], path: ["endpoints"], hints: {} });
}

describe("config form search", () => {
  it("matches fields by tag through ui hints", () => {
    expect(matches("tag:security", gatewaySearch)).toBe(true);
  });

  it("requires text and tag when combined", () => {
    expect(
      matches("mode tag:security", {
        ...gatewaySearch,
        hints: { "gateway.auth.token": { label: "Access Token", tags: ["security"] } },
      }),
    ).toBe(false);
  });

  it("searches array item schemas before entries exist", () => {
    const matched = matches("credential source", {
      schema: {
        type: "array",
        items: {
          type: "object",
          properties: {
            source: { type: "string", description: "Credential source for outgoing requests" },
          },
        },
      },
      value: [],
      path: ["headers"],
      hints: {},
    });

    expect(matched).toBe(true);
  });

  it("searches composed overflow array schemas declared through allOf", () => {
    expect(
      matchesArray("composed overflow", {
        type: "array",
        items: [{ type: "string", description: "Outer endpoint" }],
        allOf: [
          {
            items: [{}, { type: "string", description: "Composed secondary endpoint" }],
            additionalItems: { type: "string", description: "Composed overflow endpoint" },
          },
        ],
      }),
    ).toBe(true);
  });

  it("does not search tuple positions forbidden by an allOf branch", () => {
    expect(
      matchesArray("impossible endpoint", {
        type: "array",
        allOf: [
          {
            items: [{ type: "string", description: "Reachable endpoint" }],
            additionalItems: false,
          },
          {
            items: [{}, { type: "string", description: "Impossible endpoint" }],
          },
        ],
      }),
    ).toBe(false);
  });

  it("searches additional-property schemas before entries exist", () => {
    const matched = matches("remote service", {
      schema: {
        type: "object",
        additionalProperties: {
          type: "object",
          properties: { url: { type: "string" } },
        },
      },
      value: {},
      path: ["servers"],
      hints: { "servers.*.url": { help: "Endpoint used by the remote service" } },
    });

    expect(matched).toBe(true);
  });
  const entries = { reserved: "hidden", alpha: "visible" };
  it.each([
    { query: "", value: entries, keys: ["alpha"], visible: true },
    { query: "alpha", value: entries, keys: ["alpha"], visible: true },
    { query: "reserved", value: entries, keys: [], visible: false },
    { query: "missing", value: entries, keys: [], visible: false },
    { query: "", value: {}, keys: [], visible: true },
    { query: "alpha", value: {}, keys: [], visible: false },
  ])(
    "keeps custom map visibility scoped to its searchable entries ($query, $visible)",
    ({ query, value, keys, visible }) => {
      const result = resolveConfigMapSearch({
        schema: { type: "string" },
        value,
        path: ["settings"],
        hints: {},
        reservedKeys: new Set(["reserved"]),
        searchCriteria: parseConfigSearchQuery(query),
      });
      expect(result.visibleEntries.map(([key]) => key)).toEqual(keys);
      expect(result.visible).toBe(visible);
    },
  );
});
