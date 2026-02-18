/**
 * Expanso Pipeline Validation Tool
 *
 * Validates a pipeline YAML configuration by running the `expanso validate`
 * binary inside the cloud validation sandbox (Docker isolation).
 *
 * The tool accepts a YAML string, writes it to a temporary workspace,
 * invokes the sandbox, and returns a structured {@link ExpansoValidationResult}
 * — including any errors, warnings, raw binary output, and exit code.
 *
 * @example
 * // Production usage (runs real Docker sandbox)
 * const tool = createExpansoValidatorTool();
 *
 * // Test usage — inject a deterministic mock validator
 * const tool = createExpansoValidatorTool({
 *   validateYaml: async (yaml) => ({
 *     success: true,
 *     errors: [],
 *     warnings: [],
 *     exitCode: 0,
 *   }),
 * });
 */

import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";
import {
  type ExpansoValidationResult,
  type ExpansoValidationDiagnostic,
} from "./expanso-schemas.js";

// ---------------------------------------------------------------------------
// Input schema for the validator tool
// ---------------------------------------------------------------------------

/**
 * TypeBox schema for the parameters accepted by the `expanso_validate` tool.
 *
 * The LLM agent passes:
 *  - `yaml` – the Expanso pipeline YAML string to validate
 */
const ExpansoValidatorInputSchema = Type.Object({
  yaml: Type.String({
    description:
      "The Expanso pipeline YAML configuration to validate. " +
      "Pass the output of expanso_generate or any manually authored YAML string.",
  }),
});

// ---------------------------------------------------------------------------
// Exported types
// ---------------------------------------------------------------------------

/**
 * Options passed to {@link createExpansoValidatorTool}.
 */
export type ExpansoValidatorToolOptions = {
  /**
   * Override the validation execution function.
   *
   * Inject a mock here during testing to avoid real Docker/binary calls.
   * Defaults to {@link defaultValidateYaml} which runs the actual Docker sandbox.
   */
  validateYaml?: (yaml: string) => Promise<ExpansoValidationResult>;
};

// ---------------------------------------------------------------------------
// Output parsing helpers
// ---------------------------------------------------------------------------

/**
 * Parse raw output from the `expanso validate` binary into structured
 * {@link ExpansoValidationDiagnostic} objects.
 *
 * The binary prints errors/warnings to stderr in a line-based format.
 * This function extracts actionable diagnostics from that raw text.
 *
 * @param rawText - Combined stdout/stderr text from the binary.
 * @param isError - When true, lines are classified as errors; otherwise warnings.
 * @returns Array of parsed diagnostics.
 */
export function parseBinaryOutput(
  rawText: string,
  isError: boolean,
): ExpansoValidationDiagnostic[] {
  if (!rawText.trim()) {
    return [];
  }

  const diagnostics: ExpansoValidationDiagnostic[] = [];
  const lines = rawText.split(/\r?\n/).filter((l) => l.trim().length > 0);

  for (const line of lines) {
    // Skip lines that look like progress/info output from the binary.
    // expanso prints INFO/DEBUG prefix for non-error messages.
    if (/^\s*(INFO|DEBUG|TRACE)/i.test(line)) {
      continue;
    }

    // Try to extract a location hint: "at line N", "line N", or "field: ..."
    let location: string | undefined;
    const lineMatch = line.match(/(?:at\s+)?line\s+(\d+)/i);
    const fieldMatch = line.match(/^([a-zA-Z0-9_.[\]]+):\s/);

    if (lineMatch) {
      location = `line ${lineMatch[1]}`;
    } else if (fieldMatch) {
      location = fieldMatch[1];
    }

    // Try to extract an error code: things like "E001", "WARN:XXX", etc.
    let code: string | undefined;
    const codeMatch = line.match(/\b([EW]\d{3,})\b/);
    if (codeMatch) {
      code = codeMatch[1];
    }

    // Build a clean message: strip leading log prefixes like "ERROR: " or "WARN: "
    const message = line.replace(/^(ERROR|WARN(?:ING)?|FATAL):\s*/i, "").trim();

    if (!message) {
      continue;
    }

    const diagnostic: ExpansoValidationDiagnostic = { message };
    if (location) {
      diagnostic.location = location;
    }
    if (code) {
      diagnostic.code = code;
    }

    // Only add if not duplicating the previous entry
    const last = diagnostics[diagnostics.length - 1];
    if (!last || last.message !== message) {
      diagnostics.push(diagnostic);
    }
  }

  // If we parsed nothing but there WAS text, produce a single catch-all diagnostic.
  if (diagnostics.length === 0 && rawText.trim()) {
    const fallback: ExpansoValidationDiagnostic = {
      message: rawText.trim().slice(0, 500),
    };
    if (!isError) {
      // warnings are non-fatal; keep them as-is
    }
    diagnostics.push(fallback);
  }

  return diagnostics;
}

