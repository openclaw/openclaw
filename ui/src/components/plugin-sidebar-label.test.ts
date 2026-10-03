import { describe, expect, it, vi } from "vitest";

const translations: Record<string, string> = {
  "tabs.logs": "日志",
  "tabs.workboard": "工作看板",
};

vi.mock("../i18n/index.ts", () => ({
  t: (key: string) => translations[key] ?? key,
}));

const { pluginSidebarLabel } = await import("./plugin-sidebar-label.ts");

describe("pluginSidebarLabel", () => {
  it("localizes the built-in Logbook and Workboard navigation labels", () => {
    expect(pluginSidebarLabel("logbook", "logbook", "Logbook")).toBe("日志");
    expect(pluginSidebarLabel("workboard", "workboard", "Workboard")).toBe("工作看板");
  });

  it("preserves labels for other plugin contributions", () => {
    expect(pluginSidebarLabel("example", "home", "Example")).toBe("Example");
  });
});
