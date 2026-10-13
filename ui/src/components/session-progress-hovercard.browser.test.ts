import { expect, it } from "vitest";
import type { SessionProgressHovercardProvider } from "./session-progress-hovercard.runtime.tsx";
import "./session-progress-hovercard.runtime.tsx";

it("settles an empty focused preview without remounting or starving the renderer", async () => {
  const host = document.createElement(
    "openclaw-session-progress-hovercard-provider",
  ) as SessionProgressHovercardProvider;
  const link = document.createElement("a");
  link.className = "markdown-session-link";
  link.dataset.sessionKey = "agent:main:empty-preview";
  link.href = "/chat/main/empty-preview";
  link.textContent = "Empty preview";
  host.append(link);
  let mounts = 0;
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node instanceof Element && node.matches(".session-progress-hovercard")) {
          mounts += 1;
        }
      }
    }
  });
  observer.observe(document.body, { childList: true });
  document.body.append(host);
  try {
    await host.updateComplete;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      link.focus();
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
      });
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
      });
      expect(mounts).toBe(attempt);
      expect(document.querySelector(".session-progress-hovercard")).toBeNull();
      expect(document.activeElement).toBe(link);
      link.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      link.blur();
    }
  } finally {
    observer.disconnect();
    host.remove();
    await host.updateComplete;
  }
});
