/* @vitest-environment jsdom */

import { render } from "lit";
import { expect, it, onTestFinished, vi } from "vitest";
import { createApplicationContextProvider } from "../../../test-helpers/application-context.ts";
import { createInitializationContext } from "../chat-pane.test-support.ts";
import { renderMessageGroup } from "./chat-message-group.ts";
import {
  createAssistantCanvasBlock,
  createAssistantMessage,
  createMessageGroup,
} from "./chat-message.test-support.ts";
import { renderToolFixture, settleToolBridges } from "./chat-tool-render.test-support.ts";

it("keeps MCP App raw details reachable from its widget menu", async () => {
  const container = createApplicationContextProvider(createInitializationContext());
  onTestFinished(async () => {
    await vi.dynamicImportSettled();
    render(null, container);
  });
  const block = createAssistantCanvasBlock({ suffix: "mcp-raw" });
  const group = createMessageGroup(
    createAssistantMessage(
      [{ ...block, preview: { ...block.preview, mcpApp: { viewId: "view-mcp-raw" } } }],
      { timestamp: 1 },
    ),
    "assistant",
  );
  await renderToolFixture(
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
  await settleToolBridges(container);

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
