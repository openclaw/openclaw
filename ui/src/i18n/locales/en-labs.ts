import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const enLabs = {
  labsPage: {
    swarm: {
      title: en.labsPage.swarm.title,
      groupTitle: "Parallel tasks",
      defaultPhase: en.labsPage.swarm.defaultPhase,
      progress: "{complete} of {total}",
      active: "{running} running · {queued} queued · {failed} failed or stopped",
      finished: "{done} completed · {failed} failed or stopped",
      completed: "{done} completed",
      failedOrStopped: "Failed or stopped",
      childOutcome: "Subagents finished. Check the conversation for the final reply.",
      childOutcomeProcessing: "Subagents finished. The parent agent is processing their results.",
      details: "Subagent details",
      detailsUnavailable:
        "Subagent details are unavailable. Counts include all accepted subagents.",
      otherGroups: "{count} more active groups",
    },
    configure: "Configure",
    configureFeature: "Configure {name}",
    decisionAssistance: {
      title: "Decision assistance",
      description: "Enable experimental assistance from your configured Decision model.",
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
        "Node.js is for trusted code; its VM is not a security sandbox. QuickJS runs code in an isolated WebAssembly runtime. Calls through OpenClaw tools use the same permissions. Applies to new replies; agent overrides take precedence.",
      executorNode: "Node.js (default)",
      executorQuickjs: "QuickJS (isolated)",
    },
    toolSearch: {
      title: "Tool search for all models",
      description:
        "Defer tool schemas and discover tools on demand. Enabled by default with structured tool calls; turning it off disables the global default.",
    },
    advisor: {
      title: "Advisor",
      description:
        "Advisor reviews the conversation on the session’s own model every few tool calls or minutes. If the agent is going off course, it steers the active reply with one short correction. Adds model calls.",
    },
    composerPredictions: {
      title: "Composer predictions",
      description:
        "Suggest a next message after a reply in the active conversation. Adds a tool-free model call using conversation context. Tab accepts the suggestion into your draft; it never sends automatically. Off by default.",
      model: "Prediction model",
      modelDescription:
        "Utility is recommended for short, lower-cost predictions. Session uses the current session model; Default uses the agent’s configured primary model. An unavailable choice skips predictions instead of switching models.",
      utility: "Utility model (recommended)",
      conversation: "Session model",
      default: "Default model",
    },
    chatBubbles: {
      title: "Speech bubbles",
      description:
        "Try speech bubbles with compact tool activity. Home uses bubbles by default while enabled; each browser keeps its explicit conversation choices. Disabling this lab restores the standard view without clearing those choices.",
    },
    templates: {
      title: "Templates",
      description: "Templates are ready-made agents for specific tasks.",
    },
    hostDesktop: {
      title: "Desktop on the computer running OpenClaw",
      description:
        "Watch and control the computer running OpenClaw from the Desktop panel through its existing VNC or Screen Sharing server.",
    },
    openclawId: {
      title: "OpenClaw ID remote access",
      description:
        "Open this claw from your other devices and invite people. To get started, sign in from the account menu and choose Turn on remote access. Manage who has access on the Access page. While off, this feature does not contact OpenClaw ID.",
    },
    workerDesktop: {
      title: "Cloud device desktop",
      description:
        "Watch and control cloud device desktops from Crabbox AWS, Azure, or Hetzner profiles with desktop support enabled.",
    },
  },
} satisfies TranslationMap;

export const registerLabsEnglish = Object.assign(
  () => {
    const { swarm, ...labsPage } = enLabs.labsPage;
    Object.assign(en.labsPage, labsPage);
    Object.assign(en.labsPage.swarm, swarm);
  },
  { catalog: enLabs },
);
