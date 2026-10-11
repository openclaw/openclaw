import { expect, it } from "vitest";
import "./terminal-panel-registration.ts";

it.runIf("__vitest_browser__" in globalThis)(
  "shows the terminal canvas inside its active viewport",
  async () => {
    const panel = document.createElement("openclaw-terminal-panel");
    panel.available = true;
    document.body.append(panel);
    try {
      panel.handleToggleRequest(
        new CustomEvent("openclaw:terminal-toggle", { detail: { open: true } }),
      );
      await panel.updateComplete;
      const viewport = panel.querySelector("wa-tab-panel");
      expect(viewport).not.toBeNull();
      await viewport!.updateComplete;
      const canvas = document.createElement("canvas");
      canvas.width = 100;
      canvas.height = 50;
      viewport!.append(canvas);
      expect(canvas.checkVisibility()).toBe(true);
      expect(canvas.getBoundingClientRect().height).toBeGreaterThan(0);
    } finally {
      panel.remove();
    }
  },
);
