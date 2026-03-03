import {
  DEFAULT_BOOTSTRAP_MAX_CHARS,
  resolveBootstrapMaxChars,
  resolveBootstrapTotalMaxChars,
} from "../agents/pi-embedded-helpers/bootstrap.js";
import { loadWorkspaceBootstrapFiles } from "../agents/workspace.js";
import type { OpenClawConfig } from "../config/config.js";
import { note } from "../terminal/note.js";

function formatChars(chars: number): string {
  if (chars >= 1000) {
    return `${(chars / 1000).toFixed(1)}k`;
  }
  return `${chars}`;
}

/**
 * Check workspace bootstrap files against configured size limits.
 * Warns when files will be truncated in the system prompt.
 *
 * @param cfg       The openclaw config (for bootstrap size limits).
 * @param workspaceDir  Resolved workspace directory path. If omitted, the check is skipped.
 */
export async function noteBootstrapFileSize(
  cfg: OpenClawConfig,
  workspaceDir?: string,
): Promise<void> {
  if (!workspaceDir) {
    return;
  }

  let files: Awaited<ReturnType<typeof loadWorkspaceBootstrapFiles>>;
  try {
    files = await loadWorkspaceBootstrapFiles(workspaceDir);
  } catch {
    return; // can't read workspace, skip silently
  }

  const maxChars = resolveBootstrapMaxChars(cfg);
  const totalMaxChars = resolveBootstrapTotalMaxChars(cfg);

  const warnings: string[] = [];
  let totalChars = 0;

  for (const file of files) {
    if (file.missing || !file.content) {
      continue;
    }
    const fileChars = file.content.length;
    totalChars += fileChars;

    if (fileChars > maxChars) {
      const pct = Math.round(((fileChars - maxChars) / fileChars) * 100);
      warnings.push(
        `- ${file.name}: ${formatChars(fileChars)} chars (limit ${formatChars(maxChars)}). ` +
          `~${pct}% will be truncated in system prompt.`,
      );
    }
  }

  if (totalChars > totalMaxChars) {
    const pct = Math.round(((totalChars - totalMaxChars) / totalChars) * 100);
    warnings.push(
      `- Total: ${formatChars(totalChars)} chars across all files (limit ${formatChars(totalMaxChars)}). ` +
        `~${pct}% of content will be lost.`,
    );
  }

  if (warnings.length === 0) {
    return;
  }

  const configHint =
    maxChars === DEFAULT_BOOTSTRAP_MAX_CHARS && totalChars <= totalMaxChars
      ? `\n- Tip: increase per-file limit with agents.defaults.bootstrapMaxChars in config.`
      : totalChars > totalMaxChars
        ? `\n- Tip: increase total limit with agents.defaults.bootstrapTotalMaxChars in config, or trim files.`
        : "";

  note(
    ["Workspace bootstrap files exceed size limits and will be truncated:", ...warnings, configHint]
      .filter(Boolean)
      .join("\n"),
    "Bootstrap file size",
  );
}
