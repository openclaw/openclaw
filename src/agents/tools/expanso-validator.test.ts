/**
 * Tests for the Expanso pipeline validator tool.
 *
 * All tests use dependency injection to avoid real Docker/binary calls.
 * The `validateYaml` option is injected with a deterministic mock.
 */

import { describe, it, expect, vi } from "vitest";
import type { ExpansoValidationResult } from "./expanso-schemas.js";
import {
  createExpansoValidatorTool,
  parseBinaryOutput,
  type ExpansoValidatorToolOptions,
} from "./expanso-validator.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const VALID_PIPELINE_YAML = `
name: csv-to-json
description: Reads CSV and outputs JSON
inputs:
  - name: csv-in
    type: file
    config:
      paths: ["/data/input.csv"]
outputs:
  - name: json-out
    type: stdout
`.trim();

const INVALID_PIPELINE_YAML = `
this is not valid yaml: [
`.trim();

const MISSING_REQUIRED_FIELDS_YAML = `
name: broken-pipeline
# missing inputs and outputs
`.trim();

/** Helper: build a mock validateYaml that returns a fixed result. */
function mockValidator(
  result: ExpansoValidationResult,
): ExpansoValidatorToolOptions["validateYaml"] {
  return vi.fn().mockResolvedValue(result);
}

/** Helper: build a success result. */
function successResult(overrides: Partial<ExpansoValidationResult> = {}): ExpansoValidationResult {
  return {
    success: true,
    errors: [],
    warnings: [],
    exitCode: 0,
    ...overrides,
  };
}

/** Helper: build a failure result. */
function failureResult(
  errorMessage: string,
  overrides: Partial<ExpansoValidationResult> = {},
): ExpansoValidationResult {
  return {
    success: false,
    errors: [{ message: errorMessage }],
    warnings: [],
    exitCode: 1,
    ...overrides,
  };
}

/**
 * Execute the tool and parse the JSON result from content[0].text.
 * `jsonResult` wraps the payload in `content[0].text` as JSON.
 */
async function runValidator(
  opts: ExpansoValidatorToolOptions,
  yaml: string,
): Promise<ExpansoValidationResult> {
  const tool = createExpansoValidatorTool(opts);
  const toolResult = await tool.execute("test-call-id", { yaml });
  const content = toolResult.content[0];
  if (content.type !== "text") {
    throw new Error("Expected text content from tool");
  }
  return JSON.parse(content.text) as ExpansoValidationResult;
}

// ---------------------------------------------------------------------------
// Tool metadata
// ---------------------------------------------------------------------------

describe("createExpansoValidatorTool - metadata", () => {
  const tool = createExpansoValidatorTool({ validateYaml: mockValidator(successResult()) });

  it("has the correct name", () => {
    expect(tool.name).toBe("expanso_validate");
  });

  it("has the correct label", () => {
    expect(tool.label).toBe("Expanso Pipeline Validator");
  });

  it("has a non-empty description", () => {
    expect(typeof tool.description).toBe("string");
    expect(tool.description.length).toBeGreaterThan(10);
  });

  it("description mentions validation", () => {
    expect(tool.description.toLowerCase()).toContain("valid");
  });

  it("has an execute function", () => {
    expect(typeof tool.execute).toBe("function");
  });

  it("has a parameters schema", () => {
    expect(tool.parameters).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Tool execution — valid pipeline
// ---------------------------------------------------------------------------

describe("createExpansoValidatorTool - valid pipeline", () => {
  it("returns success=true for a valid pipeline YAML", async () => {
    const result = await runValidator(
      { validateYaml: mockValidator(successResult()) },
      VALID_PIPELINE_YAML,
    );
    expect(result.success).toBe(true);
  });

  it("returns an empty errors array for a valid pipeline", async () => {
    const result = await runValidator(
      { validateYaml: mockValidator(successResult()) },
      VALID_PIPELINE_YAML,
    );
    expect(result.errors).toEqual([]);
  });

  it("returns exitCode 0 for a valid pipeline", async () => {
    const result = await runValidator(
      { validateYaml: mockValidator(successResult({ exitCode: 0 })) },
      VALID_PIPELINE_YAML,
    );
    expect(result.exitCode).toBe(0);
  });

  it("passes the yaml string to the validator function", async () => {
    const spy = vi.fn().mockResolvedValue(successResult());
    const tool = createExpansoValidatorTool({ validateYaml: spy });
    await tool.execute("tc-4", { yaml: VALID_PIPELINE_YAML });
    expect(spy).toHaveBeenCalledOnce();
    expect(spy).toHaveBeenCalledWith(VALID_PIPELINE_YAML);
  });

  it("surfaces rawOutput when provided by the binary", async () => {
    const result = await runValidator(
      { validateYaml: mockValidator(successResult({ rawOutput: "Validation passed!\n" })) },
      VALID_PIPELINE_YAML,
    );
    expect(result.rawOutput).toBe("Validation passed!\n");
  });
});

// ---------------------------------------------------------------------------
// Tool execution — invalid pipeline
// ---------------------------------------------------------------------------

describe("createExpansoValidatorTool - invalid pipeline", () => {
  it("returns success=false for an invalid pipeline YAML", async () => {
    const result = await runValidator(
      { validateYaml: mockValidator(failureResult("YAML parse error at line 2")) },
      INVALID_PIPELINE_YAML,
    );
    expect(result.success).toBe(false);
  });

  it("surfaces the error message in the errors array", async () => {
    const errorMsg = "YAML parse error at line 2";
    const result = await runValidator(
      { validateYaml: mockValidator(failureResult(errorMsg)) },
      INVALID_PIPELINE_YAML,
    );
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toBe(errorMsg);
  });

  it("returns a non-zero exitCode for an invalid pipeline", async () => {
    const result = await runValidator(
      { validateYaml: mockValidator(failureResult("bad config", { exitCode: 1 })) },
      INVALID_PIPELINE_YAML,
    );
    expect(result.exitCode).toBe(1);
  });

  it("surfaces rawError when provided by the binary", async () => {
    const rawErr = "ERROR: missing required field 'inputs'";
    const result = await runValidator(
      {
        validateYaml: mockValidator(
          failureResult("missing required field 'inputs'", { rawError: rawErr }),
        ),
      },
      MISSING_REQUIRED_FIELDS_YAML,
    );
    expect(result.rawError).toBe(rawErr);
  });

  it("surfaces multiple errors when the binary reports several issues", async () => {
    const multiErrorResult: ExpansoValidationResult = {
      success: false,
      errors: [{ message: "inputs is required" }, { message: "outputs is required" }],
      warnings: [],
      exitCode: 2,
    };
    const result = await runValidator(
      { validateYaml: mockValidator(multiErrorResult) },
      MISSING_REQUIRED_FIELDS_YAML,
    );
    expect(result.errors).toHaveLength(2);
    expect(result.errors[0].message).toBe("inputs is required");
    expect(result.errors[1].message).toBe("outputs is required");
  });

  it("surfaces error location when binary provides it", async () => {
    const resultWithLocation: ExpansoValidationResult = {
      success: false,
      errors: [{ message: "unexpected token", location: "line 2" }],
      warnings: [],
      exitCode: 1,
    };
    const result = await runValidator(
      { validateYaml: mockValidator(resultWithLocation) },
      INVALID_PIPELINE_YAML,
    );
    expect(result.errors[0].location).toBe("line 2");
  });
});

// ---------------------------------------------------------------------------
// Tool execution — warnings
// ---------------------------------------------------------------------------

describe("createExpansoValidatorTool - warnings", () => {
  it("includes warnings in the result when present", async () => {
    const withWarnings: ExpansoValidationResult = {
      success: true,
      errors: [],
      warnings: [{ message: "deprecated field 'config.batch_size'" }],
      exitCode: 0,
    };
    const result = await runValidator(
      { validateYaml: mockValidator(withWarnings) },
      VALID_PIPELINE_YAML,
    );
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].message).toBe("deprecated field 'config.batch_size'");
  });

  it("warnings do not affect success status", async () => {
    const withWarnings: ExpansoValidationResult = {
      success: true,
      errors: [],
      warnings: [{ message: "some warning" }],
      exitCode: 0,
    };
    const result = await runValidator(
      { validateYaml: mockValidator(withWarnings) },
      VALID_PIPELINE_YAML,
    );
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tool execution — input validation
// ---------------------------------------------------------------------------

describe("createExpansoValidatorTool - input validation", () => {
  it("throws when yaml parameter is missing", async () => {
    const tool = createExpansoValidatorTool({ validateYaml: mockValidator(successResult()) });
    await expect(tool.execute("tc-30", {})).rejects.toThrow();
  });

  it("throws when yaml parameter is empty", async () => {
    const tool = createExpansoValidatorTool({ validateYaml: mockValidator(successResult()) });
    await expect(tool.execute("tc-31", { yaml: "" })).rejects.toThrow();
  });

  it("throws when yaml parameter is not a string", async () => {
    const tool = createExpansoValidatorTool({ validateYaml: mockValidator(successResult()) });
    await expect(tool.execute("tc-32", { yaml: 42 })).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Tool execution — error propagation
// ---------------------------------------------------------------------------

describe("createExpansoValidatorTool - error propagation", () => {
  it("re-throws errors from the validator function", async () => {
    const failingValidator = vi.fn().mockRejectedValue(new Error("Docker not available"));
    const tool = createExpansoValidatorTool({ validateYaml: failingValidator });
    await expect(tool.execute("tc-40", { yaml: VALID_PIPELINE_YAML })).rejects.toThrow(
      "Docker not available",
    );
  });

  it("calls the validator exactly once per execute call", async () => {
    const spy = vi.fn().mockResolvedValue(successResult());
    const tool = createExpansoValidatorTool({ validateYaml: spy });
    await tool.execute("tc-41", { yaml: VALID_PIPELINE_YAML });
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// parseBinaryOutput helper
// ---------------------------------------------------------------------------

describe("parseBinaryOutput", () => {
  it("returns empty array for empty input", () => {
    expect(parseBinaryOutput("", true)).toEqual([]);
    expect(parseBinaryOutput("   ", true)).toEqual([]);
  });

  it("parses a simple error line into a diagnostic", () => {
    const result = parseBinaryOutput("unexpected key in mapping", true);
    expect(result).toHaveLength(1);
    expect(result[0].message).toBe("unexpected key in mapping");
  });

  it("strips ERROR: prefix from messages", () => {
    const result = parseBinaryOutput("ERROR: missing required field", true);
    expect(result[0].message).toBe("missing required field");
  });

  it("strips WARN: prefix from messages", () => {
    const result = parseBinaryOutput("WARN: deprecated option used", false);
    expect(result[0].message).toBe("deprecated option used");
  });

  it("strips WARNING: prefix from messages", () => {
    const result = parseBinaryOutput("WARNING: large batch size", false);
    expect(result[0].message).toBe("large batch size");
  });

  it("skips INFO lines", () => {
    const result = parseBinaryOutput("INFO Starting validation\nERROR: bad config", true);
    expect(result).toHaveLength(1);
    expect(result[0].message).toBe("bad config");
  });

  it("skips DEBUG lines", () => {
    const result = parseBinaryOutput("DEBUG loading config\nERROR: bad field", true);
    expect(result).toHaveLength(1);
    expect(result[0].message).toBe("bad field");
  });

  it("extracts line number as location", () => {
    const result = parseBinaryOutput("parse error at line 42", true);
    expect(result[0].location).toBe("line 42");
  });

  it("handles multiple lines producing multiple diagnostics", () => {
    const text = "ERROR: missing inputs\nERROR: missing outputs";
    const result = parseBinaryOutput(text, true);
    expect(result).toHaveLength(2);
  });

  it("deduplicates consecutive identical messages", () => {
    const text = "ERROR: same error\nERROR: same error";
    const result = parseBinaryOutput(text, true);
    expect(result).toHaveLength(1);
  });

  it("falls back to raw text as a single diagnostic when nothing parseable found", () => {
    // A line that starts with neither INFO/DEBUG nor a prefix to strip
    const raw = "some unparseable binary garbage output";
    const result = parseBinaryOutput(raw, true);
    expect(result).toHaveLength(1);
    expect(result[0].message).toContain("unparseable");
  });

  it("extracts error codes like E001 from message", () => {
    const result = parseBinaryOutput("E001: schema violation", true);
    expect(result[0].code).toBe("E001");
  });
});
