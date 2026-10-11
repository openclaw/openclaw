import { expect, it, onTestFinished, vi } from "vitest";
import { renderConfigView } from "./config-view.test-support.ts";

it("renders the external-link preference off by default and applies a personal change", () => {
  const onAppearanceChange = vi.fn();
  const { container } = renderConfigView({
    activeSection: "__appearance__",
    includeSections: ["__appearance__"],
    onAppearanceChange,
  });
  document.body.append(container);
  onTestFinished(() => container.remove());
  const row = Array.from(container.querySelectorAll<HTMLElement>(".settings-row")).find(
    (candidate) =>
      candidate.querySelector(".settings-row__title")?.textContent?.trim() ===
      "Open links outside OpenClaw",
  );
  const toggle = row?.querySelector<HTMLInputElement>(".settings-toggle__input");
  expect(toggle?.checked).toBe(false);
  expect(row?.textContent).toContain("Saved in this browser only.");
  row?.click();
  expect(onAppearanceChange).toHaveBeenCalledWith({ openLinksExternally: true });
});
