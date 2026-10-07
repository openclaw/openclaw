// First-run onboarding welcome: state findings, propose setup, wait for "yes".
import type { SystemAgentChatQuestion } from "../../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isSecretRef, normalizeSecretInputString } from "../config/types.secrets.js";
import { resolveUserPath, shortenHomePath } from "../utils.js";
import {
  createSetupTranslator,
  resolveWizardLocale,
  type SetupTranslator,
} from "../wizard/i18n/index.js";
import type { SystemAgentChatEngine } from "./chat-engine.js";
import { formatSystemAgentOnboardingWelcome } from "./overview.js";

/**
 * Card-client questions for the two welcome variants. Replies are texts the
 * engine already understands; the prose welcome always stands alone for
 * text-only clients (macOS app, TUI).
 */
function readyWelcomeQuestion(translate: SetupTranslator): SystemAgentChatQuestion {
  return {
    id: "onboarding-next-step",
    header: translate("nextStep"),
    question: translate("firstAction"),
    options: [
      {
        label: translate("talkToAgent"),
        reply: "talk to agent",
        recommended: true,
        description: translate("meetAgent"),
      },
      { label: translate("connectWhatsApp"), reply: "connect whatsapp" },
      { label: translate("connectTelegram"), reply: "connect telegram" },
      { label: translate("allChannels"), reply: "channels" },
    ],
    isOther: true,
    skipAction: "exit",
  };
}

function setupWelcomeQuestion(translate: SetupTranslator): SystemAgentChatQuestion {
  return {
    id: "onboarding-apply-setup",
    header: translate("readyWhenYouAre"),
    question: translate("applyQuestion"),
    options: [
      { label: translate("applyYes"), reply: "yes", recommended: true },
      {
        label: translate("inspectChanges"),
        reply: "what exactly will you set up?",
        description: translate("askBeforeWriting"),
      },
    ],
    isOther: true,
  };
}

/**
 * The basic bootstrap is conversational: the welcome message carries the plan
 * and the engine holds it as the pending proposal, so a bare "yes" applies it.
 * This path starts only after a live inference turn. Already-configured
 * installs get the channels/handoff guide instead.
 */
/**
 * "Configured" must match the app onboarding gate (wizard metadata or gateway
 * auth), not just a model: a model-only config would otherwise get the
 * ready-guide welcome while the gate stays locked, stranding the page.
 */
async function loadAuthoredSetupConfig(params: { configExists: boolean; configValid: boolean }) {
  let authoredConfig: OpenClawConfig | undefined;
  if (params.configExists && params.configValid) {
    try {
      const { readConfigFileSnapshot } = await import("../config/config.js");
      const snapshot = await readConfigFileSnapshot();
      authoredConfig = snapshot.sourceConfig ?? snapshot.config ?? {};
    } catch {
      // An unreadable config must keep onboarding available.
    }
  }
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
  engine: SystemAgentChatEngine;
  workspace?: string;
  agentName?: string;
  locale?: string;
  /** Only the local terminal can finish the machine-owned Gateway installation. */
  localRecovery?: true;
}) {
  const translate = createSetupTranslator({
    keyPrefix: "wizard.onboardingWelcome",
    locale: params.locale === undefined ? undefined : resolveWizardLocale(params.locale),
  });
  const overview = await params.engine.loadOverview();
  const { authoredConfig, hasAuthoredSetup } = await loadAuthoredSetupConfig({
    configExists: overview.config.exists,
    configValid: overview.config.valid,
  });
  const localSetup =
    params.localRecovery === true &&
    overview.config.exists &&
    overview.config.valid &&
    authoredConfig !== undefined &&
    authoredConfig?.gateway?.mode !== "remote"
      ? (await import("../state/local-onboarding-state.js")).readLocalOnboardingStateForConfig(
          overview.config.path,
          authoredConfig,
        )
      : undefined;
  const pendingSetup = localSetup?.status === "pending" ? localSetup : undefined;
  const setupModel = (overview.defaultModel ?? overview.setupModel)?.trim();
  const requestedWorkspace = params.workspace?.trim()
    ? resolveUserPath(params.workspace.trim())
    : undefined;
  const authoredWorkspace = authoredConfig?.agents?.defaults?.workspace?.trim()
    ? resolveUserPath(authoredConfig.agents.defaults.workspace.trim())
    : undefined;
  if (
    hasAuthoredSetup &&
    !pendingSetup &&
    setupModel &&
    (!requestedWorkspace || requestedWorkspace === authoredWorkspace)
  ) {
    const welcome = formatSystemAgentOnboardingWelcome(overview, translate);
    params.engine.noteAssistantMessage(welcome);
    return { text: welcome, question: readyWelcomeQuestion(translate) };
  }
  if (!setupModel) {
    throw new Error(
      "OpenClaw onboarding requires working inference first. Run `openclaw onboard` on the machine running OpenClaw to configure and verify a default model.",
    );
  }

  const { DEFAULT_WORKSPACE } = await import("../commands/onboard-helpers.js");
  // A durable receipt owns recovery even after partial config writes; using its
  // workspace prevents the fallback chat from resuming a different installation.
  const workspace = resolveUserPath(
    pendingSetup?.workspace || requestedWorkspace || authoredWorkspace || DEFAULT_WORKSPACE,
  );

  params.engine.propose({
    kind: "setup",
    workspace,
    ...(params.agentName ? { agentName: params.agentName } : {}),
  });
  const welcome = [
    `## ${translate(overview.defaultModel ? "hatchIntro" : "setupIntro")}`,
    "",
    translate("machineIntro"),
    "",
    `- ${translate(overview.defaultModel ? "verifiedAi" : "verifiedSetupAi", { model: setupModel })}`,
    `- ${translate("workspace", { workspace: shortenHomePath(workspace) })}`,
    `- ${translate("localGateway")}`,
    "",
    translate("applyPrompt"),
    "",
    translate("security"),
    translate(overview.defaultModel ? "afterSetup" : "setupModelNext"),
  ].join("\n");
  params.engine.noteAssistantMessage(welcome);
  return { text: welcome, question: setupWelcomeQuestion(translate) };
}
