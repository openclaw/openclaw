import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const catalog = {
  chat: {
    processesPanel: {
      back: "Back to processes",
      backToDetails: "Back to details",
      running: "Running ({count})",
      finished: "Finished ({count})",
      runningDesktop: "Running  {count}",
      finishedDesktop: "Finished  {count}",
      empty: "No background processes in this session yet.",
      viewAll: "View all processes",
      openOutput: "Open output",
      cannotStop: "Can’t be stopped",
      runningFor: "Running for",
      emptyTitle: "No processes",
      noOutputTitle: "No output yet",
      noRunning: "No running processes",
      stop: "Stop {name}",
      stopProcess: "Stop process",
      stopping: "Stopping…",
      stopNotRequested: "Couldn’t stop the process. Refresh to check its current state.",
      expired: "This process is no longer retained. Return to the process list.",
      omitted: "This process isn’t in the current list. Return to processes or refresh.",
      disconnected: "Reconnect to view processes.",
      output: "Recent output",
      noOutput: "No output yet.",
      exitCode: "Exit {code}",
      retention:
        "Process output is retained temporarily. Viewing it does not consume the agent’s output.",
      outputTruncated: "Earlier output is omitted from this retained tail.",
      listTruncated: "Only a bounded process list is shown; running processes take priority.",
      status: { running: "Running", completed: "Completed", failed: "Failed", killed: "Stopped" },
    },
  },
} satisfies TranslationMap;

export const registerProcessesEnglish = Object.assign(
  () => {
    Object.assign(en.chat.processesPanel, catalog.chat.processesPanel);
  },
  { catalog },
);
