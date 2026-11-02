// @vitest-environment node
import { expect, it } from "vitest";
import type { SessionToolOverrides } from "./patch.ts";
import {
  countSessionToolOverrides as countOverrides,
  nextBooleanToolOverrides as setBoolean,
  nextMcpToolsDenyOverrides as setDenied,
  nextWebSearchToolOverrides as setWebSearch,
  resolveToolOverrideState as effective,
  resolveWebSearchToolOverrideState as effectiveSearch,
} from "./tool-overrides.ts";

const siblings = {
  skills: { docs: true },
  mcpServers: { github: false },
  mcpToolsDeny: { notion: ["delete_page"] },
};
const withDenials = (github: readonly string[], notion = true): SessionToolOverrides => ({
  mcpToolsDeny: { github: [...github], ...(notion ? { notion: ["delete_page"] } : {}) },
});

it.each([
  [true, undefined, true, true],
  [true, false, false, false],
  [false, true, true, false],
] as const)("resolves base %s / override %s", (base, override, plain, web) => {
  expect(effective(base, override)).toBe(plain);
  expect(effectiveSearch(base, override)).toBe(web);
});

it("updates and counts named overrides without disturbing sibling groups", () => {
  const current = {
    mcpServers: siblings.mcpServers,
    mcpToolsDeny: siblings.mcpToolsDeny,
    webSearch: false,
  };
  const original = structuredClone(current);
  const added = setBoolean(current, "skills", "release", false, true);
  expect(added).toEqual({
    ...current,
    skills: { release: false },
  });
  expect(setBoolean(current, "mcpServers", "github", true, true)).toEqual({
    mcpToolsDeny: siblings.mcpToolsDeny,
    webSearch: false,
  });
  expect(current).toEqual(original);
  expect(countOverrides({ ...added, mcpServers: { ...added.mcpServers, alpha: true } })).toBe(5);
});

it("restores default-on web search by removing the key", () => {
  const off = setWebSearch({ skills: { docs: true } }, false);
  expect(off).toEqual({ skills: { docs: true }, webSearch: false });
  expect(setWebSearch(off, true)).toEqual({ skills: { docs: true } });
});

it.each([undefined, false, true])("preserves %s intent while global search is off", (webSearch) => {
  const overrides = { ...siblings, ...(webSearch === undefined ? {} : { webSearch }) };
  const original = structuredClone(overrides);
  expect(setWebSearch(overrides, true, false)).toEqual(
    webSearch === false ? { ...siblings, webSearch: false } : siblings,
  );
  expect(overrides).toEqual(original);
});

it.each([
  [["zebra"], "alpha", true, ["alpha", "zebra"], true],
  [["read", "write"], "read", false, ["write"], true],
  [["write"], "write", false, [], true],
  [["write"], "write", false, [], false],
] as const)(
  "updates MCP denials %j / %s / %s without mutation",
  (before, tool, denied, after, notion) => {
    const input = { ...withDenials(before, notion), webSearch: false };
    const expected = after.length
      ? withDenials(after, notion)
      : notion
        ? { mcpToolsDeny: siblings.mcpToolsDeny }
        : {};
    const original = structuredClone(input);
    expect(setDenied(input, "github", tool, denied)).toEqual({
      ...expected,
      webSearch: false,
    });
    expect(input).toEqual(original);
  },
);

it.each(["constructor", "__proto__", "hasOwnProperty"])(
  "treats %s as an own override key",
  (name) => {
    expect(setDenied({ mcpToolsDeny: { github: ["read"] } }, name, "inspect", true)).toEqual({
      mcpToolsDeny: { [name]: ["inspect"], github: ["read"] },
    });
    for (const group of ["mcpServers", "skills"] as const) {
      expect(setBoolean({}, group, name, false, true)).toEqual({
        [group]: { [name]: false },
      });
    }
  },
);
