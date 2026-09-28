import { nothing, render } from "lit";
import { afterEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import type { ChatSavedInputs } from "./chat-saved-inputs.ts";
import { createChatProps } from "./chat-view.test-helpers.ts";
import { renderChatQueue } from "./components/chat-composer-queue.ts";
import { renderSavedInputDetails } from "./components/chat-saved-input-details.ts";
import "../../styles/base.css";
import "../../styles/components.css";
import "../../styles/chat.ts";
import "../../styles/chat/composer-surface.css";

const container = document.createElement("div");
afterEach(() => {
  render(nothing, container);
  container.remove();
  vi.restoreAllMocks();
});
it("copies saved content through the real hit target without mounting forwarded actions", async () => {
  document.body.append(container);
  container.className = "agent-chat__composer-shell";
  container.style.width = "600px";
  const input = {
    id: "saved",
    acceptedAt: 1,
    state: "interrupted",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "Complete saved content" },
        {
          type: "clawhub",
          kind: "plugin",
          id: "ch_fixture",
          name: "Saved recommendation",
          official: true,
          installed: false,
        },
        {
          type: "canvas",
          preview: {
            kind: "canvas",
            surface: "assistant_message",
            render: "url",
            viewId: "cv_saved",
            url: "/__openclaw__/canvas/documents/cv_saved/index.html",
            title: "Saved widget",
            sandbox: "scripts",
            mcpApp: {
              viewId: "cv_saved",
              serverName: "fixture",
              toolName: "show",
              uiResourceUri: "ui://fixture/app.html",
              toolCallId: "saved-call",
            },
          },
        },
      ],
    },
  } as const;
  const saved: ChatSavedInputs = {
    items: [input],
    inspections: new Map([[input.id, { source: input }]]),
    onToggle: async () => {},
    error: undefined,
    loading: false,
    earlier: false,
    latest: false,
    canRead: true,
    onPage: () => {},
  };
  const write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  render(
    renderChatQueue({
      queue: [],
      savedInputs: saved,
      renderSavedInput: (row) =>
        renderSavedInputDetails(row, undefined, createChatProps(), () => {}),
      onQueueRemove: () => {},
    }),
    container,
  );
  expect(
    container.querySelectorAll(
      "openclaw-chat-clawhub-card, iframe, .chat-tool-card__widget-host, .chat-clawhub-card button, .chat-clawhub-card a",
    ),
  ).toHaveLength(0);
  await expect.element(page.getByText("Saved recommendation", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Copy as markdown", exact: true }).click();
  expect(write).toHaveBeenCalledExactlyOnceWith("Complete saved content");
});
