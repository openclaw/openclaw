// Unit tests for mapZodIssueToConfigIssue (config validation issue mapper).
import { describe, expect, it } from "vitest";
import { testing } from "./validation.js";

// ---------------------------------------------------------------------------
// Basic path and message mapping
// ---------------------------------------------------------------------------

describe("mapZodIssueToConfigIssue", () => {
  describe("basic path and message", () => {
    it("maps a simple path and message", () => {
      const result = testing.mapZodIssueToConfigIssue({
        code: "custom",
        path: ["channels", "telegram", "botToken"],
        message: "invalid bot token",
      });
      expect(result).toEqual({
        path: "channels.telegram.botToken",
        message: "invalid bot token",
      });
    });

    it("defaults message to 'Invalid input' when message is missing", () => {
      const result = testing.mapZodIssueToConfigIssue({
        code: "custom",
        path: ["foo"],
      });
      expect(result.path).toBe("foo");
      expect(result.message).toBe("Invalid input");
    });

    it("defaults message to 'Invalid input' when message is not a string", () => {
      const result = testing.mapZodIssueToConfigIssue({
        code: "custom",
        path: ["foo"],
        message: 42,
      });
      expect(result.message).toBe("Invalid input");
    });

    it("handles empty path array", () => {
      const result = testing.mapZodIssueToConfigIssue({
        code: "custom",
        path: [],
        message: "root error",
      });
      expect(result.path).toBe("");
    });

    it("handles non-array path", () => {
      const result = testing.mapZodIssueToConfigIssue({
        code: "custom",
        path: "scalar",
        message: "bad path",
      });
      expect(result.path).toBe("");
    });

    it("includes numeric array-index segments in path", () => {
      const result = testing.mapZodIssueToConfigIssue({
        code: "custom",
        path: ["agents", "list", 0, "name"],
        message: "missing name",
      });
      expect(result.path).toBe("agents.list.0.name");
    });
  });

  // ---------------------------------------------------------------------------
  // Numeric bound hints (too_big / too_small)
  // ---------------------------------------------------------------------------

  describe("numeric bound hints", () => {
    it("appends (maximum: N) for too_big inclusive with number origin", () => {
      const result = testing.mapZodIssueToConfigIssue({
        code: "too_big",
        path: ["timeoutMs"],
        message: "Value is too big",
        origin: "number",
        maximum: 100,
        inclusive: true,
      });
      expect(result.message).toMatch(/\(maximum: 100\)/);
    });

    it("appends (must be less than N) for too_big exclusive with number origin", () => {
      const result = testing.mapZodIssueToConfigIssue({
        code: "too_big",
        path: ["timeoutMs"],
        message: "Value is too big",
        origin: "number",
        maximum: 100,
        inclusive: false,
      });
      expect(result.message).toMatch(/\(must be less than 100\)/);
    });

    it("appends (minimum: N) for too_small inclusive with number origin", () => {
      const result = testing.mapZodIssueToConfigIssue({
        code: "too_small",
        path: ["maxTokens"],
        message: "Value is too small",
        origin: "number",
        minimum: 1,
        inclusive: true,
      });
      expect(result.message).toMatch(/\(minimum: 1\)/);
    });

    it("appends (must be greater than N) for too_small exclusive with number origin", () => {
      const result = testing.mapZodIssueToConfigIssue({
        code: "too_small",
        path: ["maxTokens"],
        message: "Value is too small",
        origin: "number",
        minimum: 1,
        inclusive: false,
      });
      expect(result.message).toMatch(/\(must be greater than 1\)/);
    });

    it("does not add bound hint when maximum is missing for too_big", () => {
      const result = testing.mapZodIssueToConfigIssue({
        code: "too_big",
        path: ["timeoutMs"],
        message: "Value is too big",
        origin: "number",
        inclusive: true,
      });
      expect(result.message).toBe("Value is too big");
    });

    it("does not add bound hint when minimum is missing for too_small", () => {
      const result = testing.mapZodIssueToConfigIssue({
        code: "too_small",
        path: ["maxTokens"],
        message: "Value is too small",
        origin: "number",
        inclusive: true,
      });
      expect(result.message).toBe("Value is too small");
    });

    it("does not add bound hint when origin is not 'number'", () => {
      const result = testing.mapZodIssueToConfigIssue({
        code: "too_big",
        path: ["strLength"],
        message: "Value is too big",
        origin: "string",
        maximum: 10,
        inclusive: true,
      });
      expect(result.message).toBe("Value is too big");
    });

    it("does not add bound hint for too_big with invalid inclusive default", () => {
      const result = testing.mapZodIssueToConfigIssue({
        code: "too_big",
        path: ["count"],
        message: "Value is too big",
        origin: "number",
        maximum: 5,
        // inclusive defaults to false when missing
      });
      expect(result.message).toMatch(/\(must be less than 5\)/);
    });
  });

  // ---------------------------------------------------------------------------
  // Allowed values collection
  // ---------------------------------------------------------------------------

  describe("allowed values", () => {
    it("collects allowed values from invalid_value issue", () => {
      const result = testing.mapZodIssueToConfigIssue({
        code: "invalid_value",
        path: ["update", "channel"],
        message: "Invalid enum value",
        values: ["stable", "beta", "dev"],
      });
      expect(result).toMatchObject({
        path: "update.channel",
        message: expect.stringContaining("Invalid enum value"),
        allowedValues: ["stable", "beta", "dev"],
      });
    });

    it("collects boolean allowed values from invalid_type with expected boolean", () => {
      const result = testing.mapZodIssueToConfigIssue({
        code: "invalid_type",
        path: ["enabled"],
        message: "Expected boolean, received string",
        expected: "boolean",
      });
      expect(result).toMatchObject({
        path: "enabled",
        allowedValues: ["true", "false"],
      });
    });

    it("does not collect allowed values for invalid_type with non-boolean expected", () => {
      const result = testing.mapZodIssueToConfigIssue({
        code: "invalid_type",
        path: ["port"],
        message: "Expected number, received string",
        expected: "number",
      });
      expect(result.allowedValues).toBeUndefined();
    });

    it("collects allowed values from custom issue with 'expected one of' message", () => {
      const result = testing.mapZodIssueToConfigIssue({
        code: "custom",
        path: ["mode"],
        message: 'expected one of "fast"|"balanced"|"thorough"',
      });
      expect(result).toMatchObject({
        path: "mode",
        allowedValues: ["fast", "balanced", "thorough"],
      });
    });

    it("does not collect allowed values from custom issue without expected one of pattern", () => {
      const result = testing.mapZodIssueToConfigIssue({
        code: "custom",
        path: ["plugins", "entries", "my-plugin"],
        message: "plugin not found",
      });
      expect(result.allowedValues).toBeUndefined();
    });

    it("collects allowed values from invalid_union with complete nested branches", () => {
      const result = testing.mapZodIssueToConfigIssue({
        code: "invalid_union",
        path: ["dmPolicy"],
        message: "Invalid input",
        errors: [
          [{ code: "invalid_value", path: [], values: ["pairing", "allowlist"] }],
          [{ code: "invalid_value", path: [], values: ["open", "disabled"] }],
        ],
      });
      expect(result).toMatchObject({
        path: "dmPolicy",
        allowedValues: expect.arrayContaining(["pairing", "allowlist", "open", "disabled"]),
      });
      expect(result.allowedValues).toHaveLength(4);
    });

    it("returns no allowed values for invalid_union with incomplete branch", () => {
      const result = testing.mapZodIssueToConfigIssue({
        code: "invalid_union",
        path: ["dmPolicy"],
        message: "Invalid input",
        errors: [
          [{ code: "invalid_value", path: [], values: ["pairing"] }],
          // empty branch → incomplete
          [],
        ],
      });
      expect(result.allowedValues).toBeUndefined();
      expect(result.allowedValuesHiddenCount).toBeUndefined();
    });

    it("returns no allowed values for invalid_union with empty errors", () => {
      const result = testing.mapZodIssueToConfigIssue({
        code: "invalid_union",
        path: ["dmPolicy"],
        message: "Invalid input",
        errors: [],
      });
      expect(result.allowedValues).toBeUndefined();
    });

    it("returns no allowed values for invalid_union with non-array errors", () => {
      const result = testing.mapZodIssueToConfigIssue({
        code: "invalid_union",
        path: ["dmPolicy"],
        message: "Invalid input",
        errors: "not-an-array",
      });
      expect(result.allowedValues).toBeUndefined();
    });

    it("returns no allowed values for invalid_value with non-array values", () => {
      const result = testing.mapZodIssueToConfigIssue({
        code: "invalid_value",
        path: ["color"],
        message: "Invalid value",
        values: "not-an-array",
      });
      expect(result.allowedValues).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // AllowedValuesHiddenCount when > MAX_ALLOWED_VALUES_HINT (12)
  // ---------------------------------------------------------------------------

  describe("allowed values hidden count", () => {
    it("includes hiddenCount when allowed values exceed 12", () => {
      const values = Array.from({ length: 15 }, (_, i) => `value-${i}`);
      const result = testing.mapZodIssueToConfigIssue({
        code: "invalid_value",
        path: ["many"],
        message: "too many options",
        values,
      });
      expect(result.allowedValues).toHaveLength(12);
      expect(result.allowedValuesHiddenCount).toBe(3);
    });

    it("has hiddenCount 0 when allowed values are 12 or fewer", () => {
      const values = Array.from({ length: 5 }, (_, i) => `v${i}`);
      const result = testing.mapZodIssueToConfigIssue({
        code: "invalid_value",
        path: ["few"],
        message: "some options",
        values,
      });
      expect(result.allowedValues).toHaveLength(5);
      expect(result.allowedValuesHiddenCount).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Bindings-specific union extraction
  // ---------------------------------------------------------------------------

  describe("bindings-specific union extraction", () => {
    it("extracts a matching branch issue for bindings path with route mismatch", () => {
      const result = testing.mapZodIssueToConfigIssue({
        code: "invalid_union",
        path: ["bindings", 0],
        message: "Invalid input",
        errors: [
          // Route type mismatch — triggers the extraction, will be filtered
          [{ code: "invalid_value", path: ["type"], values: ["route"] }],
          // Valid branch — this one gets extracted
          [{ code: "invalid_type", path: ["url"], message: "Expected string" }],
        ],
      });
      expect(result).toEqual({
        path: "bindings.0.url",
        message: "Expected string",
      });
    });

    it("filters out route-type-mismatch branches", () => {
      const result = testing.mapZodIssueToConfigIssue({
        code: "invalid_union",
        path: ["bindings", 0],
        message: "Invalid input",
        errors: [
          // Route type mismatch — should be skipped
          [{ code: "invalid_value", path: ["type"], values: ["route"] }],
          // Valid branch
          [{ code: "invalid_type", path: ["channel"], message: "Expected string" }],
        ],
      });
      expect(result).toEqual({
        path: "bindings.0.channel",
        message: "Expected string",
      });
    });

    it("returns null (no extraction) when multiple branches match", () => {
      const result = testing.mapZodIssueToConfigIssue({
        code: "invalid_union",
        path: ["bindings", 0],
        message: "Invalid input",
        errors: [
          [{ code: "invalid_type", path: ["url"], message: "Bad url" }],
          [{ code: "invalid_type", path: ["channel"], message: "Bad channel" }],
        ],
      });
      // Ambiguous — falls back to the original union message
      expect(result.path).toBe("bindings.0");
      expect(result.message).toBe("Invalid input");
    });

    it("returns null for non-bindings invalid_union", () => {
      const result = testing.mapZodIssueToConfigIssue({
        code: "invalid_union",
        path: ["logging", "level"],
        message: "Invalid input",
        errors: [[{ code: "invalid_value", path: [], values: ["debug", "info"] }]],
      });
      // Non-bindings path with allowed values → shows allowed values
      expect(result.allowedValues).toBeDefined();
    });

    it("returns null for bindings with no array errors", () => {
      const result = testing.mapZodIssueToConfigIssue({
        code: "invalid_union",
        path: ["bindings", 0],
        message: "Invalid input",
      });
      expect(result.path).toBe("bindings.0");
      expect(result.message).toBe("Invalid input");
    });
  });

  // ---------------------------------------------------------------------------
  // Combined scenarios
  // ---------------------------------------------------------------------------

  describe("combined scenarios", () => {
    it("includes both numeric bound hint and allowed values when both apply", () => {
      const result = testing.mapZodIssueToConfigIssue({
        code: "custom",
        path: ["maxTokens"],
        message: 'expected one of "100"|"200"|"500"|"1000"',
        origin: "number",
        maximum: 1000,
        inclusive: true,
      });
      // Message already contains allowed values, so no "(allowed: ...)" suffix
      expect(result.message).toMatch(/expected one of/);
      // But the allowed values metadata is still attached
      expect(result.allowedValues).toContain("100");
      expect(result.allowedValues).toContain("200");
    });

    it("handles malformed input gracefully", () => {
      // @ts-expect-error — testing runtime resilience
      const result = testing.mapZodIssueToConfigIssue(null);
      expect(result.path).toBe("");
      expect(result.message).toBe("Invalid input");
    });

    it("handles undefined input gracefully", () => {
      const result = testing.mapZodIssueToConfigIssue(undefined);
      expect(result.path).toBe("");
      expect(result.message).toBe("Invalid input");
    });
  });
});
