import { z } from "zod";
import type { TelegramAccountConfig } from "../../config/zod-schema.providers-core.js";
import type { ResolveTelegramAccountResult } from "./telegram.js";

/**
 * Resolves Telegram subagent notification flags from config.
 * Both default to true if not specified.
 */
export function resolveTelegramSubagentNoticeFlags(
  cfg: { channels?: { telegram?: Partial<TelegramAccountConfig> } },
  accountId?: string
): { subagentStartAnnouncements: boolean; modelStatusNotices: boolean } {
  const telegramConfig = cfg.channels?.telegram;
  // For account-level, we'd need resolveTelegramAccount which should be imported
  // For now, use channel-level defaults
  return {
    subagentStartAnnouncements: telegramConfig?.subagentStartAnnouncements ?? true,
    modelStatusNotices: telegramConfig?.modelStatusNotices ?? true
  };
}

/**
 * Builds the Telegram subagent start notice text.
 */
export function buildTelegramSubagentStartNotice(params: {
  label?: string;
  task?: string;
  model?: string;
  includeStart?: boolean;
  includeTask?: boolean;
  includeModel?: boolean;
}): string {
  const lines: string[] = [];
  const label = (params.label || params.task || "subagent").trim();

  if (params.includeStart && label) {
    lines.push(`Subagent started: ${label.slice(0, 120)}`);
  }
  if (params.includeTask && params.task?.trim()) {
    lines.push(`Task: ${params.task.trim().slice(0, 180)}`);
  }
  if (params.includeModel && params.model?.trim()) {
    lines.push(`Selected model: ${params.model.trim()}`);
  }

  return lines.join("\n");
}

/**
 * Builds fallback notice text for Telegram.
 */
export function buildFallbackNotice(params: {
  selectedProvider?: string;
  selectedModel?: string;
  activeProvider?: string;
  activeModel?: string;
}): string | null {
  const selected = params.selectedModel ? `${params.selectedProvider}/${params.selectedModel}` : params.selectedModel;
  const active = params.activeModel ? `${params.activeProvider}/${params.activeModel}` : params.activeModel;

  if (selected === active) return null;
  return `Model fallback: ${active} (selected ${selected})`;
}

/**
 * Builds fallback cleared notice text for Telegram.
 */
export function buildFallbackClearedNotice(params: {
  selectedProvider?: string;
  selectedModel?: string;
  previousActiveModel?: string;
}): string {
  const selected = params.selectedModel ? `${params.selectedProvider}/${params.selectedModel}` : params.selectedModel;
  return `Model fallback cleared: ${selected}`;
}
