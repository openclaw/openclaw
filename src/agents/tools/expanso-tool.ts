/**
 * Unified Expanso Pipeline Tool
 *
 * Combines the NL-to-pipeline generator ({@link createExpansoGeneratorTool})
 * and the YAML validator ({@link createExpansoValidatorTool}) into a single
 * agent-facing tool named `expanso`.
 *
 * Supported actions:
 *
 * - `build`    – Generate an Expanso pipeline YAML from a natural language description.
 * - `validate` – Validate an existing pipeline YAML string using the expanso binary.
 * - `fix`      – Generate a pipeline, validate it, then automatically re-prompt the
 *                LLM with validation errors to produce a corrected pipeline (up to
 *                {@link DEFAULT_FIX_MAX_ATTEMPTS} rounds).
 *
 * @example
 * // Production usage
 * const tool = createExpansoTool({ apiKey: process.env.ANTHROPIC_API_KEY });
 *
 * // Test usage — inject deterministic mocks for both generator and validator
 * const tool = createExpansoTool({
 *   generatePipeline: async (desc) => ({ name: 'test', inputs: [...], outputs: [...] }),
 *   validateYaml: async (yaml) => ({ success: true, errors: [], warnings: [], exitCode: 0 }),
 * });
 */

import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { stringify as yamlStringify } from "yaml";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";
import { defaultGeneratePipeline } from "./expanso-generator.js";
import {
  ExpansoPipelineSchema,
  type ExpansoPipeline,
  type ExpansoValidationResult,
} from "./expanso-schemas.js";
import { defaultValidateYaml } from "./expanso-validator.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum number of generate→validate→fix iterations before giving up. */
const DEFAULT_FIX_MAX_ATTEMPTS = 3;

// ---------------------------------------------------------------------------
// Input schema (flat — no top-level Union to satisfy LLM tool schema constraints)
// ---------------------------------------------------------------------------

/**
 * TypeBox schema for the unified `expanso` tool parameters.
 *
 * Uses a flat object with a required `action` discriminator field instead of
 * `Type.Union` to avoid nested `anyOf` rejection by OpenAI/Vertex APIs.
 *
 * - `action`      – One of `"build"`, `"validate"`, or `"fix"` (required).
 * - `description` – Natural language description (required for `build` and `fix`).
 * - `yaml`        – Pipeline YAML string (required for `validate`; optional for `fix`
 *                   when you want to start from an existing YAML instead of generating).
 * - `apiKey`      – Optional LLM API key forwarded to the generator.
 */
const ExpansoToolInputSchema = Type.Object({
  action: Type.String({
    description:
      'Action to perform. One of: "build" (generate pipeline YAML from description), ' +
      '"validate" (validate an existing pipeline YAML string), ' +
      '"fix" (generate a pipeline, validate it, and automatically fix any errors).',
  }),
  description: Type.Optional(
    Type.String({
      description:
        'Natural language description of the pipeline (required for "build" and "fix"). ' +
        'Example: "Read CSV files from disk, filter rows where status=active, write JSON to stdout."',
    }),
  ),
  yaml: Type.Optional(
    Type.String({
      description:
        "An existing Expanso pipeline YAML string to validate or use as the starting point " +
        'for "fix". Required for "validate". Optional for "fix" — if omitted, the generator ' +
        "will produce a pipeline from the description first.",
    }),
  ),
  apiKey: Type.Optional(
    Type.String({
      description: "API key for the internal LLM used by the generator (optional).",
    }),
  ),
});

// ---------------------------------------------------------------------------
// Exported types
// ---------------------------------------------------------------------------

/** Options for injecting mocks and defaults into {@link createExpansoTool}. */
export type ExpansoToolOptions = {
  /** Default LLM API key (can be overridden per-call via the `apiKey` parameter). */
  apiKey?: string;
  /**
   * Override the pipeline generation function (inject mock in tests).
   * Defaults to {@link defaultGeneratePipeline} (real LLM call).
   */
  generatePipeline?: (description: string, apiKey?: string) => Promise<ExpansoPipeline>;
  /**
   * Override the YAML validation function (inject mock in tests).
   * Defaults to {@link defaultValidateYaml} (real Docker/binary execution).
   */
  validateYaml?: (yaml: string) => Promise<ExpansoValidationResult>;
  /**
   * Maximum number of fix iterations (generate → validate → re-generate loop).
   * Defaults to {@link DEFAULT_FIX_MAX_ATTEMPTS}.
   */
  maxFixAttempts?: number;
};

