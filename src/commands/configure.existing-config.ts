// Existing-config gate for the configure wizard: summarize usable config, explain unusable config.
import { note } from "../../packages/terminal-core/src/note.js";
import { formatCliCommand } from "../cli/command-format.js";
import { formatConfigReadFailure } from "../config/io.invalid-config.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../config/types.openclaw.js";
import { outro } from "./configure.shared.js";
import { summarizeExistingConfig } from "./onboard-helpers.js";

/** Notes an existing config; returns false after explaining why configure cannot use it. */
export function noteExistingConfig(
  snapshot: ConfigFileSnapshot,
  baseConfig: OpenClawConfig,
): boolean {
  const readFailure = formatConfigReadFailure(snapshot);
  if (readFailure) {
    outro(readFailure);
    return false;
  }
  const title = snapshot.valid ? "Existing config detected" : "Invalid config";
  note(summarizeExistingConfig(baseConfig), title);
  if (snapshot.valid) {
    return true;
  }
  if (snapshot.issues.length > 0) {
    note(
      [
        ...snapshot.issues.map((iss) => `- ${iss.path}: ${iss.message}`),
        "",
        "Docs: https://docs.openclaw.ai/gateway/configuration",
      ].join("\n"),
      "Config issues",
    );
  }
  outro(
    `Config invalid. Run \`${formatCliCommand("openclaw doctor --fix")}\` to apply supported repairs, then re-run configure.`,
  );
  return false;
}
