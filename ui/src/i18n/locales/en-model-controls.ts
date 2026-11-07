import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const enModelControls = {
  chat: {
    modelControls: {
      subscription: "Subscription",
      api: "API",
      default: "Default",
      routes: {
        claudeCli: {
          label: "Claude CLI · native",
          detail:
            "Runs through Claude Code, using its native login or a selected saved account. An explicitly selected API-key account has separate API billing; CLI does not mean free or subscription-only.",
        },
        anthropicApi: {
          label: "API · OpenClaw",
          detail:
            "Uses the configured Anthropic API connection with OpenClaw's runtime. API-key usage is billed separately from a Claude subscription.",
        },
        anthropicConfigured: {
          label: "Configured route",
          detail:
            "Anthropic models can use the API or Claude CLI, depending on their configured runtime and account. The provider name alone does not determine billing.",
        },
      },
      completionRoutes: {
        api: {
          label: "API · OpenClaw",
          detail:
            "Uses the provider's API connection with OpenClaw's runtime. API usage is billed to that provider account.",
        },
        cli: {
          label: "{runtime} · native",
          detail:
            "Runs through {runtime} using its own login. Billing follows the account it is signed in with; an API-key login is billed as API usage.",
        },
        harness: {
          label: "{runtime}",
          detail: "Runs through the {runtime} agent runtime and the account it uses.",
        },
      },
      decisionLabel: "Decision model",
      decisionDisabled: "Disabled",
      decisionInherit: "Use global default · {model}",
      decisionUnavailable:
        "This decision model is unavailable. Enable its plugin or choose another model.",
      decisionHelp:
        "Makes typed choices, scores, and yes/no judgments. Disabled until you select a decision model; chat models are not used as a fallback.",
      decisionAgentHelp:
        "Use the global decision model, choose an override, or disable decisions for this agent.",
      effort: "Effort",
      faster: "Faster",
      smarter: "Smarter",
      fastMode: "Speed",
      speed: "Speed",
      standard: "Standard",
      daybreak: "Daybreak",
      daybreakBlueShort: "Blue",
      daybreakRedShort: "Red",
      daybreakBlue: "Daybreak Blue",
      daybreakRed: "Daybreak Red",
      access: "Access",
      accessUnavailable: "{program} (unavailable)",
      fast: "Fast",
      ultrafast: "Ultrafast",
      ultrafastUnavailable: "Ultrafast isn't available for this model.",
      tierDowngrade: "Running at {served}. {requested} isn't available right now.",
      tierRejected: "{requested} isn't available right now.",
      switchTitle: "Switch to {new}?",
      switchWarning:
        "Switching re-sends the whole conversation to {new} with your next message, which uses more tokens. Long conversations may be summarized.",
      switchConfirm: "Switch model",
      dontAskAgain: "Don’t ask again",
      searchModels: "Search models",
      noMatchingModels: "No models match your search",
      usage5h: "5h",
      usageWeek: "Week",
      runsOn: "Runs on",
      configureModels: "Configure models",
      selectionScopeSessionLabel: "This session",
      selectionScopeAgentLabel: "Agent default",
      selectionScopeGlobalLabel: "Global default",
      selectionScopeSession: "Applies to this chat only.",
      selectionScopeAgent: "Changes the default for this agent.",
      selectionScopeGlobal: "Changes the default for all agents.",
      defaultWithModel: "Default ({model})",
      defaultWithLevel: "Default ({level})",
      fastHelp: "Faster replies. Uses up your limits faster.",
      contextWindow: "Context window",
      contextWindowAria: "Context window: {state}",
      speedUnsupported: "This model doesn't offer speed options.",
      contextActiveAndMax: "{active} active · {maximum} max",
      chatOnly: "No tools",
      chatOnlyHelp:
        "This model can't read files, run commands, or browse. Pick another model for that.",
      loadingModels: "Loading models…",
      refreshingModels: "Refreshing models…",
      refreshingSettings: "Refreshing session settings…",
      refreshingProviderModels: "Refreshing models for {providers}…",
      modelPending: "Model pending",
      modelsUnavailable: "Models unavailable",
      runtimeUnavailable: "This harness is unavailable for this model.",
      modelsRefreshFailed: "Some models could not be refreshed. Open Models to try again.",
      checkingProviderModels: "{providers}: checking models…",
      noModelsAvailable: "No models available",
      claudeCliNotReady: "Claude Code isn't ready. If signed out, run claude auth login.",
      noPermittedModels: "No models are permitted by your administrator.",
      selectionRequired: "Choose a model",
      restrictedModelsHelp: "Your admin chooses which models are available.",
      emptyModelsAction: "Manage models",
      providerModels: "{provider} models",
      allModels: "All models ({count})",
      useDefaultReasoning: "Use default effort ({level})",
      fastResponsesAria: "Speed: {state}",
    },
    nativeRuntimeRecovery: {
      title: "Use {runtime}’s native permissions?",
      confirm: "Continue for this chat",
      confirmMessage:
        "{runtime} will run on the Gateway host under its own permissions. OpenClaw’s optional native tool and sandbox restrictions, including workspace-only restrictions, will not be enforced for this harness. Only this chat is changed; other chats and global configuration stay unchanged. OpenClaw-hosted tools keep their own policy checks.",
      retryMessage: "Continue will retry the message you just sent.",
      chooseAnother: "Choose another model to keep this chat’s current execution restrictions.",
      failed: "Could not change this chat’s execution permissions: {error}",
      refreshFailed:
        "The model and permissions were saved, but refreshing this chat failed: {error}",
      reasons: {
        "sandbox-required": "{runtime} cannot run because this chat requires a sandbox.",
        sandbox: "{runtime} uses native tools that cannot run inside the OpenClaw sandbox.",
        "workspace-only":
          "{runtime} cannot enforce this chat’s OpenClaw workspace-only restriction.",
        "permission-mode": "{runtime} cannot enforce this chat’s current execution permissions.",
        "tool-policy": "{runtime} cannot enforce this chat’s OpenClaw native tool restrictions.",
        "remote-execution": "{runtime} cannot use this chat’s remote execution target.",
      },
    },
    permissionControls: {
      label: "Permissions",
      help: "Choose what the agent can read, edit, and run in this chat.",
      default: "Default",
      agentDefault: "Agent default",
      agentDefaultWithMode: "Agent default ({mode})",
      defaultDescription: "Uses this agent's settings.",
      defaultWithMode: "Default ({mode})",
      fullRequiresAdmin: "Only admins can turn on Full access.",
      requiresAdmin: "Requires admin access.",
      updateFailed: "Couldn't change permissions: {error}",
      refreshFailed: "Permissions saved, but this chat didn't refresh. Reload to see the change.",
      modes: {
        "read-only": {
          label: "Read only",
          description: "Can read files in this chat's workspace. Can't edit files or run commands.",
        },
        guarded: {
          label: "Ask me",
          description: "Asks you before doing anything outside the workspace.",
        },
        workspace: {
          label: "Auto-review",
          description: "An AI reviewer approves actions outside the workspace.",
        },
        full: {
          label: "Full access",
          description: "Edits files and runs commands anywhere, without review.",
        },
      },
    },
  },
} satisfies TranslationMap;

export const registerModelControlsEnglish = Object.assign(
  () => {
    en.chat = Object.assign({}, en.chat, enModelControls.chat);
  },
  { catalog: enModelControls },
);
