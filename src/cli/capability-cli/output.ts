import {
  sanitizeTerminalText,
  terminalText,
} from "../../../packages/terminal-core/src/safe-text.js";
import { writeRuntimeJson, type RuntimeEnv } from "../../runtime.js";
import type { CapabilityEnvelope } from "./metadata.js";

export function emitJsonOrText<T>(
  runtime: RuntimeEnv,
  json: boolean | undefined,
  value: T,
  textFormatter: (value: T) => string,
) {
  if (json) {
    writeRuntimeJson(runtime, value);
    return;
  }
  runtime.log(textFormatter(value));
}

function formatMultilineText(value: string): string {
  return value.split("\n").map(sanitizeTerminalText).join("\n");
}

export function formatEnvelopeForText(envelope: CapabilityEnvelope): string {
  if (!envelope.ok) {
    return terminalText`${envelope.capability} failed: ${envelope.error ?? "unknown error"}`;
  }
  const lines = [
    terminalText`${envelope.capability} via ${envelope.transport}`,
    ...(envelope.provider ? [terminalText`provider: ${envelope.provider}`] : []),
    ...(envelope.model ? [terminalText`model: ${envelope.model}`] : []),
    ...(envelope.ignoredOverrides && envelope.ignoredOverrides.length > 0
      ? [terminalText`ignoredOverrides: ${JSON.stringify(envelope.ignoredOverrides)}`]
      : []),
    `outputs: ${String(envelope.outputs.length)}`,
  ];
  for (const output of envelope.outputs) {
    const pathValue = typeof output.path === "string" ? output.path : undefined;
    const textValue = typeof output.text === "string" ? output.text : undefined;
    if (envelope.capability === "embedding.create" && Array.isArray(output.embedding)) {
      const preview = output.embedding.slice(0, 8).join(", ");
      lines.push(
        formatMultilineText(textValue ?? ""),
        terminalText`dimensions: ${String(output.dimensions)}`,
        terminalText`embedding: [${preview}${output.embedding.length > 8 ? ", ..." : ""}]`,
      );
      continue;
    }
    if (pathValue || textValue) {
      if (pathValue) {
        lines.push(sanitizeTerminalText(pathValue));
      }
      if (textValue) {
        lines.push(formatMultilineText(textValue));
      }
    } else {
      lines.push(sanitizeTerminalText(JSON.stringify(output)));
    }
  }
  return lines.join("\n");
}

export function providerSummaryText(providers: readonly unknown[]): string {
  return (
    providers.map((entry) => sanitizeTerminalText(JSON.stringify(entry) ?? "")).join("\n") ||
    "No results found."
  );
}
