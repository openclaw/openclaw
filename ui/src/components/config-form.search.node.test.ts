// @vitest-environment node
import { describe, expect, it } from "vitest";
import { matchesNodeSearch, parseConfigSearchQuery } from "./config-form.search.ts";

const schema = {
  type: "object",
  properties: {
    gateway: {
      type: "object",
      properties: {
        auth: {
          type: "object",
          properties: {
            token: { type: "string" },
          },
        },
      },
    },
    mode: {
      type: "string",
      enum: ["off", "token"],
    },
  },
};

describe("config form search", () => {
  it.each([
    ["token tag:security tag:Auth", "token", ["security", "auth"]],
    ["Café tag:storage 文書", "café 文書", ["storage"]],
    ["Log tag:storage tag:STORAGE File", "log file", ["storage"]],
    ["", "", []],
    ["  ", "", []],
    ["tag:storage", "", ["storage"]],
    ["Log  File", "log  file", []],
    ["path:tag:storage", "path:tag:storage", []],
  ])("parses search query %j", (query, text, tags) => {
    expect(parseConfigSearchQuery(query)).toEqual({ text, tags });
  });

  it("matches fields by tag through ui hints", () => {
    const parsed = parseConfigSearchQuery("tag:security");
    const matched = matchesNodeSearch({
      schema: schema.properties.gateway,
      value: {},
      path: ["gateway"],
      hints: {
        "gateway.auth.token": { tags: ["security", "secret"] },
      },
      criteria: parsed,
    });
    expect(matched).toBe(true);
  });

  it.each([
    ["access token tag:security", true],
    ["tag:security access token", true],
    ["access tag:security token", true],
    ["mode tag:security", false],
    ["access token tag:storage", false],
  ])("requires text and tag when combined in %j", (query, expected) => {
    expect(
      matchesNodeSearch({
        schema: schema.properties.gateway,
        value: {},
        path: ["gateway"],
        hints: {
          "gateway.auth.token": { label: "Access Token", tags: ["security"] },
        },
        criteria: parseConfigSearchQuery(query),
      }),
    ).toBe(expected);
  });

  it("searches array item schemas before entries exist", () => {
    const matched = matchesNodeSearch({
      schema: {
        type: "array",
        items: {
          type: "object",
          properties: {
            source: {
              type: "string",
              description: "Credential source for outgoing requests",
            },
          },
        },
      },
      value: [],
      path: ["headers"],
      hints: {},
      criteria: parseConfigSearchQuery("credential source"),
    });

    expect(matched).toBe(true);
  });

  it.each([
    { values: [], query: "secondary endpoint" },
    { values: ["primary"], query: "secondary endpoint" },
    { values: [], query: "overflow endpoint" },
    { values: ["primary"], query: "overflow endpoint" },
  ])("searches positional and typed-tail schemas for $values", ({ values, query }) => {
    const matched = matchesNodeSearch({
      schema: {
        type: "array",
        items: [
          { type: "string", description: "Primary endpoint" },
          { type: "string", description: "Secondary endpoint" },
        ],
        additionalItems: { type: "string", description: "Overflow endpoint" },
      },
      value: values,
      path: ["endpoints"],
      hints: {},
      criteria: parseConfigSearchQuery(query),
    });

    expect(matched).toBe(true);
  });

  it.each(["composed secondary", "composed overflow"])(
    "searches %s array schemas declared through allOf",
    (query) => {
      const matched = matchesNodeSearch({
        schema: {
          type: "array",
          items: [{ type: "string", description: "Outer endpoint" }],
          allOf: [
            {
              items: [{}, { type: "string", description: "Composed secondary endpoint" }],
              additionalItems: { type: "string", description: "Composed overflow endpoint" },
            },
          ],
        },
        value: [],
        path: ["endpoints"],
        hints: {},
        criteria: parseConfigSearchQuery(query),
      });

      expect(matched).toBe(true);
    },
  );

  it("does not search tuple positions forbidden by an allOf branch", () => {
    const matched = matchesNodeSearch({
      schema: {
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
      },
      value: [],
      path: ["endpoints"],
      hints: {},
      criteria: parseConfigSearchQuery("impossible endpoint"),
    });

    expect(matched).toBe(false);
  });

  it("searches additional-property schemas before entries exist", () => {
    const matched = matchesNodeSearch({
      schema: {
        type: "object",
        additionalProperties: {
          type: "object",
          properties: {
            url: {
              type: "string",
            },
          },
        },
      },
      value: {},
      path: ["servers"],
      hints: {
        "servers.*.url": {
          help: "Endpoint used by the remote service",
        },
      },
      criteria: parseConfigSearchQuery("remote service"),
    });

    expect(matched).toBe(true);
  });
});
