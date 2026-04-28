import { render } from "lit";
import { describe, expect, it } from "vitest";
import { t } from "../i18n/index.ts";
import { renderChatControls, renderChatMobileToggle } from "./app-render.helpers.ts";
import type { AppViewState } from "./app-view-state.ts";
import { createDefaultSessionKindVisibility } from "./session-kind-filter.ts";

function createState(overrides: Partial<AppViewState> = {}) {
  return {
    connected: true,
    chatLoading: false,
    onboarding: false,
    sessionKey: "main",
    sessionsVisibleKinds: createDefaultSessionKindVisibility(),
    sessionsResult: {
      ts: 0,
      path: "",
      count: 0,
      defaults: { modelProvider: "openai", model: "gpt-5", contextTokens: null },
      sessions: [{ key: "agent:main:cron:nightly", kind: "direct", updatedAt: 1 }],
    },
    settings: {
      gatewayUrl: "",
      token: "",
      locale: "en",
      sessionKey: "main",
      lastActiveSessionKey: "main",
      theme: "claw",
      themeMode: "dark",
      splitRatio: 0.6,
      navWidth: 280,
      navCollapsed: false,
      navGroupsCollapsed: {},
      borderRadius: 50,
      chatFocusMode: false,
      chatShowThinking: false,
      chatShowToolCalls: true,
    },
    applySettings: () => undefined,
    ...overrides,
  } as unknown as AppViewState;
}

describe("chat header controls (browser)", () => {
  it("renders explicit hover tooltip metadata for the top-right action buttons", async () => {
    const container = document.createElement("div");
    render(renderChatControls(createState()), container);
    await Promise.resolve();

    const controls = Array.from(
      container.querySelectorAll<HTMLElement>(".chat-controls .btn--icon[data-tooltip]"),
    );

    expect(controls).toHaveLength(5);

    const labels = controls.map((button) => button.getAttribute("data-tooltip"));
    expect(labels).toEqual([
      t("chat.refreshTitle"),
      t("chat.thinkingToggle"),
      t("chat.toolCallsToggle"),
      t("chat.focusToggle"),
      "Filter sessions (1 hidden)",
    ]);

    for (const button of controls) {
      expect(button.getAttribute("title")).toBe(button.getAttribute("data-tooltip"));
      expect(button.getAttribute("aria-label")).toBe(button.getAttribute("data-tooltip"));
    }
  });

  it("renders the same session kind filter in the mobile chat settings dropdown", async () => {
    const container = document.createElement("div");
    render(renderChatMobileToggle(createState()), container);
    await Promise.resolve();

    const labels = Array.from(
      container.querySelectorAll<HTMLLabelElement>(".session-kind-filter__item"),
    ).map((label) => label.textContent?.replace(/\s+/g, " ").trim());

    expect(labels).toEqual(["Main/direct", "Groups", "Subagents", "Dreaming", "Cron 1", "Other"]);
  });
});
