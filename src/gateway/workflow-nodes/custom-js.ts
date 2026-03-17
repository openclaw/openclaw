/**
 * Custom JS Node Handler
 *
 * Executes custom JavaScript code to transform data
 * Uses Node.js vm module for sandboxed execution
 */

import vm from "node:vm";
import type { WorkflowNodeHandler, NodeInput, NodeOutput, ExecutionContext } from "./types.js";

/**
 * Maximum execution time in milliseconds
 */
const MAX_EXECUTION_TIME_MS = 5000;

/**
 * Maximum output length
 */
const MAX_OUTPUT_LENGTH = 100000;

/**
 * Dangerous patterns to block in user code
 */
const DANGEROUS_PATTERNS = [
  /\brequire\s*\(/,
  /\bimport\s+/,
  /\bimport\s*\(/,
  /\bprocess\b/,
  /\bglobal\b/,
  /\bBuffer\b/,
  /\beval\s*\(/,
  /\bFunction\s*\(/,
  /\bconstructor\b/,
  /\b__proto__\b/,
  /\bprototype\b/,
  /\bthis\b\./,
  /window\./,
  /document\./,
  /console\./,
  /\bsetTimeout\b/,
  /\bsetInterval\b/,
  /\bsetImmediate\b/,
  /\bclearTimeout\b/,
  /\bclearInterval\b/,
  /\bclearImmediate\b/,
  /\bfetch\b/,
  /\bXMLHttpRequest\b/,
  /\bWebSocket\b/,
  /\brequire\.main\b/,
  /\bmodule\.exports\b/,
  /\bexports\./,
  /\b__filename\b/,
  /\b__dirname\b/,
];

/**
 * Validate code for dangerous patterns
 */
function validateCode(code: string): { valid: boolean; error?: string } {
  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(code)) {
      return {
        valid: false,
        error: `Code contains forbidden pattern: ${pattern.source}`,
      };
    }
  }

  // Check for infinite loops (simple heuristic)
  if (/while\s*\(\s*true\s*\)/.test(code) || /for\s*\(\s*;\s*;\s*\)/.test(code)) {
    return {
      valid: false,
      error: "Infinite loops are not allowed",
    };
  }

  return { valid: true };
}

/**
 * Execute JavaScript code in a sandbox
 */
function executeInSandbox(
  code: string,
  context: { input: string; variables: Record<string, string> },
): { success: boolean; result?: string; error?: string } {
  try {
    // Create sandbox with limited context
    const sandbox: vm.Context = {
      input: context.input,
      variables: context.variables,
      // Safe helper functions
      String: String,
      Number: Number,
      Boolean: Boolean,
      Array: Array,
      Object: Object,
      Map: Map,
      Set: Set,
      JSON: JSON,
      Math: Math,
      Date: Date,
      RegExp: RegExp,
      // Custom helpers
      includes: (str: string, search: string) => str.includes(search),
      startsWith: (str: string, prefix: string) => str.startsWith(prefix),
      endsWith: (str: string, suffix: string) => str.endsWith(suffix),
      length: (str: string) => str.length,
      upper: (str: string) => str.toUpperCase(),
      lower: (str: string) => str.toLowerCase(),
      trim: (str: string) => str.trim(),
      split: (str: string, separator: string) => str.split(separator),
      join: (arr: unknown[], separator: string) => arr.join(separator),
      parseInt,
      parseFloat,
      isNaN,
      isFinite,
      // Output capture
      _result: undefined as unknown,
    };

    // Wrap code to capture return value
    const wrappedCode = `
      "use strict";
      try {
        ${code}
      } catch (e) {
        throw e;
      }
    `;

    // Compile and run with timeout
    const script = new vm.Script(wrappedCode, {
      filename: "workflow-custom-js",
      lineOffset: -2,
    });

    const contextObj = vm.createContext(sandbox);
    script.runInContext(contextObj, { timeout: MAX_EXECUTION_TIME_MS });

    // Get result (either explicit _result or last expression)
    let result = sandbox._result as unknown;

    // Convert to string
    if (result === undefined) {
      result = "";
    } else if (typeof result !== "string") {
      try {
        result = JSON.stringify(result);
      } catch {
        result = String(result);
      }
    }

    const resultStr = result as string;

    // Limit output length
    let output = resultStr;
    if (output.length > MAX_OUTPUT_LENGTH) {
      output = output.substring(0, MAX_OUTPUT_LENGTH) + "... [truncated]";
    }

    return { success: true, result: output };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      error: `Execution failed: ${message}`,
    };
  }
}

export const customJSHandler: WorkflowNodeHandler = {
  actionType: "custom-js",

  async execute(input: NodeInput, _context: ExecutionContext): Promise<NodeOutput> {
    const { nodeId, label, config } = input;

    try {
      const code = config.code;

      if (!code) {
        return {
          status: "error",
          error: "Custom JS node missing code configuration",
          metadata: { nodeId, label },
        };
      }

      // Validate code
      const validation = validateCode(code);
      if (!validation.valid) {
        return {
          status: "error",
          error: validation.error,
          metadata: {
            nodeId,
            label,
            codeLength: code.length,
            validationFailed: true,
          },
        };
      }

      // Execute in sandbox
      const result = executeInSandbox(code, {
        input: _context.currentInput,
        variables: Object.fromEntries(_context.variables),
      });

      if (!result.success) {
        return {
          status: "error",
          error: result.error,
          metadata: {
            nodeId,
            label,
            codeLength: code.length,
            executionFailed: true,
          },
        };
      }

      return {
        status: "success",
        output: result.result || "",
        metadata: {
          nodeId,
          label,
          codeLength: code.length,
          outputLength: (result.result || "").length,
          executed: true,
        },
      };
    } catch (error) {
      return {
        status: "error",
        error: error instanceof Error ? error.message : String(error),
        metadata: {
          nodeId,
          label,
          actionType: "custom-js",
        },
      };
    }
  },
};
