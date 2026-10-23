import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const enChatToolContent = {
  chat: {
    toolCards: {
      providerResponse: "Provider tool response",
      executionOutput: "Execution output",
      showFullOutput: "Show full output",
      fullOutputUnavailable: "Full output unavailable. Only the captured output is shown.",
      copyOutput: "Copy available output",
      downloadOutput: "Download available output",
      outputLoadFailed: "Could not load the full output. Try again.",
      outputDownloadFailed: "Could not download the output. Try again.",
      toolError: "Tool error",
      viewMode: "Tool detail view",
      diff: "Diff",
      raw: "Raw",
      openDetails: "Open tool details in side panel",
      noOutputFailed: "No output — tool failed.",
    },
  },
} satisfies TranslationMap;

export const registerChatToolContentEnglish = Object.assign(
  () => Object.assign(en.chat.toolCards, enChatToolContent.chat.toolCards),
  { catalog: enChatToolContent },
);
