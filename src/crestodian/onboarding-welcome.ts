// First-run onboarding welcome: state findings, propose setup, wait for "yes".
import { isSecretRef, normalizeSecretInputString } from "../config/types.secrets.js";
import { resolveUserPath, shortenHomePath } from "../utils.js";
import type { CrestodianChatEngine } from "./chat-engine.js";
import { formatCrestodianOnboardingWelcome } from "./overview.js";

/**
 * The basic bootstrap is conversational: the welcome message carries the plan
 * and the engine holds it as the pending proposal, so a bare "yes" applies it.
 * Providerless installs may then hand off to the shared model/auth wizard.
 * Already-configured installs get the channels/handoff guide instead.
 */
/**
 * "Configured" must match the app onboarding gate (wizard metadata or gateway
 * auth), not just a model: a model-only config would otherwise get the
 * ready-guide welcome while the gate stays locked, stranding the page.
 */
export async function loadAuthoredSetupConfig(params: {
  configExists: boolean;
  configValid: boolean;
}): Promise<{
  authoredConfig?: import("../config/types.openclaw.js").OpenClawConfig;
  hasAuthoredSetup: boolean;
}> {
  const authoredConfig = await (async () => {
    if (!params.configExists || !params.configValid) {
      return undefined;
    }
    try {
      const { readConfigFileSnapshot } = await import("../config/config.js");
      const snapshot = await readConfigFileSnapshot();
      return snapshot.sourceConfig ?? snapshot.config ?? {};
    } catch {
      return undefined;
    }
  })();
  const auth = authoredConfig?.gateway?.auth;
  const hasAuthMode = normalizeSecretInputString(auth?.mode) !== undefined;
  const hasAuthSecret =
    isSecretRef(auth?.token) ||
    normalizeSecretInputString(auth?.token) !== undefined ||
    isSecretRef(auth?.password) ||
    normalizeSecretInputString(auth?.password) !== undefined;
  const hasWizardMetadata =
    authoredConfig?.wizard !== undefined && Object.keys(authoredConfig.wizard).length > 0;
  const hasAuthoredSetup = hasWizardMetadata || hasAuthMode || hasAuthSecret;
  return { ...(authoredConfig ? { authoredConfig } : {}), hasAuthoredSetup };
}

export async function buildOnboardingWelcome(params: {
  engine: CrestodianChatEngine;
  workspace?: string;
}): Promise<string> {
  const overview = await params.engine.loadOverview();
  const { authoredConfig, hasAuthoredSetup } = await loadAuthoredSetupConfig({
    configExists: overview.config.exists,
    configValid: overview.config.valid,
  });
  if (hasAuthoredSetup && overview.defaultModel) {
    const welcome = formatCrestodianOnboardingWelcome(overview);
    params.engine.noteAssistantMessage(welcome);
    return welcome;
  }

  const [{ detectInferenceBackends }, { DEFAULT_WORKSPACE }] = await Promise.all([
    import("../commands/onboard-inference.js"),
    import("../commands/onboard-helpers.js"),
  ]);
  const candidates = await detectInferenceBackends({});
  // Mirror chooseSetupModel: never advertise a definitively logged-out CLI.
  const detected = candidates.find(
    (candidate) => candidate.kind !== "existing-model" && candidate.credentials !== false,
  );
  const workspace = resolveUserPath(
    params.workspace?.trim() ||
      authoredConfig?.agents?.defaults?.workspace?.trim() ||
      DEFAULT_WORKSPACE,
  );

  params.engine.propose({ kind: "setup", workspace });

  const aiLine = detected
    ? `- AI: ${detected.label} — ${detected.modelRef} (${detected.detail}). I'll reuse it; switching later is one sentence.`
    : "- AI: nothing detected yet (no Claude Code or Codex login, no OPENAI_API_KEY/ANTHROPIC_API_KEY). I'll set up the basics first, then ask whether you want to configure a model provider with masked credential prompts.";

  const welcome = [
    "## Hi, I'm Crestodian — let's hatch your agent.",
    "",
    "No menus here: tell me what you want and I'll do the configuring. I looked around this machine:",
    "",
    aiLine,
    `- Workspace: ${shortenHomePath(workspace)}`,
    "- Gateway: runs locally, private to this machine (token auth).",
    "",
    "Say **yes** and I'll set all of that up now.",
    "",
    "Heads up: your agent gets real access to this machine — https://docs.openclaw.ai/security",
    "Afterwards: `connect discord`, `connect slack`, `connect telegram`, `connect whatsapp` (or `channels` for the full list), then `talk to agent` to meet your agent.",
  ].join("\n");
  params.engine.noteAssistantMessage(welcome);
  return welcome;
}
