/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
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
        title: "Synthetic widget",
        viewId: "synthetic-widget",
        url: "/__openclaw__/canvas/documents/synthetic-widget/index.html",
        ...(kind === "mcp" ? { mcpApp: { viewId: "synthetic-app" } } : {}),
      }}
      surface="chat_message"
      options={{ sessionKey: "agent:main:synthetic", rawText: "Synthetic details" }}
    />
  ));
}

const actionButton = (container: HTMLElement) =>
  container.querySelector<HTMLButtonElement>('button[aria-label="Widget actions"]');

describe("lazy widget feedback", () => {
  it("keeps actions through a Canvas download, renderer failure, and retry", async () => {
    const mounted = mountWidget("canvas");
    try {
      const actions = actionButton(mounted.container);
      expect(actions).not.toBeNull();
      expect(actions?.disabled).toBe(false);
      expect(mounted.container.querySelector("openclaw-canvas-widget-view")).toBeNull();

      modules.canvas.resolve();
      await waitForSolid(() =>
        expect(mounted.container.querySelector('[role="alert"]')?.textContent).toContain(
          "Synthetic widget renderer failed",
        ),
      );
      expect(actionButton(mounted.container)).toBe(actions);
      expect(actions?.disabled).toBe(false);

      modules.canvasError = false;
      mounted.container.querySelector<HTMLButtonElement>('[role="alert"] button')!.click();
      await waitForSolid(() =>
        expect(mounted.container.querySelector("openclaw-canvas-widget-view")).not.toBeNull(),
      );
      expect(mounted.container.querySelector('[role="alert"]')).toBeNull();
      expect(actionButton(mounted.container)).toBe(actions);
    } finally {
      modules.canvas.resolve();
      mounted.unmount();
    }
  });

  it("keeps actions available while the MCP module loads and mounts its host", async () => {
    const mounted = mountWidget("mcp");
    try {
      const actions = actionButton(mounted.container);
      expect(actions).not.toBeNull();
      expect(actions?.disabled).toBe(false);
      expect(mounted.container.querySelector("mcp-app-view")).toBeNull();

      modules.mcp.resolve();
      await waitForSolid(() =>
        expect(mounted.container.querySelector("mcp-app-view")).not.toBeNull(),
      );
      expect(mounted.container.querySelector('[role="alert"]')).toBeNull();
      expect(actionButton(mounted.container)).toBe(actions);
    } finally {
      modules.mcp.resolve();
      mounted.unmount();
    }
  });
});
