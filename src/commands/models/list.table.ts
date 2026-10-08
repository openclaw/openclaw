import type { ModelsListResult } from "../../../packages/gateway-protocol/src/schema/model-catalog.js";
import { sanitizeTerminalText } from "../../../packages/terminal-core/src/safe-text.js";
import { colorize, theme } from "../../../packages/terminal-core/src/theme.js";
import { type RuntimeEnv, writeRuntimeJson, writeRuntimeStdout } from "../../runtime.js";
import { formatTag, formatTokenK, isRich, padTerminalCell, truncate } from "./list.format.js";
import type { ModelRow } from "./list.types.js";

const MODEL_PAD = 42;
const INPUT_PAD = 10;
const CTX_PAD = 11;
const STATE_PAD = 5;

function formatContextLabel(row: ModelRow): string {
  if (
    typeof row.contextTokens === "number" &&
    Number.isFinite(row.contextTokens) &&
    row.contextTokens > 0 &&
    row.contextTokens !== row.contextWindow
  ) {
    return `${formatTokenK(row.contextTokens)}/${formatTokenK(row.contextWindow)}`;
  }
  return formatTokenK(row.contextWindow);
}

export function printModelTable(
  rows: ModelRow[],
  runtime: RuntimeEnv,
  opts: { json?: boolean; plain?: boolean } & Pick<ModelsListResult, "providerOutcomes"> = {},
) {
  if (opts.json) {
    const providerOutcomes = opts.providerOutcomes?.map(({ provider, profileId, status }) => ({
      provider,
      ...(profileId ? { profileId } : {}),
      status,
    }));
    writeRuntimeJson(runtime, {
      count: rows.length,
      models: rows,
      ...(providerOutcomes?.length ? { providerOutcomes } : {}),
    });
    return;
  }

  if (opts.plain) {
    for (const row of rows) {
      writeRuntimeStdout(runtime, sanitizeTerminalText(row.key));
    }
    return;
  }

  const rich = isRich(opts);
  const formatRowTag = rich
    ? (tag: string) => formatTag(sanitizeTerminalText(tag))
    : sanitizeTerminalText;
  const formatState = (value: boolean | null, unavailableColor = theme.muted) =>
    colorize(
      rich,
      value === null ? theme.muted : value ? theme.success : unavailableColor,
      padTerminalCell(value === null ? "-" : value ? "yes" : "no", STATE_PAD),
    );
  const header = [
    padTerminalCell("Model", MODEL_PAD),
    padTerminalCell("Input", INPUT_PAD),
    padTerminalCell("Ctx", CTX_PAD),
    padTerminalCell("Local", STATE_PAD),
    padTerminalCell("Auth", STATE_PAD),
    "Tags",
  ].join(" ");
  runtime.log(rich ? theme.heading(header) : header);

  for (const row of rows) {
    const keyLabel = padTerminalCell(truncate(row.key, MODEL_PAD), MODEL_PAD);
    const coloredInput = colorize(
      rich,
      row.input.includes("image") ? theme.accentBright : theme.info,
      padTerminalCell(sanitizeTerminalText(row.input) || "-", INPUT_PAD),
    );

    const line = [
      rich ? theme.accent(keyLabel) : keyLabel,
      coloredInput,
      padTerminalCell(formatContextLabel(row), CTX_PAD),
      formatState(row.local),
      formatState(row.available, theme.error),
      row.tags.map(formatRowTag).join(","),
    ].join(" ");
    runtime.log(line);
  }
}