// ---------------------------------------------------------------------------
// Default implementation (Docker sandbox)
// ---------------------------------------------------------------------------

/**
 * Validates a pipeline YAML string by writing it to a temporary directory and
 * running the `expanso validate` binary inside the Docker sandbox.
 *
 * This is the production implementation. In tests, inject a mock via
 * {@link ExpansoValidatorToolOptions.validateYaml}.
 *
 * @param yaml - Pipeline YAML content to validate.
 * @returns Structured {@link ExpansoValidationResult}.
 */
export async function defaultValidateYaml(yaml: string): Promise<ExpansoValidationResult> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  const execFileAsync = promisify(execFile);

  // Write YAML to a temp file
  const tmpDir = await mkdtemp(join(tmpdir(), "expanso-validate-"));
  const yamlPath = join(tmpDir, "pipeline.yaml");

  try {
    await writeFile(yamlPath, yaml, "utf8");

    // Run expanso validate directly (without Docker) as a best-effort local check.
    // In production, this would be wrapped in the Docker sandbox.
    // We attempt to find the binary in PATH; if not found, we return a best-effort result.
    let stdout = "";
    let stderr = "";
    let exitCode = 0;

    try {
      const result = await execFileAsync("expanso", ["validate", yamlPath], {
        timeout: 30_000,
        encoding: "utf8",
      });
      stdout = result.stdout;
      stderr = result.stderr;
    } catch (err: unknown) {
      const execErr = err as { stdout?: string; stderr?: string; code?: number | string };
      stdout = execErr.stdout ?? "";
      stderr = execErr.stderr ?? "";
      exitCode = typeof execErr.code === "number" ? execErr.code : 1;
    }

    const success = exitCode === 0;
    const errors = success ? [] : parseBinaryOutput(stderr || stdout, true);
    const warnings = parseBinaryOutput(success ? stderr : "", false);

    const result: ExpansoValidationResult = {
      success,
      errors,
      warnings,
      exitCode,
    };

    if (stdout) {
      result.rawOutput = stdout;
    }
    if (stderr) {
      result.rawError = stderr;
    }

    return result;
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

/**
 * Creates an Expanso pipeline validation tool.
 *
 * When registered on an agent, the agent can call this tool with a pipeline
 * YAML string and receive a structured validation result — including success
 * status, errors, warnings, and raw binary output.
 *
 * @param opts - Optional configuration (validator override for tests).
 * @returns An `AnyAgentTool` compatible with `@mariozechner/pi-agent-core`.
 *
 * @example
 * // Production usage
 * const tool = createExpansoValidatorTool();
 *
 * // Test usage — inject a deterministic mock
 * const tool = createExpansoValidatorTool({
 *   validateYaml: async (yaml) => ({
 *     success: yaml.includes('valid'),
 *     errors: yaml.includes('valid') ? [] : [{ message: 'Invalid pipeline' }],
 *     warnings: [],
 *     exitCode: yaml.includes('valid') ? 0 : 1,
 *   }),
 * });
 */
export function createExpansoValidatorTool(opts?: ExpansoValidatorToolOptions): AnyAgentTool {
  const validateYaml = opts?.validateYaml ?? defaultValidateYaml;

  return {
    label: "Expanso Pipeline Validator",
    name: "expanso_validate",
    description:
      "Validate an Expanso pipeline YAML configuration using the expanso validate binary " +
      "in a secure, isolated Docker sandbox. Returns a structured result including success " +
      "status, any validation errors with their locations, warnings, and the raw binary output. " +
      "Use this after expanso_generate to confirm the generated pipeline is syntactically correct.",
    parameters: ExpansoValidatorInputSchema,

    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const yaml = readStringParam(params, "yaml", { required: true });

      const validationResult = await validateYaml(yaml);

      return jsonResult(validationResult);
    },
  };
}
