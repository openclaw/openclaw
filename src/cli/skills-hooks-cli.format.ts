import { theme } from "../../packages/terminal-core/src/theme.js";
import type { RequirementConfigCheck, Requirements } from "../shared/requirements.js";

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
    satisfied ? theme.success(`✓ ${value}`) : theme.error(`✗ ${value}`);
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
      return `${theme.muted(`  ${label}:`)} ${value}`;
    }),
  ];
}
