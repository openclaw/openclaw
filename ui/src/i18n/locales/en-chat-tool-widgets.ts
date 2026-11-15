import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const enChatToolWidgets = {
  chat: {
    toolCards: {
      canvas: "Canvas",
      showRawDetails: "Show raw details",
      hideRawDetails: "Hide raw details",
      widgetActions: "Widget actions",
      copyAsImage: "Copy as image",
      downloadAsImage: "Download as image",
      widgetExportRerender: "Render this widget again to export it as an image.",
      widgetExportHtmlFallback: "Image unavailable. Downloaded the widget as HTML instead.",
      widgetExportFailed: "Couldn’t export this widget. Try again.",
      pinToDashboard: "Pin to dashboard",
      pinToDashboardPending: "Pinning…",
      pinToDashboardFailed: "Couldn’t pin to dashboard. Try again.",
      pinnedToDashboard: "Pinned",
    },
  },
} satisfies TranslationMap;

export const registerChatToolWidgetsEnglish = Object.assign(
  () => Object.assign(en.chat.toolCards, enChatToolWidgets.chat.toolCards),
  { catalog: enChatToolWidgets },
);
