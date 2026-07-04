// First-run onboarding welcome: state findings, propose setup, wait for "yes".
import { resolveUserPath, shortenHomePath } from "../utils.js";
import type { CrestodianChatEngine } from "./chat-engine.js";
import { formatCrestodianOnboardingWelcome } from "./overview.js";

/**
 * Onboarding is a conversation, not a wizard: the welcome message carries the
 * whole plan (detected AI, workspace, gateway defaults, security note) and the
 * engine holds it as the pending proposal, so a bare "yes" applies everything.
 * On an already-configured install the welcome becomes the channels/handoff
 * guide instead of re-proposing setup.
 */
export async function buildOnboardingWelcome(params: {
  engine: CrestodianChatEngine;
  workspace?: string;
}): Promise<string> {
  const overview = await params.engine.loadOverview();
  // "Configured" must match the app onboarding gate (wizard metadata or
  // gateway auth), not just a model: a model-only config would otherwise get
  // the ready-guide welcome while the gate stays locked, stranding the page.
  const hasAuthoredSetup = await (async () => {
    if (!overview.config.exists || !overview.config.valid) {
      return false;
    }
    try {
      const { readConfigFileSnapshot } = await import("../config/config.js");
      const snapshot = await readConfigFileSnapshot();
      const cfg = snapshot.sourceConfig ?? snapshot.config ?? {};
      const auth = cfg.gateway?.auth;
      return (
        Boolean(cfg.wizard && Object.keys(cfg.wizard).length > 0) ||
        Boolean(auth?.mode ?? auth?.token ?? auth?.password)
      );
    } catch {
      return false;
    }
  })();
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
  const workspace = resolveUserPath(params.workspace ?? DEFAULT_WORKSPACE);

  params.engine.propose({ kind: "setup", workspace });

  const aiLine = detected
    ? `- AI: ${detected.label} — ${detected.modelRef} (${detected.detail}). I'll reuse it; switching later is one sentence.`
    : "- AI: nothing detected yet (no Claude Code or Codex login, no OPENAI_API_KEY/ANTHROPIC_API_KEY). I can still set up the basics; add access later and tell me `set default model <provider/model>`.";

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
