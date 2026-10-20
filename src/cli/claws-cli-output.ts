import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import type { ClawAddPlan, ClawDiagnostic } from "../claws/types.js";
import { redactSensitiveText } from "../logging/redact.js";
import { defaultRuntime as runtime, writeRuntimeJson } from "../runtime.js";

export function emitClawFailure(
  json: boolean | undefined,
  message: string,
  payload: unknown,
): void {
  if (json) {
    writeRuntimeJson(runtime, payload);
  } else {
    runtime.error(message);
  }
  runtime.exit(1);
}

export function formatClawDiagnostics(diagnostics: readonly ClawDiagnostic[]): string {
  return diagnostics
    .map((diagnostic) =>
      sanitizeTerminalText(
        `${diagnostic.level.toUpperCase()} ${diagnostic.code} ${diagnostic.path}: ${diagnostic.message}`,
      ),
    )
    .join("\n");
}

function logClawPlanNotices(diagnostics: ClawDiagnostic[]): void {
  for (const diagnostic of diagnostics.filter((entry) => entry.level === "warning")) {
    runtime.log(redactSensitiveText(`Notice: ${diagnostic.message}`));
  }
}

export function logClawAgentConfiguration(plan: ClawAddPlan): void {
  logClawPlanNotices(plan.diagnostics);
}
