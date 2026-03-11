import fs from "node:fs";
import path from "node:path";
import { DEFAULT_AGENTS_FILENAME } from "../agents/workspace.js";
import type { OpenClawConfig } from "../config/config.js";
import { shortenHomePath } from "../utils.js";

export type SoulFileDiagnostic = {
  channel: string;
  accountId: string;
  configuredSoulFile: string;
  exists: boolean;
  readable: boolean;
  error?: string;
};

export type SoulFilesDiagnosis = {
  diagnostics: SoulFileDiagnostic[];
  hasIssues: boolean;
  summary: string;
};

/**
 * Diagnose SOUL file configuration for all channels.
 */
export async function diagnoseSoulFiles(params: {
  workspaceDir: string;
  config: OpenClawConfig;
}): Promise<SoulFilesDiagnosis> {
  const { workspaceDir, config } = params;
  const diagnostics: SoulFileDiagnostic[] = [];
  const validChannels = [
    "telegram",
    "discord",
    "slack",
    "whatsapp",
    "signal",
    "imessage",
    "matrix",
    "googlechat",
    "line",
    "msteams",
    "irc",
  ];

  for (const channel of validChannels) {
    const channelConfig = config.channels?.[channel as keyof typeof config.channels] as
      | { accounts?: Record<string, { soulFile?: string }> }
      | undefined;

    if (!channelConfig?.accounts) {
      continue;
    }

    for (const [accountId, account] of Object.entries(channelConfig.accounts)) {
      const soulFile = account?.soulFile;
      if (!soulFile?.trim()) {
        continue;
      }

      const soulPath = path.join(workspaceDir, soulFile);
      let exists = false;
      let readable = false;
      let error: string | undefined;

      try {
        await fs.promises.access(soulPath, fs.constants.F_OK);
        exists = true;
        try {
          await fs.promises.access(soulPath, fs.constants.R_OK);
          readable = true;
        } catch {
          error = "Permission denied";
        }
      } catch {
        error = "File not found";
      }

      diagnostics.push({
        channel,
        accountId,
        configuredSoulFile: soulFile,
        exists,
        readable,
        error,
      });
    }
  }

  const hasIssues = diagnostics.some((d) => !d.exists || !d.readable);
  const issues = diagnostics.filter((d) => !d.exists || !d.readable);
  const ok = diagnostics.filter((d) => d.exists && d.readable);

  let summary = "";
  if (diagnostics.length === 0) {
    summary = "No channel-specific SOUL files configured.";
  } else if (hasIssues) {
    summary = `${issues.length} SOUL file(s) have issues, ${ok.length} OK.`;
  } else {
    summary = `All ${diagnostics.length} SOUL file(s) OK.`;
  }

  return { diagnostics, hasIssues, summary };
}

export function formatSoulFileDiagnosis(diagnosis: SoulFilesDiagnosis): string {
  const lines: string[] = ["SOUL File Diagnostics:", ""];

  if (diagnosis.diagnostics.length === 0) {
    lines.push("No channel-specific SOUL files configured.");
    lines.push("Use --soul option when adding channels or run: openclaw onboard");
    return lines.join("\n");
  }

  for (const diagnostic of diagnosis.diagnostics) {
    const status = diagnostic.exists ? (diagnostic.readable ? "✅" : "⚠️") : "❌";
    const label = `${diagnostic.channel}:${diagnostic.accountId}`;
    const fileInfo = diagnostic.exists
      ? diagnostic.readable
        ? "OK"
        : "Permission denied"
      : "Not found";
    lines.push(`${status} ${label} → ${diagnostic.configuredSoulFile} (${fileInfo})`);

    if (!diagnostic.exists) {
      lines.push(`   Fix: Create ${diagnostic.configuredSoulFile} or remove soulFile from config`);
    } else if (!diagnostic.readable) {
      lines.push(`   Fix: chmod 644 ${diagnostic.configuredSoulFile}`);
    }
  }

  lines.push("");
  lines.push(diagnosis.summary);

  return lines.join("\n");
}

export const MEMORY_SYSTEM_PROMPT = [
  "Memory system not found in workspace.",
  "Paste this into your agent:",
  "",
  "Install the memory system by applying:",
  "https://github.com/openclaw/openclaw/commit/9ffea23f31ca1df5183b25668f8f814bee0fb34e",
  "https://github.com/openclaw/openclaw/commit/7d1fee70e76f2f634f1b41fca927ee663914183a",
].join("\n");

export async function shouldSuggestMemorySystem(workspaceDir: string): Promise<boolean> {
  const memoryPaths = [path.join(workspaceDir, "MEMORY.md"), path.join(workspaceDir, "memory.md")];

  for (const memoryPath of memoryPaths) {
    try {
      await fs.promises.access(memoryPath);
      return false;
    } catch {
      // keep scanning
    }
  }

  const agentsPath = path.join(workspaceDir, DEFAULT_AGENTS_FILENAME);
  try {
    const content = await fs.promises.readFile(agentsPath, "utf-8");
    if (/memory\.md/i.test(content)) {
      return false;
    }
  } catch {
    // no AGENTS.md or unreadable; treat as missing memory guidance
  }

  return true;
}

export type LegacyWorkspaceDetection = {
  activeWorkspace: string;
  legacyDirs: string[];
};

export function detectLegacyWorkspaceDirs(params: {
  workspaceDir: string;
}): LegacyWorkspaceDetection {
  const activeWorkspace = path.resolve(params.workspaceDir);
  const legacyDirs: string[] = [];
  return { activeWorkspace, legacyDirs };
}

export function formatLegacyWorkspaceWarning(detection: LegacyWorkspaceDetection): string {
  return [
    "Extra workspace directories detected (may contain old agent files):",
    ...detection.legacyDirs.map((dir) => `- ${shortenHomePath(dir)}`),
    `Active workspace: ${shortenHomePath(detection.activeWorkspace)}`,
    "If unused, archive or move to Trash.",
  ].join("\n");
}
