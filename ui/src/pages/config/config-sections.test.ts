// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { JsonSchema } from "../../lib/config-form-utils.ts";
import { omitCuratedOwnedConfigLeaves } from "./config-sections.ts";

const uiSection: JsonSchema = {
  type: "object",
  required: ["prefs"],
  properties: {
    seamColor: { type: "string" },
    prefs: {
      type: "object",
      required: ["locale"],
      properties: {
        locale: { type: "string" },
        chatShowToolCalls: { type: "boolean" },
      },
    },
  },
};

const schema: JsonSchema = { type: "object", properties: { ui: uiSection } };

describe("omitCuratedOwnedConfigLeaves", () => {
  it("drops the Appearance-owned locale leaf from the config root schema", () => {
    const projected = omitCuratedOwnedConfigLeaves(schema);
    const prefs = projected.properties?.ui?.properties?.prefs;
    expect(Object.keys(prefs?.properties ?? {})).toEqual(["chatShowToolCalls"]);
    expect(prefs?.required).toEqual([]);
    // Unrelated siblings survive the projection.
    expect(projected.properties?.ui?.properties?.seamColor).toEqual({ type: "string" });
  });

  it("drops the leaf from a section-rooted schema using its prefix", () => {
    const projected = omitCuratedOwnedConfigLeaves(uiSection, "ui");
    expect(Object.keys(projected.properties?.prefs?.properties ?? {})).toEqual([
      "chatShowToolCalls",
    ]);
    expect(projected.properties?.prefs?.required).toEqual([]);
  });

  it("returns schemas without the owned leaf unchanged", () => {
    const untouched: JsonSchema = { type: "object", properties: { agents: { type: "object" } } };
    expect(omitCuratedOwnedConfigLeaves(untouched)).toEqual(untouched);
    // A section prefix that owns nothing keeps the original reference.
    expect(omitCuratedOwnedConfigLeaves(schema, "agents")).toBe(schema);
  });
});
