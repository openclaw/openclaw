import {
  checkCliBackendAvailability,
  type CliBackendAvailability,
} from "../agents/cli-backend-availability.js";
import { isCliProvider } from "../agents/model-selection.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveAgentModelPrimaryValue } from "../config/model-input.js";
import { note } from "../terminal/note.js";

/**
 * If the configured default model uses a CLI provider, check binary + credentials
 * availability and surface warnings via `note()`.
 */
export async function noteCliBackendHealth(cfg: OpenClawConfig): Promise<void> {
  const primaryModel = resolveAgentModelPrimaryValue(cfg.agents?.defaults?.model) ?? "";
  const slashIdx = primaryModel.indexOf("/");
  if (slashIdx < 1) {
    return;
  }
  const provider = primaryModel.slice(0, slashIdx);
  if (!isCliProvider(provider, cfg)) {
    return;
  }

  // Only check the two well-known CLI backends.
  if (provider !== "claude-cli" && provider !== "codex-cli") {
    return;
  }

  const availability = await checkCliBackendAvailability(provider);
  const warnings = formatCliBackendWarnings(availability);
  if (warnings.length > 0) {
    note(warnings.join("\n"), "CLI backend");
  }
}

function formatCliBackendWarnings(availability: CliBackendAvailability): string[] {
  const warnings: string[] = [];
  if (!availability.binaryFound) {
    warnings.push(
      `${availability.binaryName} binary not found in PATH. Install it or update your PATH.`,
    );
  }
  if (!availability.credentialsFound) {
    warnings.push(
      `Credentials not found at ${availability.credentialsPath}. Run ${availability.binaryName} auth or login first.`,
    );
  }
  return warnings;
}
