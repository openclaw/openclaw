/* @vitest-environment jsdom */

import { html, render } from "lit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppViewState } from "./app-view-state.ts";
import type { QuickSettingsProps } from "./views/config-quick.ts";

const quickSettingsProps = vi.hoisted(() => ({
  current: null as QuickSettingsProps | null,
}));
const localStorageValues = vi.hoisted(() => new Map<string, string>());

vi.mock("../local-storage.ts", () => ({
  getSafeLocalStorage: () => ({
    getItem: (key: string) => localStorageValues.get(key) ?? null,
    removeItem: (key: string) => localStorageValues.delete(key),
    setItem: (key: string, value: string) => localStorageValues.set(key, value),
  }),
  getSafeSessionStorage: () => null,
}));

vi.mock("./views/config-quick.ts", () => ({
  renderQuickSettings: (props: QuickSettingsProps) => {
    quickSettingsProps.current = props;
    return html`<div data-testid="quick-settings"></div>`;
  },
}));

vi.mock("./views/chat.ts", () => ({
  renderChat: () => html`<div data-testid="chat"></div>`,
}));

vi.mock("./icons.ts", () => ({
  icons: {},
}));

import { createAppViewState } from "./app-render.test-helpers.ts";
import { renderApp } from "./app-render.ts";
import { saveLocalAssistantIdentity } from "./storage.ts";

beforeEach(() => {
  localStorageValues.clear();
  quickSettingsProps.current = null;
});

describe("renderApp assistant avatar routing", () => {
  it("passes the browser-local assistant override to Quick Settings ahead of stale identity metadata", () => {
    const dataUrl = "data:image/png;base64,bG9jYWwtYXNzaXN0YW50";
    saveLocalAssistantIdentity({ avatar: dataUrl });

    renderApp(createAppViewState());

    expect(quickSettingsProps.current?.assistantAvatar).toBe(dataUrl);
    expect(quickSettingsProps.current?.assistantAvatarUrl).toBe(dataUrl);
    expect(quickSettingsProps.current?.assistantAvatarSource).toBe(dataUrl);
    expect(quickSettingsProps.current?.assistantAvatarStatus).toBe("data");
    expect(quickSettingsProps.current?.assistantAvatarReason).toBeNull();
    expect(quickSettingsProps.current?.assistantAvatarOverride).toBe(dataUrl);
  });

  it("applies the configured chat message width as a shell CSS variable", () => {
    const container = document.createElement("div");

    render(
      renderApp(createAppViewState({ tab: "chat", chatMessageMaxWidth: "min(1280px, 82%)" })),
      container,
    );

    const shell = container.querySelector<HTMLElement>(".shell");
    expect(shell?.style.getPropertyValue("--chat-message-max-width")).toBe("min(1280px, 82%)");
  });

  it("passes security quick setting fields to Quick Settings", () => {
    const state = createAppViewState({
      configForm: {
        browser: { enabled: false },
        tools: { profile: "messaging", exec: { security: "full" } },
        agents: { defaults: { exec: { security: "deny" } } },
      },
    });

    renderApp(state);

    expect(quickSettingsProps.current?.security.execPolicy).toBe("full");
    expect(quickSettingsProps.current?.security.browserEnabled).toBe(false);
    expect(quickSettingsProps.current?.security.toolProfile).toBe("messaging");

    quickSettingsProps.current?.onBrowserEnabledToggle?.(true);
    quickSettingsProps.current?.onToolProfileChange?.("full");

    expect(state.configForm?.browser).toEqual({ enabled: true });
    const tools = state.configForm?.tools as
      | { profile?: string; exec?: { security?: string } }
      | undefined;
    expect(tools?.profile).toBe("full");
    expect(tools?.exec?.security).toBe("full");
  });

  it("renders stale cron state containing a job without a payload", () => {
    const container = document.createElement("div");

    render(
      renderApp(
        createAppViewState({
          cronJobs: [
            {
              id: "bad-missing-payload",
              name: "Broken",
              enabled: true,
              createdAtMs: 0,
              updatedAtMs: 0,
              schedule: { kind: "cron", expr: "0 9 * * *" },
              sessionTarget: "main",
              wakeMode: "next-heartbeat",
              payload: undefined,
            } as unknown as AppViewState["cronJobs"][number],
          ],
        }),
      ),
      container,
    );

    expect(container.querySelector(".shell")).toBeInstanceOf(HTMLElement);
  });
});
