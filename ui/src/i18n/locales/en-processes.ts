import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const catalog = {
  chat: {
    processesPanel: {
      back: "Back to Processes",
      running: "Running ({count})",
      finished: "Finished ({count})",
      empty: "No background processes in this conversation.",
      noRunning: "No running processes",
      stop: "Stop {name}",
      stopping: "Stopping…",
      stopNotRequested: "The process could not be stopped. Refresh to check its current state.",
      expired: "This process is no longer retained. Return to the process list.",
      omitted:
        "This process is not included in the current limited list. Return to Processes or refresh.",
      disconnected: "Connect to the Gateway to view processes.",
      output: "Recent output",
      noOutput: "No output recorded yet.",
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
