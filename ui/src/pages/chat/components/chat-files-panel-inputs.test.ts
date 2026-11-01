import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { PANEL_HOSTED_TABS_CHANGE_EVENT } from "../../../components/panel-hosted-tabs.ts";
import { i18n } from "../../../i18n/index.ts";
import "./chat-files-panel.tsx";

function mountPanel() {
  const panel = document.createElement("openclaw-chat-files-panel");
  panel.activeId = "notes";
  panel.previews = [
    { id: "notes", label: "notes.md", content: { kind: "markdown", content: "Notes" } },
  ];
  document.body.append(panel);
  return panel;
}

afterEach(() => document.body.replaceChildren());

describe("files panel native inputs", () => {
  it("announces one final hosted-tab snapshot for a native input batch", async () => {
    const panel = mountPanel();
    await panel.updateComplete;
    const changed = vi.fn(() => ({
      activeId: panel.activeHostedTabId,
      labels: panel.hostedTabs.map((tab) => tab.label),
    }));
    panel.addEventListener(PANEL_HOSTED_TABS_CHANGE_EVENT, changed);

    panel.previews = [
      { id: "draft", label: "draft.md", content: { kind: "markdown", content: "Draft" } },
    ];
    panel.activeId = "draft";
    await panel.updateComplete;

    expect(changed).toHaveBeenCalledOnce();
    expect(changed.mock.results[0]?.value).toEqual({ activeId: "draft", labels: ["draft.md"] });
  });

  it("drops detached notifications and publishes current tabs on reconnect", async () => {
    const panel = mountPanel();
    await panel.updateComplete;
    const changed = vi.fn();
    panel.addEventListener(PANEL_HOSTED_TABS_CHANGE_EVENT, changed);

    panel.activeId = null;
    panel.remove();
    await panel.updateComplete;
    expect(changed).not.toHaveBeenCalled();

    panel.previews = [
      { id: "latest", label: "latest.md", content: { kind: "markdown", content: "Latest" } },
    ];
    panel.activeId = "latest";
    await panel.updateComplete;
    expect(changed).not.toHaveBeenCalled();

    document.body.append(panel);
    await panel.updateComplete;
    expect(changed).toHaveBeenCalledOnce();
    expect(panel.activeHostedTabId).toBe("latest");
    expect(panel.hostedTabs.map((tab) => tab.label)).toEqual(["latest.md"]);
  });

  it("announces a translated browse tab without a native input change", async () => {
    const initialLocale = i18n.getLocale();
    onTestFinished(() => i18n.setLocale(initialLocale));
    await i18n.setLocale("en");
    const panel = mountPanel();
    panel.activeId = null;
    await panel.updateComplete;
    expect(panel.hostedTabs[0]?.label).toBe("Files");
    const changed = vi.fn(() => panel.hostedTabs[0]?.label);
    panel.addEventListener(PANEL_HOSTED_TABS_CHANGE_EVENT, changed);

    await i18n.setLocale("de");

    expect(changed).toHaveBeenCalledOnce();
    expect(changed.mock.results[0]?.value).toBe("Dateien");
    expect(panel.hostedActions.getAttribute("aria-label")).toBe("Dateien");
  });
});
