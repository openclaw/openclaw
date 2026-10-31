// @vitest-environment node
import { expect, it } from "vitest";
import {
  matchesNodeSearch,
  parseConfigSearchQuery as parse,
  resolveConfigMapSearch,
} from "./config-form.search.ts";

type Search = Parameters<typeof matchesNodeSearch>[0];
type Schema = Search["schema"];
type Properties = NonNullable<Schema["properties"]>;
const string = (description?: string): Schema => ({ type: "string", description });
const object = (properties: Properties): Schema => ({ type: "object", properties });
const array = (items?: Schema["items"], ...allOf: Schema[]): Schema => ({
  type: "array",
  items,
  allOf,
});
const defaults = { value: {}, path: [], hints: {} };
function matches(query: string, schema: Schema, options: Partial<Search> = {}) {
  return matchesNodeSearch({ ...defaults, schema, ...options, criteria: parse(query) });
}

it.each([
  ["tag:überwachung tag:cafe\u0301", true],
  ["mode tag:überwachung tag:cafe\u0301", false],
] as const)("matches text and tag criteria: %s", (query, expected) => {
  expect(
    matches(query, object({ auth: object({ token: string() }) }), {
      path: ["gateway"],
      hints: { "gateway.auth.token": { label: "Token", tags: ["u\u0308berwachung", "café"] } },
    }),
  ).toBe(expected);
});

const overflow: Schema = {
  items: [{}, string("secondary")],
  additionalItems: string("Café"),
};
const closed: Schema = { items: [string("reachable")], additionalItems: false };
const forbidden: Schema = { items: [{}, string("Forbidden")] };
it.each([
  ["münchen", array(object({ source: string("Mu\u0308nchen") })), true],
  ["cafe\u0301", array([string("outer")], overflow), true],
  ["forbidden", array(undefined, closed, forbidden), false],
] satisfies [string, Schema, boolean][])(
  "searches only reachable empty-array schemas: %s",
  (query, schema, expected) => {
    expect(matches(query, schema, { value: [], path: ["endpoints"] })).toBe(expected);
  },
);

it("searches additional-property schemas before entries exist", () => {
  expect(
    matches(
      "remote service",
      { type: "object", additionalProperties: object({ url: string() }) },
      {
        path: ["servers"],
        hints: { "servers.*.url": { help: "Endpoint used by the remote service" } },
      },
    ),
  ).toBe(true);
});

const entries = { reserved: "hidden", alpha: "visible" };
it.each([
  ["", entries, ["alpha"], true],
  ["alpha", entries, ["alpha"], true],
  ["reserved", entries, [], false],
  ["alpha", {}, [], false],
] satisfies [string, Record<string, string>, string[], boolean][])(
  "scopes map visibility to searchable entries: %s",
  (query, value, keys, visible) => {
    const result = resolveConfigMapSearch({
      schema: string(),
      value,
      path: ["settings"],
      hints: {},
      reservedKeys: new Set(["reserved"]),
      searchCriteria: parse(query),
    });
    expect(result.visibleEntries.map(([key]) => key)).toEqual(keys);
    expect(result.visible).toBe(visible);
  },
);