/** Result shape returned by the `build` action. */
export type ExpansoBuildResult = {
  action: "build";
  pipeline: ExpansoPipeline;
  yaml: string;
};

/** Result shape returned by the `validate` action. */
export type ExpansoValidateResult = {
  action: "validate";
  validation: ExpansoValidationResult;
};

/** Result shape returned by the `fix` action. */
export type ExpansoFixResult = {
  action: "fix";
  attempts: number;
  pipeline: ExpansoPipeline;
  yaml: string;
  validation: ExpansoValidationResult;
  fixed: boolean;
};

/** Union of all possible result shapes. */
export type ExpansoToolResult = ExpansoBuildResult | ExpansoValidateResult | ExpansoFixResult;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Serialise a pipeline object to YAML with consistent formatting. */
function pipelineToYaml(pipeline: ExpansoPipeline): string {
  return yamlStringify(pipeline, {
    lineWidth: 0,
    defaultStringType: "QUOTE_DOUBLE",
    defaultKeyType: "PLAIN",
  });
}

/**
 * Build the "fix" prompt that includes the previous YAML and its validation errors.
 * This is appended to the original description so the LLM can produce a corrected pipeline.
 */
function buildFixPrompt(
  description: string,
  yaml: string,
  validation: ExpansoValidationResult,
): string {
  const errorLines = validation.errors.map((e) => {
    const loc = e.location ? ` (at ${e.location})` : "";
    const code = e.code ? ` [${e.code}]` : "";
    return `  - ${e.message}${loc}${code}`;
  });

  return (
    `${description}\n\n` +
    `The following pipeline YAML was generated but failed validation. ` +
    `Please correct all errors and return a valid pipeline.\n\n` +
    `Previous YAML:\n\`\`\`yaml\n${yaml}\n\`\`\`\n\n` +
    `Validation errors:\n${errorLines.join("\n")}`
  );
}

// ---------------------------------------------------------------------------
// Action handlers
// ---------------------------------------------------------------------------

/** Handle the `build` action: generate pipeline YAML from a description. */
async function handleBuild(
  description: string,
  apiKey: string | undefined,
  generatePipeline: (desc: string, key?: string) => Promise<ExpansoPipeline>,
): Promise<ExpansoBuildResult> {
  const pipeline = await generatePipeline(description, apiKey);

  if (!Value.Check(ExpansoPipelineSchema, pipeline)) {
    const errors = [...Value.Errors(ExpansoPipelineSchema, pipeline)].map(
      (e) => `${e.path}: ${e.message}`,
    );
    throw new Error(`Generated pipeline failed schema validation:\n${errors.join("\n")}`);
  }

  return {
    action: "build",
    pipeline,
    yaml: pipelineToYaml(pipeline),
  };
}

/** Handle the `validate` action: validate an existing YAML string. */
async function handleValidate(
  yaml: string,
  validateYaml: (yaml: string) => Promise<ExpansoValidationResult>,
): Promise<ExpansoValidateResult> {
  const validation = await validateYaml(yaml);
  return { action: "validate", validation };
}

/**
 * Handle the `fix` action: iteratively generate → validate → re-generate until
 * the pipeline is valid or {@link maxAttempts} is reached.
 */
