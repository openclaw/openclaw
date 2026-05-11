import { describe, expect, it } from "vitest";
import {
  findUndeclaredPluginToolNames,
  normalizePluginToolContractNames,
} from "./tool-contracts.js";

describe("normalizePluginToolContractNames", () => {
  it("returns empty array when contracts is undefined", () => {
    expect(normalizePluginToolContractNames(undefined)).toEqual([]);
  });

  it("returns empty array when tools is undefined", () => {
    expect(normalizePluginToolContractNames({ tools: undefined })).toEqual([]);
  });

  it("normalizes explicit tool names", () => {
    expect(normalizePluginToolContractNames({ tools: ["foo", "bar"] })).toEqual(["foo", "bar"]);
  });

  it("returns wildcard when tools contains '*'", () => {
    expect(normalizePluginToolContractNames({ tools: ["*"] })).toEqual(["*"]);
  });

  it("collapses mixed names with wildcard to just wildcard", () => {
    expect(normalizePluginToolContractNames({ tools: ["foo", "*", "bar"] })).toEqual(["*"]);
  });
});

describe("findUndeclaredPluginToolNames", () => {
  it("returns undeclared names", () => {
    expect(
      findUndeclaredPluginToolNames({ declaredNames: ["foo"], toolNames: ["foo", "bar"] }),
    ).toEqual(["bar"]);
  });

  it("returns empty when all declared", () => {
    expect(
      findUndeclaredPluginToolNames({ declaredNames: ["foo", "bar"], toolNames: ["foo"] }),
    ).toEqual([]);
  });

  it("returns empty when wildcard is declared", () => {
    expect(
      findUndeclaredPluginToolNames({
        declaredNames: ["*"],
        toolNames: ["anything", "goes", "here"],
      }),
    ).toEqual([]);
  });
});
