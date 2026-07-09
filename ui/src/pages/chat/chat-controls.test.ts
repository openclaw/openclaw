/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { UiSettings } from "../../app/settings.ts";
import { t } from "../../i18n/index.ts";
import { renderChatControls } from "./components/chat-controls.ts";

type ChatControlsProps = Parameters<typeof renderChatControls>[0];

vi.mock("../../components/icons.ts", () => ({
  icons: {},
}));

function createSettings(): UiSettings {
  return {
    gatewayUrl: "ws://localhost:18789",
    token: "",
    sessionKey: "main",
    lastActiveSessionKey: "main",
    theme: "claw",
    themeMode: "dark",
    chatShowThinking: true,
    chatShowToolCalls: true,
    chatPersistCommentary: false,
    chatAutoScroll: "near-bottom",
    splitRatio: 0.6,
    navCollapsed: false,
    navWidth: 280,
    sidebarPinnedRoutes: ["overview", "workboard", "agents"],
    sidebarMoreExpanded: false,
  };
}

function createProps(overrides: Record<string, unknown> = {}): ChatControlsProps {
  return {
    paneId: "test-pane",
    agentsList: null,
    connected: true,
    hideCronSessions: true,
    loading: false,
    manualRefreshInFlight: false,
    model: {
      activeRunId: null,
      connected: true,
      gatewayAvailable: true,
      loading: false,
      modelCatalog: [],
      modelSwitching: false,
      sending: false,
      sessionKey: "main",
      sessionsResult: null,
      stream: null,
    },
    onboarding: false,
    runId: null,
    sending: false,
    settings: createSettings(),
    settingsOpen: true,
    sessionKey: "main",
    sessionsResult: null,
    stream: null,
    onRefresh: () => undefined,
    onSettingsChange: () => undefined,
    onSettingsOpenChange: () => undefined,
    realtimeTalkOptions: {
      model: "",
      voice: "marin",
      vadThreshold: "",
    },
    realtimeTalkInputDevices: [
      { deviceId: "built-in", label: "Built-in Microphone" },
      { deviceId: "usb", label: "USB Audio Interface" },
    ],
    realtimeTalkInputDeviceId: "built-in",
    onRealtimeTalkInputRefresh: () => undefined,
    onRealtimeTalkInputSelect: () => undefined,
    onRealtimeTalkOptionsChange: () => undefined,
    ...overrides,
  } as unknown as ChatControlsProps;
}

describe("chat composer settings", () => {
  it("combines chat and voice controls in one Settings menu", () => {
    const container = document.createElement("div");
    render(renderChatControls(createProps()), container);

    expect(container.querySelectorAll(`button[aria-label="${t("chat.settings")}"]`)).toHaveLength(
      1,
    );
    expect(container.querySelector('[aria-label="Talk settings"]')).toBeNull();
    expect(
      Array.from(container.querySelectorAll(".chat-settings-popover__label")).map((node) =>
        node.textContent?.trim(),
      ),
    ).toEqual(["Chat", "Voice"]);
    expect(container.querySelector('[aria-label="Voice options"]')).not.toBeNull();
    expect(container.querySelector('[data-talk-select="microphone"] select')).not.toBeNull();
  });

  it("keeps voice options editable from Settings", () => {
    const container = document.createElement("div");
    const onRealtimeTalkOptionsChange = vi.fn();
    render(renderChatControls(createProps({ onRealtimeTalkOptionsChange })), container);

    const voice = container.querySelector<HTMLSelectElement>('[data-talk-select="voice"] select');
    expect(voice).toBeInstanceOf(HTMLSelectElement);
    if (!(voice instanceof HTMLSelectElement)) {
      throw new Error("expected voice select");
    }
    voice.value = "cedar";
    voice.dispatchEvent(new Event("change", { bubbles: true }));

    expect(onRealtimeTalkOptionsChange).toHaveBeenCalledWith({ voice: "cedar" });
  });

  it("keeps microphone selection in Voice settings", () => {
    const container = document.createElement("div");
    const onRealtimeTalkInputSelect = vi.fn();
    render(renderChatControls(createProps({ onRealtimeTalkInputSelect })), container);

    const microphone = container.querySelector<HTMLSelectElement>(
      '[data-talk-select="microphone"] select',
    );
    expect(microphone).toBeInstanceOf(HTMLSelectElement);
    if (!(microphone instanceof HTMLSelectElement)) {
      throw new Error("expected microphone select");
    }
    expect(microphone.value).toBe("built-in");
    microphone.value = "usb";
    microphone.dispatchEvent(new Event("change", { bubbles: true }));

    expect(onRealtimeTalkInputSelect).toHaveBeenCalledWith("usb");
  });

  it("refreshes microphone access from Voice settings", () => {
    const container = document.createElement("div");
    const onRealtimeTalkInputRefresh = vi.fn();
    render(renderChatControls(createProps({ onRealtimeTalkInputRefresh })), container);

    const refresh = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Refresh: Microphone input"]',
    );
    expect(refresh).toBeInstanceOf(HTMLButtonElement);
    refresh?.click();

    expect(onRealtimeTalkInputRefresh).toHaveBeenCalledOnce();
  });

  it("keeps the composer control cluster limited to model and Settings controls", () => {
    const container = document.createElement("div");
    render(renderChatControls(createProps()), container);

    expect(Array.from(container.children).map((node) => node.className)).toEqual([
      "chat-settings-popover-wrapper",
      "chat-composer-model-control",
    ]);
    expect(container.querySelector('[data-chat-provider-usage="true"]')).toBeNull();
  });
});

