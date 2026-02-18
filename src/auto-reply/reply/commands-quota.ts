import { collectConfigEnvVars } from "../../config/env-vars.js";
import { logVerbose } from "../../globals.js";
import { formatUsageReportLines, loadProviderUsageSummary } from "../../infra/provider-usage.js";
import type { CommandHandler } from "./commands-types.js";

export const handleQuotaCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  const normalized = params.command.commandBodyNormalized;
  if (normalized !== "/quota" && !normalized.startsWith("/quota ")) {
    return null;
  }
  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring /quota from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }

  let text: string;
  try {
    const claudeWebSessionKey = collectConfigEnvVars(params.cfg).CLAUDE_AI_SESSION_KEY;
    const summary = await loadProviderUsageSummary({
      timeoutMs: 5000,
      claudeWebSessionKey,
    });
    const lines = formatUsageReportLines(summary, { now: Date.now() });
    text = lines.join("\n");
  } catch (err) {
    text = `Usage: error fetching quota — ${String(err)}`;
  }

  return {
    shouldContinue: false,
    reply: { text },
  };
};
