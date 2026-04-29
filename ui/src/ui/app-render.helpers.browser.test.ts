import { render } from "lit";
import { describe, expect, it } from "vitest";
import { t } from "../i18n/index.ts";
import { renderChatControls, renderChatMobileToggle } from "./app-render.helpers.ts";
import type { AppViewState } from "./app-view-state.ts";
import type { SessionsListResult } from "./types.ts";

type SessionRow = SessionsListResult["sessions"][number];

function row(overrides: Partial<SessionRow> & { key: string }): SessionRow {
  return { kind: "direct", updatedAt: 0, ...overrides };
}

function createState(overrides: Partial<AppViewState> = {}) {
  return {
    connected: true,
    chatLoading: false,
    onboarding: false,
    sessionKey: "main",
    sessionsHideCron: true,
    sessionsResult: {
      ts: 0,
      path: "",
      count: 0,
      defaults: { modelProvider: "openai", model: "gpt-5", contextTokens: null },
      sessions: [],
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

    const buttons = Array.from(
      container.querySelectorAll<HTMLButtonElement>(".chat-controls .btn--icon[data-tooltip]"),
    );

    expect(buttons).toHaveLength(5);

    const labels = buttons.map((button) => button.getAttribute("data-tooltip"));
    expect(labels).toEqual([
      t("chat.refreshTitle"),
      t("chat.thinkingToggle"),
      t("chat.toolCallsToggle"),
      t("chat.focusToggle"),
      t("chat.showCronSessions"),
    ]);

    for (const button of buttons) {
      expect(button.getAttribute("title")).toBe(button.getAttribute("data-tooltip"));
      expect(button.getAttribute("aria-label")).toBe(button.getAttribute("data-tooltip"));
    }
  });

  it("renders the cron session filter in the mobile dropdown controls", async () => {
    const state = createState({
      sessionsResult: {
        ts: 0,
        path: "",
        count: 2,
        defaults: { modelProvider: "openai", model: "gpt-5", contextTokens: null },
        sessions: [row({ key: "main" }), row({ key: "agent:main:cron:daily-briefing" })],
      },
    });
    const container = document.createElement("div");
    render(renderChatMobileToggle(state), container);
    await Promise.resolve();

    const buttons = Array.from(
      container.querySelectorAll<HTMLButtonElement>(".chat-controls__thinking .btn--icon"),
    );

    expect(buttons).toHaveLength(4);
    const cronButton = buttons.at(-1);
    expect(cronButton?.classList.contains("active")).toBe(true);
    expect(cronButton?.getAttribute("aria-pressed")).toBe("true");
    expect(cronButton?.getAttribute("title")).toBe(
      t("chat.showCronSessionsHidden", { count: "1" }),
    );

    cronButton?.click();

    expect(state.sessionsHideCron).toBe(false);
  });
});
