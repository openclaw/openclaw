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
    heading: "Connect a verified AI model",
    intro:
      "OpenClaw discovers AI access on this Gateway. Choose a provider to begin; nothing is selected, tested, installed, or saved automatically.",
    loading: "Checking this Gateway for available AI access…",
    testing: "Testing — asking the selected model for a quick reply…",
    retry: "Retry",
    checkAgain: "Check again",
    recovery: {
      unknown:
        "The previous activation is unresolved. Check again refreshes the current setup without repeating it. If a model is available, you can verify and use it.",
      wait: "The previous setup attempt may still be running. Check again can refresh its result. If no model appears, check again after {time} to choose a provider.",
      useCurrent: "Verify & use selected model",
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
    access: {
      adminRequired: "Model setup requires operator.admin access.",
      gatewayTooOld: "The Gateway is running an older OpenClaw version",
    },
    candidates: {
      title: "Found on this Gateway",
      recommended: "Recommended",
      credentialsReady: "Credentials ready",
      detected: "Detected",
      testAndUse: "Test & use",
      retry: "Retry test",
      testingButton: "Testing…",
    },
    nativeDiscovery: {
      title: "Discover existing conversations",
      body: "Show native assistant conversations from this Gateway host in OpenClaw. This is discovery, not an import or copy.",
      enable: "Show existing native conversations",
      decline:
        "Leave unchecked to keep native session catalogs off when you connect your AI provider. Existing installations are not changed.",
    },
    nativeModels: {
      title: "Use an installed agent",
      body: "Choose a model from an installed agent. It keeps its own sign-in and tools. Use saves your choice without running the setup test.",
      choose: "Choose a model",
      use: "Use",
      saving: "Saving…",
      loading: "Checking installed agents…",
      empty:
        "No models are available from installed agents. Check the installed app, then open the picker again.",
      unconfirmed: "Availability not confirmed",
    },
    empty: {
      title: "Recommended installs",
      intro: "Install an assistant or local model service, then check again.",
    },
    signIn: {
      title: "Set up and verify a model",
      description:
        "Setup requests a model reply. To save an account first, choose Connect provider.",
      verify: "Set up & verify",
      install: "Review & install",
      custom: "Set up endpoint",
      more: "More sign-in options",
    },
    prepare: {
      title: "Run a model locally",
      intro: "Use a local model service or prepare a private GGUF model on this Gateway.",
      ollamaButton: "Check & set up",
      ollamaLabel: "Ollama",
      ollamaHint: "Connect to the Ollama service on this Gateway and prepare a tools-capable model",
      llamaCppLabel: "llama.cpp",
      providerNotReady:
        "{provider} did not expose a usable local model. Review the setup result, then retry.",
    },
    manual: {
      title: "Connect with an API key or token",
      provider: "Provider and access method",
      selectProvider: "Select a provider",
      selectProviderHint: "Choose where this credential comes from",
      accessValue: "API key or token",
      accessValueFor: "{provider} API key or token",
      accessValuePlaceholder: "Paste an API key or token",
      connectAndVerify: "Connect & verify",
      verifyHint: "OpenClaw verifies a real model reply before marking the connection ready.",
      required: "Choose a provider and enter an API key or token.",
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
    failure: {
      rateLimit: "Rate limited",
      billing: "Billing problem",
      timeout: "Timed out",
      format: "Invalid response",
      unavailable: "Unavailable",
      unknown: "Connection failed",
    },
    failureGuidance: {
      rateLimit: "Wait for the provider limit to reset, then retry.",
      billing: "Restore provider billing or quota, then retry.",
      timeout:
        "The model did not finish the setup test in time. Warm it or choose a faster model, then retry.",
      unavailable: "Make sure the provider service is running and reachable, then retry.",
      format: "Check that the endpoint exposes a compatible chat model, then retry.",
      unknown: "Review the connection details, then retry.",
    },
    errors: {
      requestFailed: "Model setup request failed.",
      activationFailed: "The model could not be activated.",
    },
    wizard: {
      dialogLabel: "Provider sign-in",
      prepareDialogLabel: "Local model setup",
      title: "Sign in with a provider",
      connected: "Account connected.",
      prepareTitle: "Set up a local model",
      starting: "Starting provider sign-in…",
      prepareStarting: "Starting local model setup…",
      checking: "Checking your model setup…",
      working: "Working…",
      continue: "Continue",
      submit: "Submit",
      openSignIn: "Open sign-in",
      copy: "Copy",
      copyCode: "Copy code",
      copyLink: "Copy link",
      manualEntry: "Use manual entry",
      browserInstructions: "Complete sign-in in your browser, then return here.",
      waiting: "Waiting for sign-in…",
      deviceCodeWarning:
        "Continue only if you started this sign-in yourself. If a website or another person gave you this code, cancel.",
      expires: "Expires in {count} minutes",
      cancelled: "Provider sign-in was cancelled.",
      finishingStep: "Setup is finishing the current step. You can cancel when it finishes.",
      cancelFailed: "Could not confirm cancellation: {error}",
      sessionExpired:
        "The Gateway no longer has this setup session. It may already have finished. Close this dialog and choose Check again to review the current setup.",
      gatewayNotResponding:
        "The Gateway is not responding. Check that it is running, then try again.",
      gatewayReconnecting: "The Gateway is not responding. Waiting for it to reconnect.",
      notComplete: "Sign-in finished, but model setup is not complete yet.",
    },
    waitingForApproval: "Waiting for approval in your browser…",
    providerConnected: "{provider} is connected",
  },
} satisfies TranslationMap;

export const registerModelSetupEnglish = Object.assign(
  () => {
    const { candidates, failure, failureGuidance, ...setup } = enModelSetup.modelSetup;
    Object.assign(en.modelSetup, setup);
    Object.assign(en.modelSetup.candidates, candidates);
    Object.assign(en.modelSetup.failure, failure);
    Object.assign(en.modelSetup.failureGuidance, failureGuidance);
  },
  { catalog: enModelSetup },
);