function sessionsWithRow(row: Record<string, unknown>) {
  return {
    ts: 0,
    path: "",
    count: 1,
    defaults: { modelProvider: null, model: null, contextTokens: 200_000 },
    sessions: [{ key: "main", kind: "direct", updatedAt: 0, ...row }],
  };
}

const PLAN_ROW = { plan: { schemaVersion: 1, status: "planning", enteredAt: 0, updatedAt: 0 } };
const GOAL_ROW = {
  goal: {
    schemaVersion: 1,
    id: "g1",
    objective: "ship",
    status: "active",
    createdAt: 0,
    updatedAt: 0,
    tokenStart: 0,
    tokensUsed: 0,
    continuationTurns: 0,
  },
};

describe("composer mode selector (U-V4)", () => {
  it("is absent unless mode wiring is provided", () => {
    const container = document.createElement("div");
    render(renderChatControls(createProps()), container);
    expect(container.querySelector(".chat-mode-select")).toBeNull();
  });

  it("reflects off/plan/goal from session state", () => {
    const container = document.createElement("div");
    const wiring = { onModeCommand: () => undefined, onOpenGoalEditor: () => undefined };

    render(renderChatControls(createProps(wiring)), container);
    expect(container.querySelector(".chat-mode-select")?.getAttribute("data-chat-mode")).toBe(
      "off",
    );
    expect(container.querySelectorAll("[data-chat-mode-option]")).toHaveLength(3);

    render(
      renderChatControls(createProps({ ...wiring, sessionsResult: sessionsWithRow(PLAN_ROW) })),
      container,
    );
    expect(container.querySelector(".chat-mode-select")?.getAttribute("data-chat-mode")).toBe(
      "plan",
    );

    render(
      renderChatControls(createProps({ ...wiring, sessionsResult: sessionsWithRow(GOAL_ROW) })),
      container,
    );
    expect(container.querySelector(".chat-mode-select")?.getAttribute("data-chat-mode")).toBe(
      "goal",
    );
  });

  it("enters plan mode and opens the goal editor from Off with no confirm", () => {
    const container = document.createElement("div");
    const onModeCommand = vi.fn();
    const onOpenGoalEditor = vi.fn();
    const confirm = vi.spyOn(globalThis, "confirm").mockReturnValue(true);

    render(renderChatControls(createProps({ onModeCommand, onOpenGoalEditor })), container);
    container.querySelector<HTMLButtonElement>('[data-chat-mode-option="plan"]')!.click();
    expect(onModeCommand).toHaveBeenCalledWith("/plan enter");
    expect(confirm).not.toHaveBeenCalled();

    container.querySelector<HTMLButtonElement>('[data-chat-mode-option="goal"]')!.click();
    expect(onOpenGoalEditor).toHaveBeenCalledTimes(1);
  });

  it("confirms before switching away from an active mode (mutual exclusion)", () => {
    const container = document.createElement("div");
    const onModeCommand = vi.fn();
    const onOpenGoalEditor = vi.fn();
    const confirm = vi.spyOn(globalThis, "confirm");
    const props = { onModeCommand, onOpenGoalEditor, sessionsResult: sessionsWithRow(PLAN_ROW) };

    // Decline the confirm → nothing happens.
    confirm.mockReturnValueOnce(false);
    render(renderChatControls(createProps(props)), container);
    container.querySelector<HTMLButtonElement>('[data-chat-mode-option="goal"]')!.click();
    expect(onModeCommand).not.toHaveBeenCalled();
    expect(onOpenGoalEditor).not.toHaveBeenCalled();

    // Accept the confirm → exit plan, then open the goal editor.
    confirm.mockReturnValueOnce(true);
    render(renderChatControls(createProps(props)), container);
    container.querySelector<HTMLButtonElement>('[data-chat-mode-option="goal"]')!.click();
    expect(onModeCommand).toHaveBeenCalledWith("/plan exit");
    expect(onOpenGoalEditor).toHaveBeenCalledTimes(1);
  });
});
