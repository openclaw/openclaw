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

  it("adds sorted MCP tool denials without mutating sibling overrides", () => {
    const current = {
      ...withDenials(["zebra"]),
      webSearch: false,
    };
    expect(nextMcpToolsDenyOverrides(current, "github", "alpha", true)).toEqual({
      ...withDenials(["alpha", "zebra"]),
      webSearch: false,
    });
    expect(current.mcpToolsDeny?.github).toEqual(["zebra"]);
  });

  it("removes MCP tool denials and keeps the map sparse", () => {
    expect(
      nextMcpToolsDenyOverrides(withDenials(["read", "write"]), "github", "read", false),
    ).toEqual(withDenials(["write"]));
    expect(nextMcpToolsDenyOverrides(withDenials(["write"]), "github", "write", false)).toEqual({
      mcpToolsDeny: siblings.mcpToolsDeny,
    });
    expect(
      nextMcpToolsDenyOverrides(withDenials(["write"], false), "github", "write", false),
    ).toEqual({});
  });

  it.each(["constructor", "__proto__", "hasOwnProperty"])(
    "treats %s as an own MCP server key",
    (name) => {
      expect(
        nextMcpToolsDenyOverrides({ mcpToolsDeny: { github: ["read"] } }, name, "inspect", true),
      ).toEqual({
        mcpToolsDeny: { [name]: ["inspect"], github: ["read"] },
      });
    },
  );

  it.each(["mcpServers", "skills"] as const)(
    "treats prototype property names as own %s keys",
    (group) => {
      for (const name of ["hasOwnProperty", "__proto__", "constructor"]) {
        expect(nextBooleanToolOverrides({}, group, name, false, true)).toEqual({
          [group]: { [name]: false },
        });
      }
    },
  );

  it("counts override categories", () => {
    const overrides = {
      mcpServers: { zeta: false, alpha: true },
      mcpToolsDeny: { tools: ["danger"] },
      skills: { beta: false },
      webSearch: false,
    };
    expect(countSessionToolOverrides(overrides)).toBe(5);
  });
});
