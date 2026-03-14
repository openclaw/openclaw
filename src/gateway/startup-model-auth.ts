import { resolveAgentDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../agents/defaults.js";
import { resolveApiKeyForProvider } from "../agents/model-auth.js";
import { isCliProvider, resolveConfiguredModelRef } from "../agents/model-selection.js";
import { formatCliCommand } from "../cli/command-format.js";
import type { OpenClawConfig } from "../config/config.js";

export async function ensureGatewayModelAuthConfigured(params: {
  cfg: OpenClawConfig;
}): Promise<void> {
  const modelRef = resolveConfiguredModelRef({
    cfg: params.cfg,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
  });

  if (isCliProvider(modelRef.provider, params.cfg)) {
    return;
  }

  const defaultAgentId = resolveDefaultAgentId(params.cfg);
  const agentDir = resolveAgentDir(params.cfg, defaultAgentId);
  try {
    await resolveApiKeyForProvider({
      provider: modelRef.provider,
      cfg: params.cfg,
      agentDir,
    });
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    const configuredModelRef = `${modelRef.provider}/${modelRef.model}`;
    throw new Error(
      [
        `Gateway startup blocked: configured model "${configuredModelRef}" has no provider credentials.`,
        `Run ${formatCliCommand("openclaw configure")} for this profile,`,
        `or switch models with ${formatCliCommand('openclaw models set "<provider>/<model>"')}.`,
        `Details: ${details}`,
      ].join(" "),
    );
  }
}

