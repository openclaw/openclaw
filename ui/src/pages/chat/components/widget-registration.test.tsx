/* @vitest-environment jsdom */

import { expect, it, vi } from "vitest";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { ToolPreview } from "./widget-card-view.tsx";

const modules = vi.hoisted(() => ({
  canvas: Promise.withResolvers<void>(),
  mcp: Promise.withResolvers<void>(),
  canvasError: true,
}));

// mock-isolation: hold optional renderer downloads and fail the Canvas renderer at its boundary.
vi.mock("./canvas-widget-mount.tsx", async () => {
  await modules.canvas.promise;
  return {
    CanvasWidgetMount: () => {
      if (modules.canvasError) {
        throw new Error("Synthetic widget renderer failed");
      }
      return document.createElement("openclaw-canvas-widget-view");
    },
  };
});

// mock-isolation: MCP loading owns module readiness; the native host remains an adapter.
vi.mock("../../../components/mcp-app-view.tsx", async () => {
  await modules.mcp.promise;
  return {};
});

function mountWidget(kind: "canvas" | "mcp") {
  return mountSolid(() => (
    <ToolPreview
      preview={{
        kind: "canvas",
        surface: "assistant_message",
        render: "url",
        sandbox: "scripts",
        viewId: "synthetic-widget",
        url: "/__openclaw__/canvas/documents/synthetic-widget/index.html",
        ...(kind === "mcp" ? { mcpApp: { viewId: "synthetic-app" } } : {}),
      }}
      surface="chat_message"
      options={{ sessionKey: "agent:main:synthetic", rawText: "Synthetic details" }}
    />
  ));
}

it.each(["canvas", "mcp"] as const)(
  "keeps actions through %s loading, including Canvas failure and retry",
  async (kind) => {
    const { container, unmount } = mountWidget(kind);
    const actionButton = () =>
      container.querySelector<HTMLButtonElement>('button[aria-label="Widget actions"]');
    const host = kind === "canvas" ? "openclaw-canvas-widget-view" : "mcp-app-view";
    try {
      const actions = actionButton();
      expect(actions).toMatchObject({ disabled: false });
      expect(container.querySelector(host)).toBeNull();
      modules[kind].resolve();
      if (kind === "canvas") {
        await waitForSolid(() =>
          expect(container.querySelector('[role="alert"]')?.textContent).toContain(
            "Synthetic widget renderer failed",
          ),
        );
        expect(actionButton()).toBe(actions);
        expect(actions).toMatchObject({ disabled: false });
        modules.canvasError = false;
        container.querySelector<HTMLButtonElement>('[role="alert"] button')!.click();
      }
      await waitForSolid(() => expect(container.querySelector(host)).not.toBeNull());
      expect(container.querySelector('[role="alert"]')).toBeNull();
      expect(actionButton()).toBe(actions);
    } finally {
      modules[kind].resolve();
      unmount();
    }
  },
);
