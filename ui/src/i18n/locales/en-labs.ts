import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const enLabs = {
  labsPage: {
    decisionAssistance: {
      title: "Decision assistance",
      description:
        "Enable experimental assistance from your configured Decision model. See the documentation for supported uses, setup, and data handling.",
      optedIn: "Preference saved.",
      loading: "Loading setting…",
      unavailable: "Couldn’t load this setting. Reconnect or refresh to try again.",
      refresh: "Refresh configuration",
    },
    codeMode: {
      title: "Code Mode",
      description:
        "Set the global default for compact JavaScript tool workflows. On selects Auto for evaluated models; Off disables the default. Per-model Code Mode overrides are in Agent Defaults → Models (Advanced).",
      executor: "Code Mode executor",
      executorDescription:
        "Node.js is for trusted code; its VM is not a security sandbox. QuickJS runs code in an isolated WebAssembly runtime. Calls through OpenClaw tools use the same permissions. Applies to new runs; agent overrides take precedence.",
      executorNode: "Node.js (default)",
      executorQuickjs: "QuickJS (isolated)",
    },
    toolSearch: {
      title: "Tool Search for all models",
      description:
        "Defer tool schemas and discover tools on demand. Enabled by default with structured tool calls; turning it off disables the global default.",
    },
    progressReview: {
      title: "Progress review",
      description:
        "Every few turns or minutes of agent work, a reviewer model reads the conversation's recent work and, if it spots avoidable work (drifting from the request, repeated or stalled tool calls), gives the agent one short correction on its next turn. Uses the agent's model and adds model calls.",
      everyTurns: "Review every N turns",
      everyMinutes: "Review every N minutes",
      triggerHelp: "Set to 0 to turn this trigger off. Review runs when either trigger is reached.",
      invalidValue: "{label} must be a whole number from 0 to {max}.",
    },
    chatBubbles: {
      title: "Speech bubbles",
      description:
        "Try speech bubbles with compact tool activity. Home uses bubbles by default while enabled; each browser keeps its explicit conversation choices. Disabling this lab restores the standard view without clearing those choices.",
    },
    customPluginUi: {
      title: "Custom plugin UI",
      description:
        "Let installed plugins add pages, widgets, and custom views. Their JavaScript runs with your signed-in permissions, so enable only plugins you trust. Bundled plugin views remain available. Reload this tab to clear previously loaded plugin code.",
    },
    hostDesktop: {
      title: "Host Desktop",
      description:
        "Watch and control this Gateway machine from the Desktop panel through its existing VNC or Screen Sharing server.",
    },
    workerDesktop: {
      title: "Cloud Worker Desktop",
      description:
        "Watch and control node-carried desktops from capable Crabbox AWS, Azure, or Hetzner profiles with desktop: true.",
    },
  },
} satisfies TranslationMap;

export const registerLabsEnglish = Object.assign(
  () => Object.assign(en.labsPage, enLabs.labsPage),
  { catalog: enLabs },
);
