/* @vitest-environment jsdom */

import { render } from "lit";
import { expect, it, onTestFinished, vi } from "vitest";
import { groupMessages } from "../chat-thread-grouping.ts";
import { renderMessageGroup } from "./chat-message.ts";

it("keeps MCP App raw details reachable from its widget menu", async () => {
  const container = document.createElement("div");
  onTestFinished(async () => {
    await vi.dynamicImportSettled();
    render(null, container);
  });
  const preview = {
    kind: "canvas",
    surface: "assistant_message",
    render: "url",
    viewId: "cv_inline_mcp-raw",
    title: "Inline demo",
    url: "/__openclaw__/canvas/documents/cv_inline_mcp-raw/index.html",
    preferredHeight: 360,
    mcpApp: { viewId: "view-mcp-raw" },
  };
  const [group] = groupMessages([
    {
      kind: "message",
      key: "assistant-message",
      message: {
        role: "assistant",
        timestamp: 1,
        content: [
          {
            type: "canvas",
            preview,
            rawText: JSON.stringify({
              kind: "canvas",
              view: {
                backend: "canvas",
                id: preview.viewId,
                url: preview.url,
                title: preview.title,
                preferred_height: preview.preferredHeight,
              },
              presentation: { target: "assistant_message" },
            }),
          },
        ],
      },
    },
  ]);
  if (group?.kind !== "group") {
    throw new Error("expected a prepared assistant message group");
  }
  render(
    renderMessageGroup(group, {
      showReasoning: true,
      showToolCalls: true,
      assistantName: "OpenClaw",
      assistantAvatar: null,
      sessionKey: "agent:main:main",
    }),
    container,
  );
  await vi.dynamicImportSettled();
  expect(customElements.get("mcp-app-view")).toBeDefined();

  const dropdown = container.querySelector("wa-dropdown");
  expect(dropdown).toBeInstanceOf(HTMLElement);
  expect(dropdown?.querySelectorAll("wa-dropdown-item")).toHaveLength(1);
  dropdown?.dispatchEvent(
    new CustomEvent("wa-select", {
      detail: { item: { value: "raw-details" } },
    }),
  );
  expect(
    container
      .querySelector(".chat-tool-card__widget-raw .chat-tool-card__raw-toggle")
      ?.getAttribute("aria-expanded"),
  ).toBe("true");
});
