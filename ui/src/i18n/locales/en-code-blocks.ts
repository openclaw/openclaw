import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const enCodeBlocks = {
  chat: {
    codeBlock: {
      languageFallback: "Code",
      hiddenLine: "1 hidden line",
      hiddenLines: "{count} hidden lines",
      showHiddenLine: "Show 1 hidden line",
      showHiddenLines: "Show {count} hidden lines",
      enableWrap: "Enable word wrap",
      disableWrap: "Disable word wrap",
      jsonView: "JSON view",
      jsonTree: "Tree",
      jsonRaw: "Raw",
      jsonArrayItem: "Array ({count} item)",
      jsonArrayItems: "Array ({count} items)",
      jsonObjectKeys: "Object ({count} keys)",
    },
  },
} satisfies TranslationMap;

export const registerCodeBlocksEnglish = Object.assign(
  () => Object.assign(en.chat.codeBlock, enCodeBlocks.chat.codeBlock),
  { catalog: enCodeBlocks },
);
