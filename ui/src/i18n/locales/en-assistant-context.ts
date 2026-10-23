import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const enAssistantContext = {
  assistantPanel: {
    title: en.assistantPanel.title,
    home: en.assistantPanel.home,
    toggle: en.assistantPanel.toggle,
    openHome: en.assistantPanel.openHome,
    close: en.assistantPanel.close,
    resize: en.assistantPanel.resize,
    dockBottom: en.assistantPanel.dockBottom,
    dockRight: en.assistantPanel.dockRight,
    context: "Working on: {context}",
    contextOff: en.assistantPanel.contextOff,
    removeContext: "Remove work context",
    includeContext: "Include work context",
    selection: "Selected text",
    attachSelection: "Attach selected text",
    removeSelection: "Remove selected text",
  },
} satisfies TranslationMap;

export const registerAssistantContextEnglish = Object.assign(
  () => {
    Object.assign(en.assistantPanel, enAssistantContext.assistantPanel);
  },
  { catalog: enAssistantContext },
);
