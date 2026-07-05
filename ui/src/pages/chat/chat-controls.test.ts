/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { UiSettings } from "../../app/settings.ts";
import { renderChatControls, type ChatControlsProps } from "./components/chat-controls.ts";

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
    borderRadius: 50,
  };
}

function createProps(overrides: Record<string, unknown> = {}): ChatControlsProps {
  return {
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
    quota: {},
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
    onRealtimeTalkOptionsChange: () => undefined,
    ...overrides,
  } as unknown as ChatControlsProps;
}

describe("chat composer settings", () => {
  it("combines chat and voice controls in one Settings menu", () => {
    const container = document.createElement("div");
    render(renderChatControls(createProps()), container);

    expect(container.querySelectorAll('button[aria-label="Settings"]')).toHaveLength(1);
    expect(container.querySelector('[aria-label="Talk settings"]')).toBeNull();
    expect(
      Array.from(container.querySelectorAll(".chat-settings-popover__label")).map((node) =>
        node.textContent?.trim(),
      ),
    ).toEqual(["Chat", "Voice"]);
    expect(container.querySelector('[aria-label="Voice options"]')).not.toBeNull();
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

  it("places provider usage before Settings", () => {
    const container = document.createElement("div");
    render(
      renderChatControls(
        createProps({
          quota: {
            modelAuthStatusResult: {
              ts: Date.now(),
              providers: [
                {
                  provider: "openai",
                  displayName: "Codex",
                  status: "ok",
                  profiles: [{ profileId: "codex", type: "oauth", status: "ok" }],
                  usage: { windows: [{ label: "Week", usedPercent: 72 }] },
                },
              ],
            },
          },
        }),
      ),
      container,
    );

    expect(Array.from(container.children).map((node) => node.className)).toEqual([
      "chat-composer-model-control",
      "chat-controls__quota chat-controls__quota--ok",
      "chat-settings-popover-wrapper",
    ]);
    expect(
      container.querySelector(".chat-controls__quota")?.textContent?.replace(/\s+/g, " ").trim(),
    ).toBe("Usage Remaining 28%");
  });
});
