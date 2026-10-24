// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { SessionToolOverrides } from "./patch.ts";
import {
  countSessionToolOverrides,
  nextBooleanToolOverrides,
  nextMcpToolsDenyOverrides,
  nextWebSearchToolOverrides,
  resolveToolOverrideState,
  resolveWebSearchToolOverrideState,
} from "./tool-overrides.ts";

const siblings = {
  skills: { docs: true },
  mcpServers: { github: false },
  mcpToolsDeny: { notion: ["delete_page"] },
};
const withDenials = (github: string[], notion = true): SessionToolOverrides => ({
  mcpToolsDeny: { github, ...(notion ? { notion: ["delete_page"] } : {}) },
});

describe("session tool overrides", () => {
  it("resolves sparse booleans against their base state", () => {
    expect(resolveToolOverrideState(true, undefined)).toBe(true);
    expect(resolveToolOverrideState(false, undefined)).toBe(false);
    expect(resolveToolOverrideState(true, false)).toBe(false);
    expect(resolveToolOverrideState(false, true)).toBe(true);
  });

  it("treats global web-search disable as a kill switch for effective state", () => {
    expect(resolveWebSearchToolOverrideState(true, undefined)).toBe(true);
    expect(resolveWebSearchToolOverrideState(true, true)).toBe(true);
    expect(resolveWebSearchToolOverrideState(true, false)).toBe(false);
    expect(resolveWebSearchToolOverrideState(false, undefined)).toBe(false);
    expect(resolveWebSearchToolOverrideState(false, false)).toBe(false);
    expect(resolveWebSearchToolOverrideState(false, true)).toBe(false);
  });

  it("adds and removes named overrides without disturbing sibling groups", () => {
    const current = {
      mcpServers: siblings.mcpServers,
      mcpToolsDeny: siblings.mcpToolsDeny,
      webSearch: false,
    };
    const original = structuredClone(current);
    expect(nextBooleanToolOverrides(current, "skills", "release", false, true)).toEqual({
      ...current,
      skills: { release: false },
    });
    expect(nextBooleanToolOverrides(current, "mcpServers", "github", true, true)).toEqual({
      mcpToolsDeny: siblings.mcpToolsDeny,
      webSearch: false,
    });
    expect(current).toEqual(original);
  });

  it("restores default-on web search by removing the key", () => {
    const off = nextWebSearchToolOverrides({ skills: { docs: true } }, false);
    expect(off).toEqual({ skills: { docs: true }, webSearch: false });
    expect(nextWebSearchToolOverrides(off, true)).toEqual({ skills: { docs: true } });
  });

  it.each([
    { name: "absent", current: {}, expected: {} },
    { name: "explicit false", current: { webSearch: false }, expected: { webSearch: false } },
    { name: "stale true", current: { webSearch: true }, expected: {} },
  ])(
    "preserves $name intent and sibling overrides while global web search is off",
    ({ current, expected }) => {
      const overrides = { ...siblings, ...current };
      const original = structuredClone(overrides);
      for (const nextEnabled of [false, true]) {
        expect(nextWebSearchToolOverrides(current, nextEnabled, false)).toEqual(expected);
        expect(nextWebSearchToolOverrides(overrides, nextEnabled, false)).toEqual({
          ...siblings,
          ...expected,
        });
        expect(overrides).toEqual(original);
      }
    },
  );

  it.each([
    [
      { ...withDenials(["zebra"]), webSearch: false },
      "alpha",
      true,
      { ...withDenials(["alpha", "zebra"]), webSearch: false },
    ],
    [withDenials(["read", "write"]), "read", false, withDenials(["write"])],
    [withDenials(["write"]), "write", false, { mcpToolsDeny: siblings.mcpToolsDeny }],
    [withDenials(["write"], false), "write", false, {}],
  ] as const)(
    "updates MCP denials %j / %s / %s without mutation",
    (input, tool, denied, expected) => {
      const original = structuredClone(input);
      expect(nextMcpToolsDenyOverrides(input, "github", tool, denied)).toEqual(expected);
      expect(input).toEqual(original);
    },
  );

  it.each(["constructor", "__proto__", "hasOwnProperty"])(
    "treats %s as an own override key",
    (name) => {
      expect(
        nextMcpToolsDenyOverrides({ mcpToolsDeny: { github: ["read"] } }, name, "inspect", true),
      ).toEqual({
        mcpToolsDeny: { [name]: ["inspect"], github: ["read"] },
      });
      for (const group of ["mcpServers", "skills"] as const) {
        expect(nextBooleanToolOverrides({}, group, name, false, true)).toEqual({
          [group]: { [name]: false },
        });
      }
    },
  );

  it("counts override categories", () => {
    expect(
      countSessionToolOverrides({
        ...siblings,
        mcpServers: { ...siblings.mcpServers, alpha: true },
        webSearch: false,
      }),
    ).toBe(5);
  });
});
