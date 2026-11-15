import { expect, it } from "vitest";
import startupStyles from "./chat/startup-layout.css?inline";

it("shows an initially open desktop conversation pane without an entrance fade", () => {
  const frame = document.createElement("iframe");
  frame.width = "1720";
  frame.height = "1515";
  document.body.append(frame);
  try {
    const document = frame.contentDocument!;
    const style = document.createElement("style");
    style.textContent = startupStyles;
    document.head.append(style);
    document.body.innerHTML = `
      <div class="sidebar-region sidebar-region--desktop sidebar-region--right sidebar-region--open sidebar-region--side-visible" style="height: 1400px; --side-panel-width: 320px; --rail-header-height: 48px; --space-1: 4px">
        <div class="sidebar-region__header" data-region-header="side">Conversation</div>
        <main class="sidebar-region__primary" data-region="side"><p>Cached reply</p></main>
      </div>`;
    const panes = document.querySelectorAll<HTMLElement>("[data-region-header], [data-region]");
    expect(panes).toHaveLength(2);
    for (const pane of panes) {
      expect(frame.contentWindow!.getComputedStyle(pane).opacity).toBe("1");
      expect(pane.clientHeight).toBeGreaterThan(0);
    }
  } finally {
    frame.remove();
  }
});
