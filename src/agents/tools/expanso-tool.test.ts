/**
 * Tests for the unified Expanso tool (US-005).
 *
 * All tests use dependency injection to avoid real LLM or Docker calls.
 * - `generatePipeline` is mocked to return a deterministic pipeline.
 * - `validateYaml` is mocked to return a deterministic validation result.
 */

import { describe, it, expect, vi } from "vitest";
import type { ExpansoPipeline, ExpansoValidationResult } from "./expanso-schemas.js";
import {
  createExpansoTool,
  type ExpansoToolOptions,
  type ExpansoBuildResult,
  type ExpansoValidateResult,
  type ExpansoFixResult,
} from "./expanso-tool.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MOCK_PIPELINE: ExpansoPipeline = {
  name: "csv-to-json",
  description: "Read CSV, write JSON",
  inputs: [{ name: "csv-in", type: "file", config: { paths: ["/data/input.csv"] } }],
  outputs: [{ name: "json-out", type: "stdout" }],
};

const VALID_YAML = `name: "csv-to-json"\ndescription: "Read CSV, write JSON"`;

const SUCCESS_VALIDATION: ExpansoValidationResult = {
  success: true,
  errors: [],
  warnings: [],
  exitCode: 0,
};

const FAILURE_VALIDATION: ExpansoValidationResult = {
  success: false,
  errors: [{ message: "inputs field is required" }, { message: "outputs field is required" }],
  warnings: [],
  exitCode: 1,
};

/** Create a tool with fully mocked generator + validator. */
function makeTool(
  overrides: Partial<ExpansoToolOptions> = {},
): ReturnType<typeof createExpansoTool> {
  return createExpansoTool({
    generatePipeline: vi.fn().mockResolvedValue(MOCK_PIPELINE),
    validateYaml: vi.fn().mockResolvedValue(SUCCESS_VALIDATION),
    ...overrides,
  });
}

/**
 * Execute the tool and parse the JSON response from content[0].text.
 */
async function runTool(
  tool: ReturnType<typeof createExpansoTool>,
  args: Record<string, unknown>,
): Promise<unknown> {
  const result = await tool.execute("test-call-id", args);
  const content = result.content[0];
  if (content.type !== "text") {
    throw new Error("Expected text content from tool");
  }
  return JSON.parse(content.text) as unknown;
}

// ---------------------------------------------------------------------------
// Tool metadata
// ---------------------------------------------------------------------------

