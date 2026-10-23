/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import * as lazyElements from "../../../app/lazy-custom-element.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { ToolPreview } from "./widget-card-view.tsx";

afterEach(() => vi.restoreAllMocks());

describe("widget registration feedback", () => {
  it.each([
    ["canvas", "openclaw-canvas-widget-view"],
    ["mcp", "mcp-app-view"],
  ] as const)(
    "keeps the %s host and actions through a failed registration and retry",
    async (kind, tag) => {
      const first = Promise.withResolvers<void>();
      const retry = Promise.withResolvers<void>();
      const registration = vi
        .spyOn(lazyElements, "ensureCustomElementDefined")
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(retry.promise);
      const mounted = mountSolid(() => (
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
      try {
        await waitForSolid(() => expect(mounted.container.querySelector(tag)).not.toBeNull());
        const host = mounted.container.querySelector(tag);
        const actions = mounted.container.querySelector('button[aria-label="Widget actions"]');
        expect(actions).not.toBeNull();
        first.reject(new Error("Synthetic widget download failed"));
        await waitForSolid(() =>
          expect(mounted.container.querySelector('[role="alert"]')?.textContent).toContain(
            "Synthetic widget download failed",
          ),
        );
        expect(mounted.container.querySelector(tag)).toBe(host);
        expect(mounted.container.querySelector('button[aria-label="Widget actions"]')).toBe(
          actions,
        );
        mounted.container.querySelector<HTMLButtonElement>('[role="alert"] button')!.click();
        await waitForSolid(() => expect(registration).toHaveBeenCalledTimes(2));
        expect(mounted.container.querySelector(tag)).toBe(host);
        retry.resolve();
        await waitForSolid(() =>
          expect(mounted.container.querySelector('[role="alert"]')).toBeNull(),
        );
        expect(mounted.container.querySelector(tag)).toBe(host);
        expect(mounted.container.querySelector('button[aria-label="Widget actions"]')).toBe(
          actions,
        );
      } finally {
        mounted.unmount();
      }
    },
  );
});
