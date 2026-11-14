import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const enModelControls = {
  chat: {
    modelControls: {
      subscription: "Subscription",
      api: "API",
      nativeLogin: "Native login",
      default: "Default",
      defaultModel: "Default model",
      routes: {
        claudeCli: {
          label: "Claude CLI · native",
          detail:
            "Uses Claude CLI with its native login or selected account. API-key accounts have separate API charges.",
        },
        anthropicApi: {
          label: "API · OpenClaw",
          detail:
            "Uses the Anthropic API through OpenClaw. API charges are separate from Claude subscriptions.",
        },
        anthropicConfigured: {
          label: "Configured route",
          detail:
            "Uses the API or Claude CLI, depending on the runtime and account. Billing follows that account.",
        },
      },
      completionRoutes: {
        api: {
          label: "API · OpenClaw",
          detail:
            "Uses the provider’s API connection with OpenClaw’s runtime. API usage is billed to that provider account.",
        },
        cli: {
          label: "{runtime} · native",
          detail: "Uses {runtime} and its signed-in account. API-key accounts incur API charges.",
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
        "Handles structured choices and scores. Select a decision model to enable it; chat models are not used as fallback.",
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
      ultrafastUnavailable: "Ultrafast isn’t available for this model.",
      tierDowngrade: "Running at {served}. {requested} isn’t available right now.",
      tierRejected: "{requested} isn’t available right now.",
      switchTitle: "Switch to {new}?",
      switchWarning:
        "Switching re-sends the whole conversation to {new} with your next message, which uses more tokens. Long conversations may be summarized.",
      switchConfirm: "Switch model",
      dontAskAgain: "Don’t ask again",
      searchModels: "Search models",
      noMatchingModels: "No models match your search",
      runsOn: "Runs on",
      cooldown: "Cooldown {time}",
      cooldownStatus: "Cooling down",
      configureModels: "Configure models",
      selectionScopeSessionLabel: "This session",
      selectionScopeAgentLabel: "Agent default",
      selectionScopeGlobalLabel: "Global default",
      selectionScopeSession: "Applies to this session only.",
      selectionScopeAgent: "Changes the default for this agent.",
      selectionScopeGlobal: "Changes the default for all agents.",
      defaultWithModel: "Default ({model})",
      defaultWithLevel: "Default ({level})",
      fastHelp: "Faster replies. Uses up your limits faster.",
      contextWindow: "Context window",
      contextWindowAria: "Context window: {state}",
      speedUnsupported: "This model doesn’t offer speed options.",
      contextActiveAndMax: "{active} active · {maximum} max",
      chatOnly: "No tools",
      chatOnlyHelp: "No file, command, or browser access. Choose another model to use tools.",
      loadingModels: "Loading models…",
      refreshingModels: "Refreshing models…",
      refreshingSettings: "Refreshing session settings…",
      refreshingProviderModels: "Refreshing models for {providers}…",
      modelPending: "Model pending",
      modelsUnavailable: "Models unavailable",
      runtimeUnavailable: "This harness is unavailable for this model.",
      modelsRefreshFailed: "Couldn’t refresh some models. Open Models to try again.",
      checkingProviderModels: "{providers}: checking models…",
      noModelsAvailable: "No models available",
      claudeCliNotReady: "Claude CLI isn’t ready. If signed out, run claude auth login.",
      noPermittedModels: "No models are permitted by your admin.",
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
      confirm: "Continue for this session",
      confirmMessage:
        "{runtime} will run on the Gateway device under its own permissions. OpenClaw’s optional native tool and sandbox restrictions, including workspace-only restrictions, won’t be enforced for this harness. Only this session is changed; other sessions and global configuration stay unchanged. OpenClaw-managed tools keep their own policy checks.",
      retryMessage: "Continue will retry the message you just sent.",
      chooseAnother: "Choose another model to keep this session’s current execution restrictions.",
      failed: "Couldn’t change this session’s execution permissions. Try again.\n{error}",
      refreshFailed:
        "Couldn’t refresh this session. Reload to see the saved model and permissions.\n{error}",
      reasons: {
        "sandbox-required": "{runtime} can’t run because this session requires a sandbox.",
        sandbox: "{runtime} uses native tools that can’t run inside the OpenClaw sandbox.",
        "workspace-only":
          "{runtime} can’t enforce this session’s OpenClaw workspace-only restriction.",
        "permission-mode": "{runtime} can’t enforce this session’s current execution permissions.",
        "tool-policy": "{runtime} can’t enforce this session’s OpenClaw native tool restrictions.",
        "remote-execution": "{runtime} can’t use this session’s remote execution target.",
      },
    },
    permissionControls: {
      label: "Permissions",
      help: "Choose what the agent can read, edit, and run in this session.",
      default: "Default",
      agentDefault: "Agent default",
      agentDefaultWithMode: "Agent default ({mode})",
      defaultDescription: "Uses this agent’s settings.",
      defaultWithMode: "Default ({mode})",
      fullRequiresAdmin: "Only admins can turn on Full access.",
      requiresAdmin: "Requires admin access.",
      updateFailed: "Couldn’t change permissions. Try again.",
      refreshFailed: "Couldn’t refresh this session. Reload to see the saved permissions.",
      modes: {
        "read-only": {
          label: "Read only",
          description:
            "Can read files in this session’s workspace. Can’t edit files or run commands.",
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
