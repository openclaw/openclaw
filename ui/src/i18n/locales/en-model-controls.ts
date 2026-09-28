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
      decisionLabel: "Decision Model",
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
      fastMode: "Fast mode",
      searchModels: "Search models",
      noMatchingModels: "No models match your search",
      configureModels: "Configure models",
      selectionScopeSessionLabel: "This session",
      selectionScopeAgentLabel: "Agent default",
      selectionScopeGlobalLabel: "Global default",
      selectionScopeSession: "Selecting a model changes only this session.",
      selectionScopeAgent: "Selecting a model updates this agent's default.",
      selectionScopeGlobal: "Selecting a model updates the global default.",
      defaultWithModel: "Default ({model})",
      defaultWithLevel: "Default ({level})",
      fastHelp: "Faster responses, higher usage of limits.",
      contextWindow: "Context window",
      contextWindowAria: "Context window: {state}",
      speedUnsupported: "Speed control is not supported for this model.",
      contextActiveAndMax: "{active} active · {maximum} max",
      chatOnly: "Chat only",
      chatOnlyHelp:
        "This model can chat, but it cannot use tools. Choose another model for files, commands, web, or media tasks.",
      loadingModels: "Loading models…",
      refreshingModels: "Refreshing models…",
      refreshingProviderModels: "Refreshing models for {providers}…",
      modelPending: "Model pending",
      modelStarting: "Starting…",
      modelsUnavailable: "Models unavailable",
      runtimeUnavailable: "This harness is unavailable for this model.",
      modelsRefreshFailed: "Some models could not be refreshed. Open Models to try again.",
      checkingProviderModels: "{providers}: checking models…",
      noModelsAvailable: "No models available",
      noPermittedModels: "No models are permitted by your administrator.",
      selectionRequired: "Choose a model",
      restrictedModelsHelp: "Your administrator centrally configures the models available here.",
      emptyModelsAction: "Manage models",
      providerModels: "{provider} models",
      useDefaultReasoning: "Use default reasoning ({level})",
      fastResponsesAria: "Fast responses: {state}",
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
      label: "Execution permissions",
      help: "Choose what available tools may do in this session. This does not change the tool profile.",
      default: "Default",
      defaultDescription: "Follow the agent's configured execution permissions.",
      defaultWithMode: "Default ({mode})",
      fullRequiresAdmin: "Full access requires operator.admin access.",
      updateFailed: "Failed to update permissions: {error}",
      refreshFailed: "Permissions were saved, but refreshing the session failed: {error}",
      modes: {
        "read-only": {
          label: "Read Only",
          description:
            "Agent tools can read within the session root, but cannot write or run commands.",
        },
        guarded: {
          label: "Guarded",
          description: "A human reviews requests beyond the session root.",
        },
        workspace: {
          label: "Workspace",
          description: "An AI reviewer checks requests beyond the session root.",
        },
        full: {
          label: "Full Access",
          description: "No reviewer; files and commands are unrestricted.",
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
