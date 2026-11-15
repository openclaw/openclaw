import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const enModelSetup = {
  modelSetup: {
    discovery: {
      title: "Available models",
      description:
        "Find saved accounts or set up a local model for {agent}. This changes only this agent’s model, not the defaults for other agents.",
      useForAgent: "Test & use for this agent",
      connectForAgent: "Add account for this agent",
      connectProvider: "Add account",
      returnToModels: "Back to Models",
      otherSoftware: "Other detected software",
    },
    heading: "Set up a model",
    intro:
      "OpenClaw finds saved accounts and local models on the computer running OpenClaw. Choose one to begin; nothing is selected, tested, installed, or saved automatically.",
    loading: "Loading models…",
    testing: "Asking the selected model for a quick reply…",
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
      checking: "Asking {modelRef} for a quick reply…",
      ready: "Ready",
      readyIn: "Ready · {latencyMs} ms",
      providerUnavailable: "{provider} isn’t responding.",
    },
    access: {
      adminRequired: "You need admin access to set up models.",
      gatewayTooOld: "Update the Gateway to set up models.",
    },
    candidates: {
      title: "Available models",
      recommended: "Recommended",
      credentialsReady: "Account ready",
      detected: "Detected",
      testAndUse: "Test & use",
      retry: "Retry test",
      testingButton: "Testing…",
    },
    nativeDiscovery: {
      title: "Find existing sessions",
      body: "Show sessions from installed agents on the computer running OpenClaw in OpenClaw. This doesn’t import or copy them.",
      enable: "Show existing sessions",
      decline:
        "Leave unchecked to keep these sessions hidden when you add an account. Existing installations aren’t changed.",
    },
    nativeModels: {
      title: "Use an installed agent",
      body: "Choose a model from an installed agent. It keeps its own sign-in and tools. Use saves your choice without running the setup test.",
      choose: "Choose a model",
      use: "Use",
      saving: "Saving…",
      loading: "Loading installed agents…",
      empty:
        "No models from installed agents yet. Check the installed app, then open the picker again.",
      unconfirmed: "Availability not confirmed",
    },
    empty: {
      title: "Recommended installs",
      intro: "Install an agent or local model service, then check again.",
    },
    signIn: {
      title: "Set up and verify a model",
      description:
        "Setup asks the model for a reply. To save an account first, choose Add account.",
      verify: "Set up & verify",
      install: "Review & install",
      custom: "Set up endpoint",
      more: "More sign-in options",
    },
    prepare: {
      title: "Run a model locally",
      intro:
        "Use a local model service or set up a private GGUF model on the computer running OpenClaw.",
      ollamaButton: "Check & set up",
      ollamaLabel: "Ollama",
      ollamaHint:
        "Use Ollama on the computer running OpenClaw to set up a model that supports tools",
      llamaCppLabel: "llama.cpp",
      providerNotReady:
        "Couldn’t find a usable local model from {provider}. Review the setup result, then try again.",
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
      title: "Model verified",
      body: "{modelRef} replied. You can start chatting now.",
      activeModel: "Active model",
      latency: "Verified in {latencyMs} ms",
      openChat: "Start chatting",
      continueSetup: "Continue setup",
      stayHere: "Stay in settings",
      configuredModel: "Configured model",
    },
    utility: {
      role: "Setup & utility",
      hint: "Helps set up OpenClaw and handles lightweight tasks. Other sessions need a primary model.",
      useSetup: "Use for setup",
      useUtility: "Use as utility",
      ready: "Setup & utility model ready",
      configured: "Setup & utility model",
      verified: "{modelRef} replied. This model is ready for setup and lightweight tasks.",
      model: "Utility model",
      choosePrimary:
        "Choose a primary model below for other sessions. Your setup agent stays available.",
      primaryReady:
        "This model handles setup and lightweight tasks. Other sessions use your primary model.",
      openAssistant: "Open setup agent",
      repair: "Recheck & repair",
    },
    failure: {
      rateLimit: "Rate limited",
      billing: "Billing problem",
      timeout: "Timed out",
      format: "Invalid response",
      unavailable: "Unavailable",
      unknown: "Couldn’t check model",
    },
    failureGuidance: {
      rateLimit: "Wait for the provider limit to reset, then retry.",
      billing: "Restore provider billing or quota, then retry.",
      timeout: "The model didn’t reply in time. Try again or choose a faster model.",
      unavailable: "Make sure the provider service is running and reachable, then retry.",
      format: "Check that the endpoint provides a compatible model, then try again.",
      unknown: "Review the account details, then try again.",
    },
    errors: {
      requestFailed: "Couldn’t set up the model. Try again.",
      activationFailed: "Couldn’t use the model. Try again.",
    },
    wizard: {
      dialogLabel: "Provider sign-in",
      prepareDialogLabel: "Local model setup",
      title: "Sign in with a provider",
      connected: "Account added",
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
      signInTitle: "Continue in your browser",
      deviceCodeTitle: "Enter this code in your browser",
      signInPage: "The sign-in page",
      browserOpened:
        "{provider} is open in a new tab. Approve access there. This window updates by itself.",
      browserOpenedContinue:
        "{provider} is open in a new tab. Approve access there, then choose Continue.",
      deviceCodeOpened:
        "{provider} is open in a new tab. Make sure it shows the same code before you approve.",
      deviceCodeEnter: "Enter this code on the provider’s sign-in page.",
      waitingForProvider: "Waiting for {provider}…",
      reopenSignIn: "Reopen browser tab",
      tryAgain: "Try again",
      tabDidNotOpen: "Tab didn’t open?",
      copySignInLink: "Copy sign-in link",
      stillWaiting:
        "Still waiting. If you already approved, the tab may have opened in another browser or profile. Try again from here.",
      deviceCodeExpired:
        "This code expired. No account was added. Close this window and sign in again.",
      cancelSignIn: "Cancel sign-in",
      deviceCodeWarning:
        "Continue only if you started this sign-in. If someone sent you this code, cancel.",
      expires: "Expires in {count} minutes",
      expiresSoon: "Expires in less than a minute",
      cancelled: "Sign-in canceled",
      finishingStep: "Setup is finishing the current step. You can cancel when it finishes.",
      cancelFailed: "Couldn’t confirm cancellation. Try again. {error}",
      sessionExpired:
        "This setup may have finished. Close this dialog and choose Check again to review it.",
      gatewayNotResponding:
        "Couldn’t finish setup. Check that the Gateway is running, then try again.",
      gatewayReconnecting: "Disconnected. Waiting to reconnect…",
      notComplete: "You’re signed in, but model setup isn’t complete yet.",
    },
    providerConnected: "{provider} is ready",
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
