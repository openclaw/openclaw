import { collectConfigEnvVars } from "../../config/env-vars.js";
import { logVerbose } from "../../globals.js";
import { formatUsageReportLines, loadProviderUsageSummary } from "../../infra/provider-usage.js";
import { usageProviders } from "../../infra/provider-usage.shared.js";
import type { CommandHandler } from "./commands-types.js";

// Providers to exclude from /quota output
const QUOTA_EXCLUDED_PROVIDERS = new Set(["google-gemini-cli"]);

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
    // Filter out excluded providers (e.g., Gemini) from quota output
    const providers = usageProviders.filter((p) => !QUOTA_EXCLUDED_PROVIDERS.has(p));
    const summary = await loadProviderUsageSummary({
      timeoutMs: 5000,
      claudeWebSessionKey,
      providers,
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