describe("createExpansoTool - metadata", () => {
  const tool = makeTool();

  it("has name 'expanso'", () => {
    expect(tool.name).toBe("expanso");
  });

  it("has a non-empty label", () => {
    expect(typeof tool.label).toBe("string");
    expect(tool.label.length).toBeGreaterThan(0);
  });

  it("description mentions build, validate, and fix", () => {
    expect(tool.description.toLowerCase()).toContain("build");
    expect(tool.description.toLowerCase()).toContain("validate");
    expect(tool.description.toLowerCase()).toContain("fix");
  });

  it("has an execute function", () => {
    expect(typeof tool.execute).toBe("function");
  });

  it("has a parameters schema", () => {
    expect(tool.parameters).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// build action
// ---------------------------------------------------------------------------

describe("createExpansoTool - build action", () => {
  it("returns action='build' in the result", async () => {
    const tool = makeTool();
    const result = (await runTool(tool, {
      action: "build",
      description: "Read CSV, write JSON",
    })) as ExpansoBuildResult;
    expect(result.action).toBe("build");
  });

  it("returns the generated pipeline object", async () => {
    const tool = makeTool();
    const result = (await runTool(tool, {
      action: "build",
      description: "Read CSV, write JSON",
    })) as ExpansoBuildResult;
    expect(result.pipeline).toBeDefined();
    expect(result.pipeline.name).toBe("csv-to-json");
  });

  it("returns a YAML string", async () => {
    const tool = makeTool();
    const result = (await runTool(tool, {
      action: "build",
      description: "Read CSV, write JSON",
    })) as ExpansoBuildResult;
    expect(typeof result.yaml).toBe("string");
    expect(result.yaml.length).toBeGreaterThan(0);
  });

  it("YAML contains the pipeline name", async () => {
    const tool = makeTool();
    const result = (await runTool(tool, {
      action: "build",
      description: "Read CSV, write JSON",
    })) as ExpansoBuildResult;
    expect(result.yaml).toContain("csv-to-json");
  });

  it("calls generatePipeline with the provided description", async () => {
    const mockGen = vi.fn().mockResolvedValue(MOCK_PIPELINE);
    const tool = makeTool({ generatePipeline: mockGen });
    await runTool(tool, { action: "build", description: "Read CSV, write JSON" });
    expect(mockGen).toHaveBeenCalledOnce();
    expect(mockGen).toHaveBeenCalledWith("Read CSV, write JSON", undefined);
  });

  it("forwards apiKey to generatePipeline", async () => {
    const mockGen = vi.fn().mockResolvedValue(MOCK_PIPELINE);
    const tool = makeTool({ generatePipeline: mockGen });
    await runTool(tool, { action: "build", description: "desc", apiKey: "sk-test-key" });
    expect(mockGen).toHaveBeenCalledWith("desc", "sk-test-key");
  });

  it("uses default apiKey when not provided per-call", async () => {
    const mockGen = vi.fn().mockResolvedValue(MOCK_PIPELINE);
    const tool = makeTool({ generatePipeline: mockGen, apiKey: "sk-default" });
    await runTool(tool, { action: "build", description: "desc" });
    expect(mockGen).toHaveBeenCalledWith("desc", "sk-default");
  });

  it("throws when description is missing for build", async () => {
    const tool = makeTool();
    await expect(runTool(tool, { action: "build" })).rejects.toThrow(/description/i);
  });

  it("throws when description is empty for build", async () => {
    const tool = makeTool();
    await expect(runTool(tool, { action: "build", description: "" })).rejects.toThrow(
      /description/i,
    );
  });

  it("re-throws errors from the generator", async () => {
    const tool = makeTool({
      generatePipeline: vi.fn().mockRejectedValue(new Error("LLM unavailable")),
    });
    await expect(runTool(tool, { action: "build", description: "desc" })).rejects.toThrow(
      "LLM unavailable",
    );
  });
});

// ---------------------------------------------------------------------------
// validate action
// ---------------------------------------------------------------------------

describe("createExpansoTool - validate action", () => {
  it("returns action='validate' in the result", async () => {
    const tool = makeTool();
    const result = (await runTool(tool, {
      action: "validate",
      yaml: VALID_YAML,
    })) as ExpansoValidateResult;
    expect(result.action).toBe("validate");
  });

  it("returns the validation result", async () => {
    const tool = makeTool();
    const result = (await runTool(tool, {
      action: "validate",
      yaml: VALID_YAML,
    })) as ExpansoValidateResult;
    expect(result.validation.success).toBe(true);
    expect(result.validation.errors).toEqual([]);
  });

  it("passes the yaml to the validateYaml function", async () => {
    const mockVal = vi.fn().mockResolvedValue(SUCCESS_VALIDATION);
    const tool = makeTool({ validateYaml: mockVal });
    await runTool(tool, { action: "validate", yaml: VALID_YAML });
    expect(mockVal).toHaveBeenCalledOnce();
    expect(mockVal).toHaveBeenCalledWith(VALID_YAML);
  });

  it("surfaces validation failure result", async () => {
    const tool = makeTool({ validateYaml: vi.fn().mockResolvedValue(FAILURE_VALIDATION) });
    const result = (await runTool(tool, {
      action: "validate",
      yaml: "bad yaml",
    })) as ExpansoValidateResult;
    expect(result.validation.success).toBe(false);
    expect(result.validation.errors).toHaveLength(2);
  });

  it("throws when yaml is missing for validate", async () => {
    const tool = makeTool();
    await expect(runTool(tool, { action: "validate" })).rejects.toThrow(/yaml/i);
  });

  it("throws when yaml is empty for validate", async () => {
    const tool = makeTool();
    await expect(runTool(tool, { action: "validate", yaml: "" })).rejects.toThrow(/yaml/i);
  });

  it("re-throws errors from the validator", async () => {
    const tool = makeTool({
      validateYaml: vi.fn().mockRejectedValue(new Error("Docker not available")),
    });
    await expect(runTool(tool, { action: "validate", yaml: VALID_YAML })).rejects.toThrow(
      "Docker not available",
    );
  });
});

// ---------------------------------------------------------------------------
// fix action
// ---------------------------------------------------------------------------

describe("createExpansoTool - fix action (success on first attempt)", () => {
  it("returns action='fix' in the result", async () => {
    const tool = makeTool();
    const result = (await runTool(tool, {
      action: "fix",
      description: "Read CSV, write JSON",
    })) as ExpansoFixResult;
    expect(result.action).toBe("fix");
  });

  it("returns fixed=true when validation passes", async () => {
    const tool = makeTool();
    const result = (await runTool(tool, {
      action: "fix",
      description: "Read CSV, write JSON",
    })) as ExpansoFixResult;
    expect(result.fixed).toBe(true);
  });

  it("returns attempts=1 when pipeline is valid on first try", async () => {
    const tool = makeTool();
    const result = (await runTool(tool, {
      action: "fix",
      description: "desc",
    })) as ExpansoFixResult;
    expect(result.attempts).toBe(1);
  });

  it("returns a pipeline object", async () => {
    const tool = makeTool();
    const result = (await runTool(tool, {
      action: "fix",
      description: "desc",
    })) as ExpansoFixResult;
    expect(result.pipeline).toBeDefined();
    expect(result.pipeline.name).toBe("csv-to-json");
  });

  it("returns a YAML string", async () => {
    const tool = makeTool();
    const result = (await runTool(tool, {
      action: "fix",
      description: "desc",
    })) as ExpansoFixResult;
    expect(typeof result.yaml).toBe("string");
    expect(result.yaml.length).toBeGreaterThan(0);
  });

  it("returns the validation result", async () => {
    const tool = makeTool();
    const result = (await runTool(tool, {
      action: "fix",
      description: "desc",
    })) as ExpansoFixResult;
    expect(result.validation.success).toBe(true);
  });
});

describe("createExpansoTool - fix action (retry loop)", () => {
  it("re-prompts with validation errors and succeeds on second attempt", async () => {
    const mockGen = vi.fn().mockResolvedValue(MOCK_PIPELINE);
    // Fail first, pass second
    const mockVal = vi
      .fn()
      .mockResolvedValueOnce(FAILURE_VALIDATION)
      .mockResolvedValueOnce(SUCCESS_VALIDATION);

    const tool = makeTool({ generatePipeline: mockGen, validateYaml: mockVal });
    const result = (await runTool(tool, {
      action: "fix",
      description: "desc",
    })) as ExpansoFixResult;

    expect(result.fixed).toBe(true);
    expect(result.attempts).toBe(2);
    expect(mockGen).toHaveBeenCalledTimes(2);
  });

  it("second generation prompt includes validation errors from first attempt", async () => {
    const capturedDescriptions: string[] = [];
    const mockGen = vi.fn().mockImplementation(async (desc: string) => {
      capturedDescriptions.push(desc);
      return MOCK_PIPELINE;
    });
    const mockVal = vi
      .fn()
      .mockResolvedValueOnce(FAILURE_VALIDATION)
      .mockResolvedValueOnce(SUCCESS_VALIDATION);

    const tool = makeTool({ generatePipeline: mockGen, validateYaml: mockVal });
    await runTool(tool, { action: "fix", description: "Read CSV, write JSON" });

    // Second call should include validation errors in the description
    expect(capturedDescriptions[1]).toContain("inputs field is required");
    expect(capturedDescriptions[1]).toContain("outputs field is required");
  });

  it("second generation prompt includes the previous YAML", async () => {
    const capturedDescriptions: string[] = [];
    const mockGen = vi.fn().mockImplementation(async (desc: string) => {
      capturedDescriptions.push(desc);
      return MOCK_PIPELINE;
    });
    const mockVal = vi
      .fn()
      .mockResolvedValueOnce(FAILURE_VALIDATION)
      .mockResolvedValueOnce(SUCCESS_VALIDATION);

    const tool = makeTool({ generatePipeline: mockGen, validateYaml: mockVal });
    await runTool(tool, { action: "fix", description: "desc" });

    // Second call should contain YAML from the first attempt
    expect(capturedDescriptions[1]).toContain("csv-to-json");
  });

  it("stops after maxFixAttempts if validation keeps failing", async () => {
    const mockGen = vi.fn().mockResolvedValue(MOCK_PIPELINE);
    const mockVal = vi.fn().mockResolvedValue(FAILURE_VALIDATION); // always fails

    const tool = createExpansoTool({
      generatePipeline: mockGen,
      validateYaml: mockVal,
      maxFixAttempts: 2,
    });
    const result = (await runTool(tool, {
      action: "fix",
      description: "desc",
    })) as ExpansoFixResult;

    expect(result.fixed).toBe(false);
    expect(result.attempts).toBe(2);
    expect(mockGen).toHaveBeenCalledTimes(2);
  });

  it("returns fixed=false after exhausting all attempts", async () => {
    const tool = createExpansoTool({
      generatePipeline: vi.fn().mockResolvedValue(MOCK_PIPELINE),
      validateYaml: vi.fn().mockResolvedValue(FAILURE_VALIDATION),
      maxFixAttempts: 3,
    });
    const result = (await runTool(tool, {
      action: "fix",
      description: "desc",
    })) as ExpansoFixResult;
    expect(result.fixed).toBe(false);
    expect(result.attempts).toBe(3);
  });

  it("accepts an existing yaml as starting point and validates it before generating", async () => {
    const mockGen = vi.fn().mockResolvedValue(MOCK_PIPELINE);
    const mockVal = vi
      .fn()
      .mockResolvedValueOnce(FAILURE_VALIDATION) // first validation of existing yaml fails
      .mockResolvedValueOnce(SUCCESS_VALIDATION); // second (after regeneration) passes

    const tool = makeTool({ generatePipeline: mockGen, validateYaml: mockVal });
    const result = (await runTool(tool, {
      action: "fix",
      yaml: VALID_YAML,
      description: "desc",
    })) as ExpansoFixResult;

    expect(result.fixed).toBe(true);
    // First iteration validates the supplied yaml, generator is called for second iteration
    expect(mockVal).toHaveBeenCalledTimes(2);
  });
});

describe("createExpansoTool - fix action (input validation)", () => {
  it("throws when neither description nor yaml is provided for fix", async () => {
    const tool = makeTool();
    await expect(runTool(tool, { action: "fix" })).rejects.toThrow(/description|yaml/i);
  });

  it("uses yaml alone (with default description) when no description provided", async () => {
    const mockVal = vi.fn().mockResolvedValue(SUCCESS_VALIDATION);
    const tool = makeTool({ validateYaml: mockVal });
    const result = (await runTool(tool, { action: "fix", yaml: VALID_YAML })) as ExpansoFixResult;
    // Should not throw; uses fallback description
    expect(result.action).toBe("fix");
  });
});

// ---------------------------------------------------------------------------
// Unknown action
// ---------------------------------------------------------------------------

describe("createExpansoTool - unknown action", () => {
  it("throws for an unrecognised action", async () => {
    const tool = makeTool();
    await expect(runTool(tool, { action: "unknown-action" })).rejects.toThrow(/unknown action/i);
  });

  it("throws when action is missing", async () => {
    const tool = makeTool();
    await expect(runTool(tool, {})).rejects.toThrow();
  });
});
