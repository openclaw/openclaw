import { describe, expect, it } from "vitest";
import { validateJsonSchemaValue } from "./schema-validator.js";

describe("schema validator", () => {
  it("can apply JSON Schema defaults while validating", () => {
    const res = validateJsonSchemaValue({
      cacheKey: "schema-validator.test.defaults",
      schema: {
        type: "object",
        properties: {
          mode: {
            type: "string",
            default: "auto",
          },
        },
        additionalProperties: false,
      },
      value: {},
      applyDefaults: true,
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value).toEqual({ mode: "auto" });
    }
  });

  it("includes allowed values in enum validation errors", () => {
    const res = validateJsonSchemaValue({
      cacheKey: "schema-validator.test.enum",
      schema: {
        type: "object",
        properties: {
          fileFormat: {
            type: "string",
            enum: ["markdown", "html", "json"],
          },
        },
        required: ["fileFormat"],
      },
      value: { fileFormat: "txt" },
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      const issue = res.errors.find((entry) => entry.path === "fileFormat");
      expect(issue?.message).toContain("(allowed:");
      expect(issue?.allowedValues).toEqual(["markdown", "html", "json"]);
      expect(issue?.allowedValuesHiddenCount).toBe(0);
    }
  });

  it("includes allowed value in const validation errors", () => {
    const res = validateJsonSchemaValue({
      cacheKey: "schema-validator.test.const",
      schema: {
        type: "object",
        properties: {
          mode: {
            const: "strict",
          },
        },
        required: ["mode"],
      },
      value: { mode: "relaxed" },
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      const issue = res.errors.find((entry) => entry.path === "mode");
      expect(issue?.message).toContain("(allowed:");
      expect(issue?.allowedValues).toEqual(["strict"]);
      expect(issue?.allowedValuesHiddenCount).toBe(0);
    }
  });

  it("truncates long allowed-value hints", () => {
    const values = [
      "v1",
      "v2",
      "v3",
      "v4",
      "v5",
      "v6",
      "v7",
      "v8",
      "v9",
      "v10",
      "v11",
      "v12",
      "v13",
    ];
    const res = validateJsonSchemaValue({
      cacheKey: "schema-validator.test.enum.truncate",
      schema: {
        type: "object",
        properties: {
          mode: {
            type: "string",
            enum: values,
          },
        },
        required: ["mode"],
      },
      value: { mode: "not-listed" },
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      const issue = res.errors.find((entry) => entry.path === "mode");
      expect(issue?.message).toContain("(allowed:");
      expect(issue?.message).toContain("... (+1 more)");
      expect(issue?.allowedValues).toEqual([
        "v1",
        "v2",
        "v3",
        "v4",
        "v5",
        "v6",
        "v7",
        "v8",
        "v9",
        "v10",
        "v11",
        "v12",
      ]);
      expect(issue?.allowedValuesHiddenCount).toBe(1);
    }
  });

  it("appends missing required property to the structured path", () => {
    const res = validateJsonSchemaValue({
      cacheKey: "schema-validator.test.required.path",
      schema: {
        type: "object",
        properties: {
          settings: {
            type: "object",
            properties: {
              mode: { type: "string" },
            },
            required: ["mode"],
          },
        },
        required: ["settings"],
      },
      value: { settings: {} },
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      const issue = res.errors.find((entry) => entry.path === "settings.mode");
      expect(issue).toBeDefined();
      expect(issue?.allowedValues).toBeUndefined();
    }
  });

  it("appends missing dependency property to the structured path", () => {
    const res = validateJsonSchemaValue({
      cacheKey: "schema-validator.test.dependencies.path",
      schema: {
        type: "object",
        properties: {
          settings: {
            type: "object",
            dependencies: {
              mode: ["format"],
            },
          },
        },
      },
      value: { settings: { mode: "strict" } },
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      const issue = res.errors.find((entry) => entry.path === "settings.format");
      expect(issue).toBeDefined();
      expect(issue?.allowedValues).toBeUndefined();
    }
  });

  it("truncates oversized allowed value entries", () => {
    const oversizedAllowed = "a".repeat(300);
    const res = validateJsonSchemaValue({
      cacheKey: "schema-validator.test.enum.long-value",
      schema: {
        type: "object",
        properties: {
          mode: {
            type: "string",
            enum: [oversizedAllowed],
          },
        },
        required: ["mode"],
      },
      value: { mode: "not-listed" },
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      const issue = res.errors.find((entry) => entry.path === "mode");
      expect(issue).toBeDefined();
      expect(issue?.message).toContain("(allowed:");
      expect(issue?.message).toContain("... (+");
    }
  });

  it("sanitizes terminal text while preserving structured fields", () => {
    const maliciousProperty = "evil\nkey\t\x1b[31mred\x1b[0m";
    const res = validateJsonSchemaValue({
      cacheKey: "schema-validator.test.terminal-sanitize",
      schema: {
        type: "object",
        properties: {},
        required: [maliciousProperty],
      },
      value: {},
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      const issue = res.errors[0];
      expect(issue).toBeDefined();
      expect(issue?.path).toContain("\n");
      expect(issue?.message).toContain("\n");
      expect(issue?.text).toContain("\\n");
      expect(issue?.text).toContain("\\t");
      expect(issue?.text).not.toContain("\n");
      expect(issue?.text).not.toContain("\t");
      expect(issue?.text).not.toContain("\x1b");
    }
  });
});
