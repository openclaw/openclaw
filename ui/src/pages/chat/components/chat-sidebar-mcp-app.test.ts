import { expect, it, vi, onTestFinished } from "vitest";
import { presentMcpAppInSidebar } from "../../../components/mcp-app-sidebar.ts";
import { setNativeGatewayTestState } from "../../../test-helpers/native-gateways.ts";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { createChatSidebarContainer } from "./chat-sidebar.test-support.ts";
import "./chat-detail-panel.tsx";

it("re-expands the retained frame when Review is reopened", () => {
  const view = document.createElement("mcp-app-view");
  const target = document.createElement("div");
  view.displayMode = "inline";
  const close = presentMcpAppInSidebar(view, target);
  expect(view.displayMode).toBe("fullscreen");
  close();
  expect(view.displayMode).toBe("inline");
  const closeAgain = presentMcpAppInSidebar(view, target);
  expect(view.displayMode).toBe("fullscreen");
  closeAgain();
});

it("returns each expanded App inline when its sidebar is replaced or closed", async () => {
  setNativeGatewayTestState(null);
  const container = createChatSidebarContainer();
  document.body.append(container);
  onTestFinished(() => container.remove());
  onTestFinished(() => vi.restoreAllMocks());
  const panel = document.createElement("openclaw-chat-detail-panel");
  const first = document.createElement("mcp-app-view");
  const second = document.createElement("mcp-app-view");
  const retireFirst = vi.fn();
  const retireSecond = vi.fn();
  const presentFirst = vi.fn(() => retireFirst);
  first.presentInSidebar = presentFirst;
  const presentSecond = vi.fn(() => retireSecond);
  second.presentInSidebar = presentSecond;
  panel.content = { kind: "mcp-app-preview", title: "First diagram", view: first };
  container.append(panel);
  await panel.updateComplete;
  await waitForSolid(() => expect(presentFirst).toHaveBeenCalledOnce());
  panel.content = { kind: "mcp-app-preview", title: "Second diagram", view: second };
  await panel.updateComplete;
  await waitForSolid(() => expect(presentSecond).toHaveBeenCalledOnce());
  expect(retireFirst).toHaveBeenCalledOnce();
  panel.remove();
  await waitForSolid(() => expect(retireSecond).toHaveBeenCalledOnce());
});
