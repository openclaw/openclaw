import "../styles.css";
import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { renderConfig, resetConfigViewStateForTests } from "./views/config.ts";

function baseProps() {
  resetConfigViewStateForTests();
  return {
    raw: "{\n}\n",
    originalRaw: "{\n}\n",
    valid: true,
    issues: [],
    loading: false,
    saving: false,
    applying: false,
    updating: false,
    connected: true,
    schema: {
      type: "object",
      properties: {
        gateway: { type: "object", properties: {} },
        communication: {
          type: "object",
          properties: {
            webhookBaseUrl: {
              type: "string",
              title: "Webhook Base URL",
            },
          },
        },
      },
    },
    schemaLoading: false,
    uiHints: {},
    formMode: "form" as const,
    showModeToggle: true,
    formValue: {},
    originalValue: {},
    searchQuery: "",
    activeSection: "communication",
    activeSubsection: null,
    streamMode: false,
    onRawChange: vi.fn(),
    onFormModeChange: vi.fn(),
    onFormPatch: vi.fn(),
    onSearchChange: vi.fn(),
    onSectionChange: vi.fn(),
    onReload: vi.fn(),
    onSave: vi.fn(),
    onApply: vi.fn(),
    onUpdate: vi.fn(),
    onSubsectionChange: vi.fn(),
    version: "",
    theme: "claw" as const,
    themeMode: "system" as const,
    setTheme: vi.fn(),
    setThemeMode: vi.fn(),
    gatewayUrl: "",
    assistantName: "",
  };
}

describe("config layout width", () => {
  it("lets the main config pane span the available width instead of collapsing to a dead sidebar track", () => {
    const host = document.createElement("div");
    host.style.width = "1200px";
    document.body.append(host);

    render(renderConfig(baseProps()), host);

    const layout = host.querySelector<HTMLElement>(".config-layout");
    const main = host.querySelector<HTMLElement>(".config-main");
    const card = host.querySelector<HTMLElement>(".config-section-card");

    expect(layout).not.toBeNull();
    expect(main).not.toBeNull();
    expect(card).not.toBeNull();
    expect(getComputedStyle(layout!).display).toBe("grid");
    expect(main!.getBoundingClientRect().width).toBeGreaterThan(800);
    expect(card!.getBoundingClientRect().width).toBeGreaterThan(800);
  });

  it("lays out the search, tabs, and mode toggle as a real full-width top rail", () => {
    const host = document.createElement("div");
    host.style.width = "1200px";
    document.body.append(host);

    render(renderConfig(baseProps()), host);

    const topTabs = host.querySelector<HTMLElement>(".config-top-tabs");
    const scroller = host.querySelector<HTMLElement>(".config-top-tabs__scroller");

    expect(topTabs).not.toBeNull();
    expect(scroller).not.toBeNull();
    expect(getComputedStyle(topTabs!).display).toBe("grid");
    expect(getComputedStyle(scroller!).display).toBe("flex");
  });
});
