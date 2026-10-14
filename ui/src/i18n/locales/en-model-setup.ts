import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const enModelSetup = {
  modelSetup: {
    discovery: {
      title: "On this Gateway",
      description:
        "Find existing connections or prepare a local model for {agent}. Using a model here changes this agent, not the global defaults.",
      useForAgent: "Test & use for this agent",
      connectForAgent: "Connect & use for this agent",
      connectProvider: "Connect provider",
      returnToModels: "Return to Models",
      otherSoftware: "Other detected software",
    },
    verify: {
      title: "Selected model",
      button: "Check model",
      retry: "Try again",
      checkAgain: "Check again",
      checkingButton: "Checking…",
      checking: "Checking — asking {modelRef} for a quick reply…",
      ready: "Ready",
      readyIn: "Ready · {latencyMs} ms",
      providerUnavailable: "{provider} isn’t responding.",
    },
    nativeDiscovery: {
      title: "Discover existing conversations",
      body: "Show native assistant conversations from this Gateway host in OpenClaw. This is discovery, not an import or copy.",
      enable: "Show existing native conversations",
      decline:
        "Leave unchecked to keep native session catalogs off when you connect your AI provider. Existing installations are not changed.",
    },
    success: {
      title: "Connection verified",
      body: "OpenClaw received a real reply from {modelRef}. You can start chatting now.",
      activeModel: "Active model",
      latency: "Verified in {latencyMs} ms",
      openChat: "Start chatting",
      continueSetup: "Continue setup",
      stayHere: "Stay in settings",
      configuredModel: "Configured model",
    },
    utility: {
      role: "Setup & utility",
      hint: "Helps set up OpenClaw and handles lightweight tasks. Regular chats need a primary model.",
      useSetup: "Use for setup",
      useUtility: "Use as utility",
      ready: "Setup & utility model ready",
      configured: "Setup & utility model",
      verified:
        "OpenClaw received a real reply from {modelRef}. This model is ready for setup and lightweight tasks.",
      model: "Utility model",
      choosePrimary:
        "Choose a primary model below for regular chats. Your setup assistant remains available.",
      primaryReady:
        "This model handles setup and lightweight tasks. Regular chats use your primary model.",
      openAssistant: "Open setup assistant",
      repair: "Recheck & repair",
    },
  },
} satisfies TranslationMap;

export const registerModelSetupEnglish = Object.assign(
  () => {
    Object.assign(en.modelSetup, enModelSetup.modelSetup);
  },
  { catalog: enModelSetup },
);
