/* @vitest-environment jsdom */

import { expect, it, onTestFinished, vi } from "vitest";
import { createApplicationContextProvider } from "../../../test-helpers/application-context.ts";
import { createSolidApplicationContextProvider } from "../../../test-helpers/solid-application-context.tsx";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { createInitializationContext } from "../chat-pane.test-support.ts";
import { createMessageGroupHarness } from "./chat-message-native.test-support.tsx";
import {
  createAssistantCanvasBlock,
  createAssistantMessage,
  createMessageGroup,
} from "./chat-message.test-support.ts";
import { settleToolBridges } from "./chat-tool-render.test-support.ts";

it("keeps MCP App raw details reachable from its widget menu", async () => {
  const context = createInitializationContext();
  const container = document.body.appendChild(createApplicationContextProvider(context));
  const view = createMessageGroupHarness(container, {
    wrapper: createSolidApplicationContextProvider(context).wrapper,
  });
  onTestFinished(async () => {
    await vi.dynamicImportSettled();
    view.unmount();
    container.remove();
  });
  const block = createAssistantCanvasBlock({ suffix: "mcp-raw" });
  const group = createMessageGroup(
    createAssistantMessage(
      [{ ...block, preview: { ...block.preview, mcpApp: { viewId: "view-mcp-raw" } } }],
      { timestamp: 1 },
    ),
    "assistant",
  );
  const draw = async () => {
    view.render(group, {
      showReasoning: true,
      showToolCalls: true,
      assistantName: "OpenClaw",
      assistantAvatar: null,
      sessionKey: "agent:main:main",
    });
    await settleToolBridges(container);
  };
  await draw();
  await vi.dynamicImportSettled();
  expect(customElements.get("mcp-app-view")).toBeDefined();
  await settleToolBridges(container);

  const menu = container.querySelector(".chat-tool-card__widget-actions");
  expect(menu).toBeInstanceOf(HTMLElement);
  expect(menu?.querySelectorAll('[role="menuitem"]')).toHaveLength(1);
  const rawAction = () => menu?.querySelector<HTMLButtonElement>('[data-value="raw-details"]');
  const openMenu = async () => {
    menu?.querySelector<HTMLButtonElement>(".chat-tool-card__widget-actions-trigger")?.click();
    await waitForSolid(() =>
      expect(menu?.querySelector('[role="menu"]')?.matches(":popover-open")).toBe(true),
    );
  };
  const selectRawDetails = async (label: string) => {
    rawAction()?.click();
    await waitForSolid(() => {
      expect(menu?.querySelector('[role="menu"]')?.matches(":popover-open")).toBe(false);
      expect(rawAction()?.getAttribute("aria-label")).toBe(label);
    });
  };
  const expanded = () =>
    container
      .querySelector(".chat-tool-card__widget-raw .chat-tool-card__raw-toggle")
      ?.getAttribute("aria-expanded");
  await openMenu();
  await selectRawDetails("Hide raw details");
  expect(expanded()).toBe("true");
  expect(rawAction()?.textContent).toContain("Hide raw details");
  expect(rawAction()?.getAttribute("aria-label")).toBe("Hide raw details");
  await draw();
  expect(container.querySelector(".chat-tool-card__widget-actions")).toBe(menu);
  expect(expanded()).toBe("true");
  expect(rawAction()?.textContent).toContain("Hide raw details");
  expect(rawAction()?.getAttribute("aria-label")).toBe("Hide raw details");
  await openMenu();
  expect(rawAction()?.getAttribute("aria-label")).toBe("Hide raw details");
  await selectRawDetails("Show raw details");
  expect(expanded()).toBe("false");
  expect(rawAction()?.textContent).toContain("Show raw details");
  expect(rawAction()?.getAttribute("aria-label")).toBe("Show raw details");
});
