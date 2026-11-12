import type { TranslationMap } from "../lib/types.ts";
import { registerChatToolLabelsEnglish } from "./en-chat-tool-labels.ts";
import { en } from "./en.ts";

const enChatToolContent = {
  chat: {
    toolCards: {
      previewMore: "Expand for more output",
      previewCaptured: "View captured beginning",
      previewTruncated: "Captured output is truncated",
      providerResponse: "Provider tool response",
      executionOutput: "Execution output",
      showFullOutput: "Show full output",
      fullOutputUnavailable: "Full output unavailable. Only the captured output is shown.",
      copyOutput: "Copy available output",
      downloadOutput: "Download available output",
      outputLoadFailed: "Couldn’t load the full output. Try again.",
      outputDownloadFailed: "Couldn’t download the output. Try again.",
      toolError: "Tool error",
      viewMode: "Tool detail view",
      diff: "Diff",
      raw: "Raw",
      openDetails: "Open tool details in side panel",
      noOutputFailed: "The tool failed without output.",
    },
  },
} satisfies TranslationMap;

export const registerChatToolContentEnglish = Object.assign(
  () => {
    registerChatToolLabelsEnglish();
    Object.assign(en.chat.toolCards, enChatToolContent.chat.toolCards);
  },
  { catalog: enChatToolContent },
);
