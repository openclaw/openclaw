import { readStyleSheet } from "../../../../test/helpers/ui-style-fixtures.js";

let cachedUiCss: string | null = null;

export function readUiCss(): string {
  if (cachedUiCss !== null) {
    return cachedUiCss;
  }
  const files = [
    "ui/src/styles/base.css",
    "ui/src/styles/layout.css",
    "ui/src/styles/layout.mobile.css",
    "ui/src/styles/components.css",
    "ui/src/styles/chat/startup-layout.css",
    "ui/src/styles/chat/layout.css",
    "ui/src/styles/chat/message-layout.css",
    "ui/src/styles/chat/composer-surface.css",
    "ui/src/styles/chat/composer.css",
    "ui/src/styles/chat/composer-queue.css",
    "ui/src/styles/chat/progress-card.css",
    "ui/src/styles/chat/composer-progress.css",
    "ui/src/styles/chat/composer-context-strip.css",
    "ui/src/styles/chat/text.css",
    "ui/src/styles/chat/grouped.css",
    "ui/src/styles/chat/tool-cards.css",
    "ui/src/styles/chat/working-indicator.css",
    "ui/src/styles/chat/question-card.css",
    "ui/src/styles/rail-header.css",
    "ui/src/styles/chat/sidebar.css",
    "ui/src/styles/chat/session-rail.css",
    "ui/src/styles/chat/side-panel.css",
  ];
  cachedUiCss = files.map((file) => readStyleSheet(file)).join("\n");
  return cachedUiCss;
}
