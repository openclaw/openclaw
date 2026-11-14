import { flush } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import type { ApplicationContext } from "../../app/context.ts";
import {
  createFrameOwner,
  grantedFrameWidgetFixture,
  mountBoardWidgetFrame,
} from "./board-widget-frame.test-support.tsx";
import "../../styles/base.css";
import "../../styles/board.css";
import "../../styles/chat/board.css";

const disposers: Array<() => void> = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) {
    dispose();
  }
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("keeps expanded sandboxOrigin guidance reachable in a compact card", async () => {
  vi.useFakeTimers();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("<p>Dashboard</p>")),
  );
  const body = document.createElement("div");
  body.className = "board-widget__body";
  body.style.cssText = "height: 80px; width: 320px";
  document.body.append(body);
  // No authored sandboxOrigin, and the sandbox frame never announces readiness.
  const widget = { ...grantedFrameWidgetFixture(), sandboxOrigin: undefined };
  const owner = createFrameOwner(() => widget, {
    connected: () => body.isConnected,
    context: () =>
      ({
        gateway: {
          snapshot: { phase: "connected" },
          connection: { gatewayUrl: "https://gateway.example" },
        },
      }) as ApplicationContext,
    resolveFrameUrl: () => () => "/widget?bt=ticket",
  });
  disposers.push(
    owner.subscribe(() => owner.update()),
    () => owner.disconnect(),
  );
  mountBoardWidgetFrame(owner, widget, body, disposers);
  owner.update();
  await vi.advanceTimersByTimeAsync(30_000);
  flush();
  const notice = body.querySelector<HTMLElement>('[role="status"]')!;
  notice.querySelector("details")!.open = true;
  const hint = notice.querySelector("details p")!;
  expect(hint.textContent).toContain("mcp.apps.sandboxOrigin");
  // The remedy is taller than the card; the reader must be able to scroll to it.
  expect(notice.scrollHeight).toBeGreaterThan(notice.clientHeight);
  expect(getComputedStyle(notice).overflowY).toBe("auto");
  expect(notice.getBoundingClientRect().bottom).toBeLessThanOrEqual(
    body.getBoundingClientRect().bottom,
  );
});
