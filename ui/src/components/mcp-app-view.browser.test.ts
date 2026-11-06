import { expect, it } from "vitest";
import { mountView } from "./mcp-app-view.test-support.ts";

it("keeps inline MCP App reloads transparent without changing dashboard surfaces", async () => {
  async function readFrameBackground(boardSurface?: string) {
    const { container, view, unmount } = mountView({});
    try {
      // The old inline fallback must be visibly different from transparency.
      container.style.setProperty("--card", "rgb(90, 80, 70)");
      if (boardSurface) {
        container.style.setProperty("--board-surface", boardSurface);
      }
      await view.updateComplete;
      const mount = view.querySelector(".mount");
      if (!mount) {
        throw new Error("MCP App mount is missing");
      }
      const frame = document.createElement("iframe");
      mount.append(frame);
      return getComputedStyle(frame).backgroundColor;
    } finally {
      unmount();
    }
  }

  expect(await readFrameBackground("rgb(12, 34, 56)")).toBe("rgb(12, 34, 56)");
  expect(await readFrameBackground()).toBe("rgba(0, 0, 0, 0)");
});
