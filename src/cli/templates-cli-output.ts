import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import { redactSensitiveText } from "../logging/redact.js";
import { defaultRuntime as runtime, writeRuntimeJson } from "../runtime.js";
import type { TemplateAddPlan, TemplateDiagnostic } from "../templates/types.js";

export function emitTemplateFailure(
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

export function formatTemplateDiagnostics(diagnostics: readonly TemplateDiagnostic[]): string {
  return diagnostics
    .map((diagnostic) =>
      sanitizeTerminalText(
        `${diagnostic.level.toUpperCase()} ${diagnostic.code} ${diagnostic.path}: ${diagnostic.message}`,
      ),
    )
    .join("\n");
}

export function logTemplateAgentConfiguration(plan: TemplateAddPlan): void {
  for (const diagnostic of plan.diagnostics.filter((entry) => entry.level === "warning")) {
    runtime.log(redactSensitiveText(`Notice: ${diagnostic.message}`));
  }
}
