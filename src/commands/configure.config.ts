import { note } from "../../packages/terminal-core/src/note.js";
import { formatCliCommand } from "../cli/command-format.js";
import { formatConfigReadFailureForCli } from "../cli/config-validation-output.js";
import type { ConfigFileSnapshot } from "../config/types.openclaw.js";
import type { RuntimeEnv } from "../runtime.js";
import { outro } from "./configure.shared.js";
import { summarizeExistingConfig } from "./onboard-helpers.js";

/** Report the prepared configuration before configure offers any changes. */
export function checkConfigureConfigSnapshot(
  snapshot: ConfigFileSnapshot,
  runtime: RuntimeEnv,
): boolean {
  const readFailure = formatConfigReadFailureForCli(snapshot);
  if (readFailure) {
    outro(readFailure);
    runtime.exit(1);
    return false;
  }
  if (!snapshot.exists) {
    return true;
  }
  const config = snapshot.valid ? (snapshot.sourceConfig ?? snapshot.config) : {};
  note(
    summarizeExistingConfig(config),
    snapshot.valid ? "Existing config detected" : "Invalid config",
  );
  if (!snapshot.valid && snapshot.issues.length > 0) {
    note(
      [
        ...snapshot.issues.map((iss) => `- ${iss.path}: ${iss.message}`),
        "",
        "Docs: https://docs.openclaw.ai/gateway/configuration",
      ].join("\n"),
      "Config issues",
    );
  }
  if (!snapshot.valid) {
    outro(
      `Config invalid. Run \`${formatCliCommand("openclaw doctor --fix")}\` to apply supported repairs, then re-run configure.`,
    );
    runtime.exit(1);
    return false;
  }
  return true;
}
