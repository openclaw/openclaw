/* @vitest-environment jsdom */

import { expect, it, onTestFinished, vi } from "vitest";
import {
  BROWSER_PANEL_TOGGLE_EVENT,
  DESKTOP_PANEL_TOGGLE_EVENT,
  PLUGIN_PANEL_TOGGLE_EVENT,
  PORTAL_PANEL_TOGGLE_EVENT,
  TERMINAL_PANEL_TOGGLE_EVENT,
} from "../components/panel-toggle-contract.ts";
import {
  takeSessionPanelToggle,
  type SessionPanelToggleSlot,
} from "../components/session-panel-toggle-buffer.ts";
import { openTemplateCreator } from "../pages/templates/creator-owner.ts";
import { createProfileAppearanceGateway } from "./app-shell-gateway.test-support.ts";

vi.mock("../pages/templates/creator-owner.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../pages/templates/creator-owner.ts")>()),
  openTemplateCreator: vi.fn(),
}));

it("drops a deferred review handoff after its application context retires", async () => {
  vi.mocked(openTemplateCreator).mockClear();
  const { host, owner } = createProfileAppearanceGateway(null);
  owner.handleGatewayEvent({
    type: "event",
    event: "ui.command",
    payload: {
      command: { kind: "template-review", draftId: "ec8f46b0-4ca3-4991-8a73-dfdcc8764087" },
      agentId: "research",
      sessionKey: "agent:research:dashboard:source",
    },
  });
  Object.defineProperty(host, "context", { value: undefined });
  await vi.dynamicImportSettled();
  expect(openTemplateCreator).not.toHaveBeenCalled();
});

it.each([
  ["browser", BROWSER_PANEL_TOGGLE_EVENT],
  ["desktop", DESKTOP_PANEL_TOGGLE_EVENT],
  ["portal", PORTAL_PANEL_TOGGLE_EVENT],
  ["terminal", TERMINAL_PANEL_TOGGLE_EVENT],
  ["plugin", PLUGIN_PANEL_TOGGLE_EVENT],
] as const)("keeps %s panel commands out of another conversation or page", (panel, eventName) => {
  const { context, host, owner } = createProfileAppearanceGateway(null);
  const source = "agent:main:reading";
  const background = "agent:main:background";
  const selectChatSession = vi.fn();
  Object.assign(host, {
    activeSessionKey: source,
    routeState: { routeId: "chat" },
    shellNavigation: { selectChatSession },
  });
  Object.assign(context, { agentSelection: { state: { selectedId: "main" } } });
  const delivered = vi.fn();
  window.addEventListener(eventName, delivered);
  onTestFinished(() => window.removeEventListener(eventName, delivered));
  const slot: SessionPanelToggleSlot = panel === "plugin" ? "plugin:review/document" : panel;
  const send = (sessionKey: string, open: boolean) =>
    owner.handleGatewayEvent({
      type: "event",
      event: "ui.command",
      payload: {
        sessionKey,
        agentId: "main",
        command: {
          kind: "panel",
          panel,
          open,
          ...(panel === "plugin" ? { pluginId: "review", panelId: "document" } : {}),
        },
      },
    });
  for (const open of [true, false]) {
    send(background, open);
    expect(takeSessionPanelToggle(slot, background, "main")).toBeNull();
    Object.assign(host, { routeState: { routeId: "settings" } });
    send(source, open);
    expect(takeSessionPanelToggle(slot, source, "main")).toBeNull();
    Object.assign(host, { routeState: { routeId: "chat" } });
  }
  expect(delivered).not.toHaveBeenCalled();
  expect(selectChatSession).not.toHaveBeenCalled();
  for (const open of [true, false]) {
    send(source, open);
    expect(takeSessionPanelToggle(slot, source, "main")).not.toBeNull();
  }
  expect(delivered).toHaveBeenCalledTimes(2);
});

it("opens the current agent GitHub identity panel without exposing authorization data", async () => {
  const { context, owner } = createProfileAppearanceGateway(null);
  const navigate = vi.fn();
  Object.assign(context, { basePath: "", navigate });

  owner.handleGatewayEvent({
    type: "event",
    event: "ui.command",
    payload: {
      command: { kind: "agent-github-settings" },
      agentId: "release",
    },
  });

  expect(navigate).toHaveBeenCalledWith("profile", {
    hash: "#settings-profile-github-connections",
  });
});
