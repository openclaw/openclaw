/* @vitest-environment jsdom */
import type { ProgressCard } from "@openclaw/gateway-protocol";
import { nothing, render } from "lit";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { loadSettings, patchSettings, saveSettings } from "../../app/settings.ts";
import { createRefreshChatPane } from "./chat-pane-history.test-support.ts";
import { createGatewayBrowserClientFixture } from "./chat-pane.test-support.ts";
import {
  openSlot,
  promoteSidebarPanel,
  setSidebarOpen,
  type SidebarSlotId,
} from "./sidebar-layout.ts";

const card: ProgressCard = {
  sessionKey: "agent:main:progress-placement",
  revision: 1,
  updatedAt: 1_800_000_000_000,
  markdown: "Verifying the implementation",
};
function fixture() {
  const request = vi.fn().mockResolvedValue({});
  const { pane, state, context } = createRefreshChatPane(
    createGatewayBrowserClientFixture({ request }),
  );
  pane.sessionKey = state.sessionKey = card.sessionKey;
  state.settings = { ...state.settings, chatShowTaskProgress: true, chatFloatTaskProgress: true };
  const presentation = { card, identity: card.sessionKey, lifetime: {} };
  Object.defineProperties(pane, {
    progressCardPresentation: { configurable: true, get: () => presentation },
    progressCardInitialLoading: { configurable: true, get: () => true },
  });
  Object.assign(pane, { paneWidth: 1200, presented: true });
  const mount = document.body.appendChild(document.createElement("div"));
  onTestFinished(() => {
    render(nothing, mount);
    mount.remove();
  });
  const paint = () => {
    pane.render();
    render(pane.chatProps?.floatingTaskProgress, mount);
  };
  const expanded = () =>
    mount.querySelector("button[aria-expanded]")?.getAttribute("aria-expanded");
  const toggle = () => mount.querySelector<HTMLButtonElement>("button[aria-expanded]")!.click();
  return { pane, state, context, request, presentation, mount, paint, expanded, toggle };
}
const slots: SidebarSlotId[] = [
  "browser",
  "terminal",
  "desktop",
  "workspace",
  "detail",
  "companion",
  "discussion",
  "portal",
  "link-reader",
  "plugin:fixture/inspector",
];
describe("floating task progress in the real pane", () => {
  it.each(slots)("starts collapsed beside %s and preserves a deliberate reopening", (slot) => {
    const f = fixture();
    f.state.sidebarLayout = openSlot({ columns: [] }, slot);
    const saved = structuredClone(f.state.sidebarLayout);
    f.paint();
    expect(f.expanded()).toBe("false");
    expect(f.pane.chatProps?.progressCard).toBeNull();
    expect(f.pane.chatProps?.progressCardInitialLoading).toBe(false);
    f.toggle();
    f.paint();
    expect(f.expanded()).toBe("true");
    f.presentation.card = { ...card, revision: 2, markdown: "Updated progress" };
    f.paint();
    expect(f.expanded()).toBe("true");
    expect(f.mount.textContent).toContain("Updated progress");
    expect(f.state.sidebarLayout).toEqual(saved);
  });
  it("collapses on a new panel, preserves manual choice across width changes, and never reopens on close", () => {
    const f = fixture();
    f.paint();
    expect(f.expanded()).toBe("true");
    f.state.sidebarLayout = openSlot({ columns: [] }, "browser");
    f.paint();
    expect(f.expanded()).toBe("false");
    f.toggle();
    f.paint();
    expect(f.expanded()).toBe("true");
    f.state.sidebarLayout = openSlot(f.state.sidebarLayout, "workspace");
    f.paint();
    expect(f.expanded()).toBe("false");
    f.state.sidebarLayout = setSidebarOpen(f.state.sidebarLayout, false);
    f.paint();
    expect(f.expanded()).toBe("false");
    Object.assign(f.pane, { paneWidth: 560 });
    f.paint();
    expect(f.pane.chatProps?.progressCard).toBe(card);
    expect(f.pane.chatProps?.floatingTaskProgress).toBe(nothing);
    Object.assign(f.pane, { paneWidth: 1200 });
    f.paint();
    expect(f.expanded()).toBe("false");
    Object.assign(f.pane, { presented: false });
    f.paint();
    expect(f.pane.chatProps?.floatingTaskProgress).toBe(nothing);
    Object.assign(f.pane, { presented: true });
    f.paint();
    expect(f.expanded()).toBe("false");
  });
  it("resets the choice for a new lifetime without sharing it with another pane", () => {
    const f = fixture();
    f.paint();
    f.toggle();
    f.paint();
    expect(f.expanded()).toBe("false");
    const other = fixture();
    other.paint();
    expect(other.expanded()).toBe("true");
    f.presentation.lifetime = {};
    f.paint();
    expect(f.expanded()).toBe("true");
  });
  it("keeps default composer placement and initial loading feedback, including compact views", () => {
    const f = fixture();
    f.state.settings.chatFloatTaskProgress = false;
    f.paint();
    expect(f.pane.chatProps?.progressCard).toBe(card);
    expect(f.pane.chatProps?.floatingTaskProgress).toBe(nothing);
    f.state.settings.chatFloatTaskProgress = true;
    Object.assign(f.pane, { compact: true });
    f.paint();
    expect(f.pane.chatProps?.progressCard).toBe(card);
    Object.assign(f.pane, { compact: false });
    Object.defineProperty(f.pane, "progressCardPresentation", { get: () => null });
    f.paint();
    expect(f.pane.chatProps?.progressCardInitialLoading).toBe(true);
    expect(f.pane.chatProps?.floatingTaskProgress).toBe(nothing);
    f.state.settings.chatShowTaskProgress = false;
    f.paint();
    expect(f.pane.chatProps?.progressCardInitialLoading).toBe(false);
  });
  it("does not render progress when another main view hides the conversation", () => {
    const f = fixture();
    const layout = openSlot({ columns: [] }, "workspace");
    const id = layout.columns[0]!.panels.find((panel) => panel.slot === "workspace")!.id;
    f.state.sidebarLayout = setSidebarOpen(promoteSidebarPanel(layout, id), false);
    f.paint();
    expect(f.pane.chatProps?.progressCard).toBeNull();
    expect(f.pane.chatProps?.floatingTaskProgress).toBe(nothing);
  });
  it("restores focus before collapsing body content and hides locally without writing the card", () => {
    const f = fixture();
    const previous = loadSettings();
    onTestFinished(() => saveSettings(previous));
    f.state.settings = patchSettings({ chatShowTaskProgress: true, chatFloatTaskProgress: true });
    f.paint();
    const body = f.mount.querySelector<HTMLElement>(".session-progress-card__body")!;
    body.focus();
    body.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    f.paint();
    expect(f.expanded()).toBe("false");
    expect(document.activeElement).toBe(f.mount.querySelector("button[aria-expanded]"));
    expect(f.mount.querySelector(".session-progress-card__reveal")?.hasAttribute("inert")).toBe(
      true,
    );
    f.mount.querySelector<HTMLButtonElement>('button[aria-label="Hide task progress"]')!.click();
    expect(loadSettings()).toMatchObject({
      chatShowTaskProgress: false,
      chatFloatTaskProgress: true,
    });
    expect(f.request.mock.calls.filter(([method]) => method === "progressCard.put")).toEqual([]);
  });
});
