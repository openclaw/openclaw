/**
 * Code Execution tool: allows agents to run code snippets in sandboxed environments.
 *
 * Exposes the sandbox executor as an agent-callable tool. The agent can:
 * - Run Python for data analysis, scripting, math
 * - Run JavaScript/TypeScript for web APIs, Node.js tasks
 * - Run shell commands for system operations
 */

import { Type } from "@sinclair/typebox";
import { executeCode, formatExecutionResult } from "../../sandbox/executor.js";
import { stringEnum } from "../schema/typebox.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";

const SUPPORTED_LANGUAGES = ["python", "javascript", "typescript", "shell", "bash"] as const;

const CodeExecSchema = Type.Object({
  /** Language to run the code in */
  language: stringEnum(SUPPORTED_LANGUAGES),
  /** The code to execute */
  code: Type.String(),
  /** Execution timeout in seconds (default: 30, max: 120) */
  timeoutSecs: Type.Optional(Type.Number({ minimum: 1, maximum: 120 })),
});

export function createCodeExecTool(): AnyAgentTool {
  return {
    label: "Code Execution",
    name: "code_exec",
    description:
      "Execute code snippets in a sandboxed environment. " +
      "Supports Python (data analysis, scripting), JavaScript/TypeScript (Node.js), and shell (bash). " +
      "Each execution runs in an isolated temp directory and is cleaned up after completion. " +
      "Returns stdout, stderr, exit code, and execution duration.",
    parameters: CodeExecSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const language = readStringParam(params, "language", { required: true }) as
        | "python"
        | "javascript"
        | "typescript"
        | "shell"
        | "bash";
      const code = readStringParam(params, "code", { required: true });
      const timeoutSecsRaw =
        typeof params.timeoutSecs === "number" ? params.timeoutSecs : 30;
      const timeoutMs = Math.min(120, Math.max(1, timeoutSecsRaw)) * 1000;

      if (!code.trim()) {
        return jsonResult({ status: "error", error: "Code cannot be empty." });
      }

      const result = await executeCode(code, language, { timeoutMs });

      return jsonResult({
        status: result.success ? "ok" : "error",
        language: result.language,
        exit_code: result.exitCode,
        timed_out: result.timedOut,
        duration_ms: result.durationMs,
        stdout: result.stdout,
        stderr: result.stderr,
        formatted: formatExecutionResult(result),
      });
    },
  };
}
