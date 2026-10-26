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
    mermaid: {
      title: "Mermaid diagram",
      options: "Diagram options",
      diagram: "Show diagram",
      source: "Show source",
      copySource: "Copy source",
      expand: "Expand diagram",
      expandNamed: "Expand diagram: {title}",
      rendering: "Rendering diagram…",
      error: "This diagram could not be rendered. Check the source or simplify the diagram.",
      rendererError:
        "The Mermaid renderer could not load or finish. Reload the dashboard; if this continues, check proxy or authentication rules for its renderer asset URLs.",
      imageError: "The diagram image could not be displayed. Reload the dashboard to try again.",
    },
  },
} satisfies TranslationMap;

export const registerCodeBlocksEnglish = Object.assign(
  () => {
    Object.assign(en.chat.codeBlock, enCodeBlocks.chat.codeBlock);
    Object.assign(en.chat.mermaid, enCodeBlocks.chat.mermaid);
  },
  { catalog: enCodeBlocks },
);
