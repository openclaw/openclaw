import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppViewState } from "../../ui/app-view-state.ts";
import { renderQuickSettings } from "../../ui/views/config-quick.ts";
import { renderConfigRoute } from "./page.ts";

vi.mock("../../components/settings-workspace.ts", () => ({
  renderSettingsWorkspace: (_state: unknown, content: unknown) => content,
}));

vi.mock("../../ui/views/config.ts", () => ({
  renderConfig: vi.fn(() => undefined),
}));

vi.mock("../../ui/views/config-quick.ts", () => ({
  renderQuickSettings: vi.fn(() => undefined),
}));

describe("config quick settings route", () => {
  beforeEach(() => {
    vi.mocked(renderQuickSettings).mockClear();
  });

  it("passes the saved config baseline and effective fast mode", () => {
    const savedConfig = { agents: { defaults: { fastMode: false } } };
    const draftConfig = { agents: { defaults: { fastMode: true } } };
    const state = {
      basePath: "",
      sessionKey: "agent:main:main",
      settings: { customTheme: null, borderRadius: 12, textScale: 100 },
      theme: "claw",
      themeMode: "system",
      configSettingsMode: "quick",
      configFormMode: "form",
      configForm: draftConfig,
      configSnapshot: { config: savedConfig, hash: "saved" },
      configIssues: [],
      sessionsResult: {
        sessions: [
          {
            key: "agent:main:main",
            effectiveFastMode: "auto",
            fastMode: false,
          },
        ],
      },
    } as unknown as AppViewState;

    renderConfigRoute(state, "config", vi.fn());

    const props = vi.mocked(renderQuickSettings).mock.calls[0]?.[0];
    expect(props?.configObject).toBe(draftConfig);
    expect(props?.savedConfigObject).toBe(savedConfig);
    expect(props?.fastMode).toBe("auto");
  });
});
