import { stripAnsi } from "../../packages/terminal-core/src/ansi.js";
import { terminalText } from "../../packages/terminal-core/src/safe-text.js";
import {
  getTerminalTableWidth,
  renderTable,
  type TableColumn,
} from "../../packages/terminal-core/src/table.js";
import { theme } from "../../packages/terminal-core/src/theme.js";
import type { RequirementConfigCheck, Requirements } from "../shared/requirements.js";

const REMAINING_ESC_SEQUENCE_REGEX = new RegExp(
  String.raw`\u001b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])`,
  "g",
);
const UNSAFE_CONTROL_CHAR_REGEX = new RegExp(
  String.raw`[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]`,
  "g",
);

/** Keep description whitespace while removing terminal controls, including stray escapes. */
export function sanitizeCliDescriptorText(value: string): string {
  return stripAnsi(value)
    .replace(REMAINING_ESC_SEQUENCE_REGEX, "")
    .replace(UNSAFE_CONTROL_CHAR_REGEX, "");
}

export function formatCliStatusTable(params: {
  title: string;
  ready: number;
  rows: Record<string, string>[];
  nameColumn: TableColumn;
  sourceColumn: TableColumn;
  verbose?: boolean;
}): string {
  const columns = [
    { key: "Status", header: "Status", minWidth: 10 },
    params.nameColumn,
    { key: "Description", header: "Description", minWidth: 24, flex: true },
    params.sourceColumn,
  ];
  if (params.verbose) {
    columns.push({ key: "Missing", header: "Missing", minWidth: 18, flex: true });
  }
  return [
    `${theme.heading(terminalText`${params.title}`)} ${theme.muted(`(${params.ready}/${params.rows.length} ready)`)}`,
    renderTable({ width: getTerminalTableWidth(), columns, rows: params.rows }).trimEnd(),
  ].join("\n");
}

export function formatCliRequirements(
  status: { requirements: Requirements; missing: Requirements },
  groups: readonly (readonly [keyof Requirements, string])[],
  configChecks?: readonly RequirementConfigCheck[],
): string[] {
  const populated = groups.filter(([key]) => status.requirements[key].length > 0);
  if (populated.length === 0) {
    return [];
  }
  const formatStatus = (value: string, satisfied: boolean) =>
    satisfied ? theme.success(terminalText`✓ ${value}`) : theme.error(terminalText`✗ ${value}`);
  return [
    "",
    theme.heading("Requirements:"),
    ...populated.map(([key, label]) => {
      const required = status.requirements[key];
      const missing = status.missing[key];
      let value: string;
      if (key === "anyBins" || key === "os") {
        // Missing arrays describe the whole alternative group, not individual availability.
        const prefix = key === "anyBins" ? "any of: " : "";
        value = formatStatus(`(${prefix}${required.join(", ")})`, missing.length === 0);
      } else if (key === "config" && configChecks) {
        value = configChecks.map((check) => formatStatus(check.path, check.satisfied)).join(", ");
      } else {
        value = required.map((entry) => formatStatus(entry, !missing.includes(entry))).join(", ");
      }
      return `${theme.muted(terminalText`  ${label}:`)} ${value}`;
    }),
  ];
}
