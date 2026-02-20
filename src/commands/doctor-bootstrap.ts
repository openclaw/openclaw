import type { OpenClawConfig } from "../config/config.js";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import {
  buildBootstrapContextFiles,
  resolveBootstrapMaxChars,
  resolveBootstrapTotalMaxChars,
} from "../agents/pi-embedded-helpers.js";
import { loadWorkspaceBootstrapFiles } from "../agents/workspace.js";
import { note } from "../terminal/note.js";

export async function noteBootstrapFileHealth(cfg: OpenClawConfig): Promise<void> {
  const workspaceDir = resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg));
  const bootstrapFiles = await loadWorkspaceBootstrapFiles(workspaceDir);

  const presentFiles = bootstrapFiles.filter((f) => !f.missing && f.content);
  if (presentFiles.length === 0) {
    return;
  }

  const maxChars = resolveBootstrapMaxChars(cfg);
  const totalMaxChars = resolveBootstrapTotalMaxChars(cfg);

  const buildResult = buildBootstrapContextFiles(bootstrapFiles, {
    maxChars,
    totalMaxChars,
  });

  const injectedByName = new Map(
    buildResult.files.map((f) => {
      const baseName = f.path.replace(/\\/g, "/").split("/").pop() ?? f.path;
      return [baseName, f.content.length];
    }),
  );
  const truncatedNames = new Set(buildResult.truncations.map((t) => t.name));

  const lines: string[] = [];
  let hasIssue = false;

  let cumulativeUsage = 0;

  for (const file of presentFiles) {
    const rawChars = (file.content ?? "").trimEnd().length;
    const injectedSize = injectedByName.get(file.name) ?? 0;
    cumulativeUsage += injectedSize;

    const isTruncated = truncatedNames.has(file.name);

    if (isTruncated) {
      const truncInfo = buildResult.truncations.find((t) => t.name === file.name);
      const budgetChars = truncInfo?.budgetChars ?? maxChars;
      if (budgetChars === 0) {
        lines.push(
          `✗ ${file.name}: ${rawChars} chars — SKIPPED (budget exhausted by higher-priority files)`,
        );
      } else {
        lines.push(`✗ ${file.name}: ${rawChars} / ${budgetChars} chars — TRUNCATED`);
      }
      hasIssue = true;
    } else {
      const pct = rawChars > 0 ? Math.round((rawChars / maxChars) * 100) : 0;
      const totalPct = Math.round((cumulativeUsage / totalMaxChars) * 100);
      const usageInfo = `(${pct}%) [Total used: ${totalPct}%]`;

      if (pct >= 90 || totalPct >= 90) {
        lines.push(`⚠ ${file.name}: ${rawChars} / ${maxChars} chars ${usageInfo} — near limit!`);
        hasIssue = true;
      } else {
        lines.push(`✓ ${file.name}: ${rawChars} / ${maxChars} chars ${usageInfo}`);
      }
    }
  }

  if (hasIssue) {
    lines.push("");
    lines.push(
      "Tip: move large content to docs/ or reference files, or increase agents.defaults.bootstrapMaxChars.",
    );
  }

  note(`Total budget: ${totalMaxChars} chars\n${lines.join("\n")}`, "Bootstrap files");
}
