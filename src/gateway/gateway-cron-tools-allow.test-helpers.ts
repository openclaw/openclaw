import type { ToolCall, ToolResultMessage } from "../llm/types.js";

function toolLabel(name: string): string {
  return ["read", "exec", "wait"].includes(name) ? name : "other";
}

function errorCategory(text: string): string {
  if (/ReferenceError/i.test(text)) {
    return "reference-error";
  }
  if (/TypeError/i.test(text)) {
    return "type-error";
  }
  if (/SyntaxError/i.test(text)) {
    return "syntax-error";
  }
  if (/unknown tool|tool not found|no such tool|tool.*not available/i.test(text)) {
    return "unknown-tool";
  }
  if (/permission denied|not allowed|access denied/i.test(text)) {
    return "permission-error";
  }
  return "unclassified";
}

/** Diagnostic only: outer wrapper arguments are never evidence of a nested tool execution. */
export function summarizeCronToolProbe(params: {
  calls: ToolCall[];
  results: ToolResultMessage[];
  assistantText: string;
  marker: string;
}): string {
  const { calls, results, assistantText, marker } = params;
  // Ordinals preserve call/result correlation without emitting provider IDs, paths, or content.
  return JSON.stringify({
    calls: calls.map((call, index) => ({
      call: index,
      tool: toolLabel(call.name),
      argumentShape:
        call.name !== "exec"
          ? "not-exec"
          : typeof call.arguments.code === "string"
            ? "code-wrapper"
            : typeof call.arguments.command === "string"
              ? "command"
              : "other",
      matchingResults: results.flatMap((result, resultIndex) =>
        result.toolCallId === call.id ? [resultIndex] : [],
      ),
    })),
    results: results.map((result, index) => ({
      result: index,
      tool: toolLabel(result.toolName),
      matchingCalls: calls.flatMap((call, callIndex) =>
        call.id === result.toolCallId ? [callIndex] : [],
      ),
      nameMatchesCall: calls.some(
        (call) => call.id === result.toolCallId && call.name === result.toolName,
      ),
      isError: result.isError,
      markerPresent: JSON.stringify(result.content).includes(marker),
      category: errorCategory(
        result.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n"),
      ),
    })),
    assistantMarkerPresent: assistantText.includes(marker),
    assistantNoTools: assistantText.trim() === "NO_TOOLS",
  });
}
