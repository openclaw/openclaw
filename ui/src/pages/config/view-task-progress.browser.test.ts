import { describe, expect, it, vi } from "vitest";
import "../../styles.css";
import { renderConfigView } from "./config-view.test-support.ts";

describe("chat progress preferences", () => {
  it("labels synced and browser-only Chat preferences per row", () => {
    const { container } = renderConfigView({
      activeSection: "__appearance__",
      includeSections: ["__appearance__"],
      composerHoldToRecord: true,
      setComposerHoldToRecord: vi.fn(),
    });
    const chat = container.querySelector<HTMLElement>("#settings-appearance-chat")!;
    const sectionDescription = Array.from(chat.children).find((child) =>
      child.classList.contains("settings-section__desc"),
    );
    const row = (title: string) =>
      Array.from(chat.querySelectorAll<HTMLElement>(".settings-row")).find(
        (candidate) =>
          candidate.querySelector(".settings-row__title")?.textContent?.trim() === title,
      );

    expect(sectionDescription).toBeUndefined();
    expect(row("Send shortcut")?.textContent).toContain("Synced across your devices");
    expect(row("Follow-ups while the agent is working")?.textContent).toContain(
      "Synced across your devices",
    );
    for (const title of [
      "Message width",
      "Show task progress cards",
      "Float task progress above the conversation",
      "Collapse task progress by default on desktop",
      "Open external sessions in",
      "Hold microphone button to start dictation",
    ]) {
      expect(row(title)?.textContent).toContain("Stored in this browser only");
      expect(row(title)?.textContent).not.toContain("Synced across your devices");
    }
  });

  it("keeps the side-panel preference while progress is hidden", () => {
    const setChatFloatTaskProgress = vi.fn();
    const { container } = renderConfigView({
      activeSection: "__appearance__",
      includeSections: ["__appearance__"],
      chatShowTaskProgress: false,
      chatFloatTaskProgress: true,
      setChatFloatTaskProgress,
    });
    const row = Array.from(container.querySelectorAll<HTMLElement>(".settings-row")).find(
      (candidate) =>
        candidate.querySelector(".settings-row__title")?.textContent?.trim() ===
        "Float task progress above the conversation",
    );
    const toggle = row?.querySelector<HTMLElement & { checked: boolean; disabled: boolean }>(
      "wa-switch",
    );
    expect(toggle?.checked).toBe(true);
    expect(toggle?.disabled).toBe(true);
    row?.click();
    expect(setChatFloatTaskProgress).not.toHaveBeenCalled();
  });

  it("renders task progress auto-collapse off by default and enables it from Chat settings", () => {
    const setChatCollapseTaskProgress = vi.fn();
    const { container } = renderConfigView({
      activeSection: "__appearance__",
      includeSections: ["__appearance__"],
      chatCollapseTaskProgress: false,
      setChatCollapseTaskProgress,
    });
    const row = Array.from(container.querySelectorAll<HTMLElement>(".settings-row")).find(
      (candidate) =>
        candidate.querySelector(".settings-row__title")?.textContent?.trim() ===
        "Collapse task progress by default on desktop",
    );
    const toggle = row?.querySelector<HTMLElement & { checked: boolean }>("wa-switch");

    expect(toggle?.checked).toBe(false);
    row?.click();
    expect(setChatCollapseTaskProgress).toHaveBeenCalledWith(true);
    expect(row?.textContent).not.toContain("Using default:");
    expect(row?.textContent).toContain("Stored in this browser only");
  });
});
