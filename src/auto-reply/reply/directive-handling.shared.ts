import type { ElevatedLevel, ReasoningLevel } from "./directives.js";
import { formatCliCommand } from "../../cli/command-format.js";
import { t } from "../../i18n/index.js";

export const SYSTEM_MARK = "⚙️";

export const formatDirectiveAck = (text: string): string => {
  if (!text) {
    return text;
  }
  if (text.startsWith(SYSTEM_MARK)) {
    return text;
  }
  return `${SYSTEM_MARK} ${text}`;
};

export const formatOptionsLine = (options: string) => `Options: ${options}.`;
export const withOptions = (line: string, options: string) =>
  `${line}\n${formatOptionsLine(options)}`;

export const formatElevatedRuntimeHint = () =>
  `${SYSTEM_MARK} Runtime is direct; sandboxing does not apply.`;

export const formatElevatedEvent = (level: ElevatedLevel) => {
  if (level === "full") {
    return t("system.elevated_full");
  }
  if (level === "ask" || level === "on") {
    return t("system.elevated_ask");
  }
  return t("system.elevated_off");
};

export const formatReasoningEvent = (level: ReasoningLevel) => {
  if (level === "stream") {
    return t("system.reasoning_stream");
  }
  if (level === "on") {
    return t("system.reasoning_on");
  }
  return t("system.reasoning_off");
};

export function formatElevatedUnavailableText(params: {
  runtimeSandboxed: boolean;
  failures?: Array<{ gate: string; key: string }>;
  sessionKey?: string;
}): string {
  const lines: string[] = [];
  lines.push(
    `elevated is not available right now (runtime=${params.runtimeSandboxed ? "sandboxed" : "direct"}).`,
  );
  const failures = params.failures ?? [];
  if (failures.length > 0) {
    lines.push(`Failing gates: ${failures.map((f) => `${f.gate} (${f.key})`).join(", ")}`);
  } else {
    lines.push(
      "Fix-it keys: tools.elevated.enabled, tools.elevated.allowFrom.<provider>, agents.list[].tools.elevated.*",
    );
  }
  if (params.sessionKey) {
    lines.push(
      `See: ${formatCliCommand(`openclaw sandbox explain --session ${params.sessionKey}`)}`,
    );
  }
  return lines.join("\n");
}