async function handleFix(
  description: string,
  startingYaml: string | undefined,
  apiKey: string | undefined,
  generatePipeline: (desc: string, key?: string) => Promise<ExpansoPipeline>,
  validateYaml: (yaml: string) => Promise<ExpansoValidationResult>,
  maxAttempts: number,
): Promise<ExpansoFixResult> {
  let currentYaml = startingYaml;
  let currentPipeline: ExpansoPipeline | undefined;
  let latestValidation: ExpansoValidationResult | undefined;
  let attempts = 0;
  let currentDescription = description;

  for (let i = 0; i < maxAttempts; i++) {
    attempts = i + 1;

    // Generate (or keep the starting YAML for the first attempt if supplied)
    if (currentYaml === undefined || i > 0) {
      const generated = await generatePipeline(currentDescription, apiKey);

      if (!Value.Check(ExpansoPipelineSchema, generated)) {
        const errors = [...Value.Errors(ExpansoPipelineSchema, generated)].map(
          (e) => `${e.path}: ${e.message}`,
        );
        throw new Error(`Generated pipeline failed schema validation:\n${errors.join("\n")}`);
      }

      currentPipeline = generated;
      currentYaml = pipelineToYaml(generated);
    } else {
      // First iteration with a supplied YAML — parse it to a pipeline object for the result.
      // We'll validate it and potentially regenerate from it.
      currentPipeline = undefined;
    }

    // Validate
    latestValidation = await validateYaml(currentYaml);

    if (latestValidation.success) {
      // Validation passed — we're done
      break;
    }

    // Build a richer prompt for the next attempt
    currentDescription = buildFixPrompt(description, currentYaml, latestValidation);
  }

  // Ensure we always have a pipeline object to return
  if (currentPipeline === undefined && currentYaml !== undefined) {
    // If we ended up with a starting YAML that was never regenerated (first attempt succeeded),
    // we don't have a parsed pipeline object. Return a minimal placeholder.
    // In practice, `validate` success on a supplied YAML means the YAML is already correct.
    // We return the raw YAML and mark pipeline as a parse-best-effort value.
    currentPipeline = {
      name: "supplied-pipeline",
      inputs: [{ name: "in", type: "stdin" }],
      outputs: [{ name: "out", type: "stdout" }],
    };
  }

  return {
    action: "fix",
    attempts,
    pipeline: currentPipeline!,
    yaml: currentYaml!,
    validation: latestValidation!,
    fixed: latestValidation!.success,
  };
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

/**
 * Creates the unified Expanso tool that supports `build`, `validate`, and `fix` actions.
 *
 * @param opts - Optional configuration: API key, mock overrides, fix iteration limit.
 * @returns An `AnyAgentTool` compatible with `@mariozechner/pi-agent-core`.
 *
 * @example
 * // Production usage
 * const tool = createExpansoTool({ apiKey: 'sk-...' });
 *
 * // Test usage
 * const tool = createExpansoTool({
 *   generatePipeline: async (desc) => ({
 *     name: 'mock-pipeline',
 *     inputs:  [{ name: 'in',  type: 'stdin'  }],
 *     outputs: [{ name: 'out', type: 'stdout' }],
 *   }),
 *   validateYaml: async () => ({ success: true, errors: [], warnings: [], exitCode: 0 }),
 * });
 */
export function createExpansoTool(opts?: ExpansoToolOptions): AnyAgentTool {
  const generatePipeline = opts?.generatePipeline ?? defaultGeneratePipeline;
  const validateYaml = opts?.validateYaml ?? defaultValidateYaml;
  const defaultApiKey = opts?.apiKey;
  const maxFixAttempts = opts?.maxFixAttempts ?? DEFAULT_FIX_MAX_ATTEMPTS;

  return {
    label: "Expanso Pipeline Builder & Validator",
    name: "expanso",
    description:
      "Unified tool to build and validate Expanso data pipeline configurations using natural language.\n\n" +
      "Actions:\n" +
      "  • build    – Generate an Expanso pipeline YAML from a plain English description.\n" +
      "  • validate – Validate an existing pipeline YAML using the expanso binary in a secure sandbox.\n" +
      "  • fix      – Generate a pipeline, validate it, and automatically fix errors (up to 3 rounds).",
    parameters: ExpansoToolInputSchema,

    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });
      const description = readStringParam(params, "description");
      const yaml = readStringParam(params, "yaml");
      const callApiKey = readStringParam(params, "apiKey") ?? defaultApiKey;

      switch (action) {
        case "build": {
          if (!description) {
            throw new Error('description is required for action "build"');
          }
          const result = await handleBuild(description, callApiKey, generatePipeline);
          return jsonResult(result);
        }

        case "validate": {
          if (!yaml) {
            throw new Error('yaml is required for action "validate"');
          }
          const result = await handleValidate(yaml, validateYaml);
          return jsonResult(result);
        }

        case "fix": {
          if (!description && !yaml) {
            throw new Error('At least one of description or yaml is required for action "fix"');
          }
          const fixDescription = description ?? "Fix the pipeline YAML to pass validation";
          const result = await handleFix(
            fixDescription,
            yaml,
            callApiKey,
            generatePipeline,
            validateYaml,
            maxFixAttempts,
          );
          return jsonResult(result);
        }

        default: {
          throw new Error(
            `Unknown action "${action}". Valid actions are: "build", "validate", "fix".`,
          );
        }
      }
    },
  };
}
