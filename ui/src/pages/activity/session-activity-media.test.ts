/* @vitest-environment jsdom */
import { html, render, type LitElement } from "lit";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ArtifactsListResult } from "../../../../packages/gateway-protocol/src/index.ts";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import {
  createContext,
  createGatewayHarness,
  createSessions,
} from "../../test-helpers/app-sidebar.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import "./session-activity-media.ts";

const observers = new Map<Element, (visible: boolean) => void>();
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      private target?: Element;
      constructor(private callback: IntersectionObserverCallback) {}
      observe(target: Element) {
        this.target = target;
        observers.set(target, (visible) =>
          this.callback(
            [{ target, isIntersecting: visible } as IntersectionObserverEntry],
            this as unknown as IntersectionObserver,
          ),
        );
      }
      disconnect() {
        if (this.target) {
          observers.delete(this.target);
        }
      }
    },
  );
  container = document.createElement("div");
  document.body.append(container);
});

afterEach(() => {
  render(null, container);
  container.remove();
  observers.clear();
  vi.unstubAllGlobals();
});

function images(label: string, count = 4): ArtifactsListResult {
  return {
    artifacts: Array.from({ length: count }, (_, index) => ({
      id: `${label}-${index}`,
      type: "image",
      title: `${label}-${index}`,
      download: { mode: "url" },
      image: { url: `https://images.example.test/${label}-${index}.png` },
    })),
  };
}

it("waits for the viewport, limits concurrent discovery, and opens four thumbnails in the shared viewer", async () => {
  const pending = Array.from({ length: 4 }, () => createDeferred<ArtifactsListResult>());
  const request = vi.fn(async () => pending[request.mock.calls.length - 1]!.promise);
  const harness = createGatewayHarness(createTestGatewayClient(request));
  const context = createContext(harness.gateway, createSessions("main", []));
  render(
    html`${[0, 1, 2, 3].map((index) => html`<openclaw-activity-session-media .context=${context} .sessionKey=${`agent:main:images-${index}`} agentId="main"></openclaw-activity-session-media>`)}`,
    container,
  );
  await vi.waitFor(() => expect(observers.size).toBe(4));
  expect(request).not.toHaveBeenCalled();
  const rows = [...container.querySelectorAll("openclaw-activity-session-media")];
  for (const row of rows.slice(0, 3)) {
    observers.get(row)?.(true);
  }
  await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
  expect(request).toHaveBeenCalledWith("artifacts.list", {
    sessionKey: "agent:main:images-0",
    agentId: "main",
    type: "image",
    limit: 4,
  });
  pending[0]!.resolve(images("first"));
  await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(3));
  pending[1]!.resolve(images("second"));
  pending[2]!.resolve(images("third"));
  await vi.waitFor(() => expect(rows[0]!.querySelectorAll(".chat-message-image")).toHaveLength(4));
  expect(rows[3]!.querySelectorAll("img")).toHaveLength(0);
  rows[0]!.querySelector<HTMLButtonElement>(".chat-message-image-button")!.click();
  await vi.waitFor(() =>
    expect(rows[0]!.querySelector("openclaw-image-lightbox")?.getAttribute("src")).toBe(
      "https://images.example.test/first-0.png",
    ),
  );
  const first = rows[0] as LitElement & { revision: number; session?: GatewaySessionRow };
  const lightbox = first.querySelector("openclaw-image-lightbox");
  first.revision = 1;
  try {
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(4));
    expect(first.querySelectorAll(".chat-message-image")).toHaveLength(4);
    expect(first.querySelector("img")?.getAttribute("alt")).toBe("first-0");
    expect(first.querySelector("openclaw-image-lightbox")).toBe(lightbox);
  } finally {
    pending[3]!.resolve(images("refreshed"));
  }
  await vi.waitFor(() =>
    expect(first.querySelector("img")?.getAttribute("alt")).toBe("refreshed-0"),
  );
  expect(first.querySelector("openclaw-image-lightbox")).toBe(lightbox);
  expect(lightbox?.getAttribute("src")).toBe("https://images.example.test/first-0.png");
  first.session = { key: "agent:main:images-0", kind: "direct", permissionMode: "workspace" };
  await vi.waitFor(() => expect(first.querySelector("openclaw-image-lightbox")).toBeNull());
});

it.each(["initial discovery", "revision refresh"])(
  "preserves a usable gallery through %s failure and retry",
  async (phase) => {
    const initialDiscovery = phase === "initial discovery";
    const failedRefresh = createDeferred<ArtifactsListResult>();
    const retry = createDeferred<ArtifactsListResult>();
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        ...images("original", 1),
        ...(initialDiscovery ? { nextCursor: "older" } : {}),
      })
      .mockReturnValueOnce(failedRefresh.promise)
      .mockReturnValueOnce(retry.promise);
    const harness = createGatewayHarness(createTestGatewayClient(request));
    const context = createContext(harness.gateway, createSessions("main", []));
    render(
      html`<openclaw-activity-session-media
        .context=${context}
        sessionKey="agent:main:images"
        agentId="main"
      ></openclaw-activity-session-media>`,
      container,
    );
    const row = container.querySelector<LitElement & { revision: number }>(
      "openclaw-activity-session-media",
    )!;
    await vi.waitFor(() => expect(observers.has(row)).toBe(true));
    observers.get(row)?.(true);
    if (!initialDiscovery) {
      await vi.waitFor(() =>
        expect(row.querySelector("img")?.getAttribute("alt")).toBe("original-0"),
      );
      row.revision = 1;
    }
    try {
      await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
      failedRefresh.reject(new Error("Unavailable"));
      await vi.waitFor(() => expect(row.querySelector('[role="status"]')).not.toBeNull());
      expect(row.querySelector("img")?.getAttribute("alt")).toBe("original-0");
      const retryButton = [...row.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent?.trim() === "Retry",
      );
      expect(retryButton).toBeDefined();
      retryButton!.click();
      await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(3));
      expect(row.querySelector("img")?.getAttribute("alt")).toBe("original-0");
      retry.resolve(images("fresh", 1));
      await vi.waitFor(() => expect(row.querySelector("img")?.getAttribute("alt")).toBe("fresh-0"));
      expect(row.querySelector('[role="status"]')).toBeNull();
      request.mockResolvedValueOnce({ artifacts: [] });
      row.revision = initialDiscovery ? 1 : 2;
      await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(4));
      await vi.waitFor(() => expect(row.querySelector("img")).toBeNull());
    } finally {
      failedRefresh.resolve(images("released", 1));
      retry.resolve(images("released", 1));
    }
  },
);

it.each(["session", "agent"] as const)(
  "retires the previous gallery and pending refresh when its %s changes",
  async (change) => {
    const stale = createDeferred<ArtifactsListResult>();
    const fresh = createDeferred<ArtifactsListResult>();
    const request = vi
      .fn()
      .mockResolvedValueOnce(images("original", 1))
      .mockReturnValueOnce(stale.promise)
      .mockReturnValueOnce(fresh.promise);
    const harness = createGatewayHarness(createTestGatewayClient(request));
    const context = createContext(harness.gateway, createSessions("main", []));
    render(
      html`<openclaw-activity-session-media
        .context=${context}
        sessionKey="agent:main:images"
        agentId="main"
        .session=${{ key: "agent:main:images", kind: "direct", sessionId: "original" }}
      ></openclaw-activity-session-media>`,
      container,
    );
    const row = container.querySelector<
      LitElement & { revision: number; session?: GatewaySessionRow; agentId: string }
    >("openclaw-activity-session-media")!;
    await vi.waitFor(() => expect(observers.has(row)).toBe(true));
    observers.get(row)?.(true);
    await vi.waitFor(() =>
      expect(row.querySelector("img")?.getAttribute("alt")).toBe("original-0"),
    );
    row.revision = 1;
    try {
      await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
      if (change === "session") {
        row.session = { key: "agent:main:images", kind: "direct", sessionId: "reset" };
      } else {
        row.agentId = "other";
      }
      await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(3));
      expect(row.querySelector("img")).toBeNull();
      stale.resolve(images("stale", 1));
      await row.updateComplete;
      expect(row.querySelector("img")).toBeNull();
      fresh.resolve(images("fresh", 1));
      await vi.waitFor(() => expect(row.querySelector("img")?.getAttribute("alt")).toBe("fresh-0"));
    } finally {
      stale.resolve(images("released", 1));
      fresh.resolve(images("released", 1));
    }
  },
);

it("retires old connection results and media when the same row reconnects", async () => {
  const old = createDeferred<ArtifactsListResult>();
  const oldRequest = vi.fn(() => old.promise);
  const harness = createGatewayHarness(createTestGatewayClient(oldRequest));
  const context = createContext(harness.gateway, createSessions("main", []));
  render(
    html`<openclaw-activity-session-media
      .context=${context}
      sessionKey="agent:main:images"
      agentId="main"
    ></openclaw-activity-session-media>`,
    container,
  );
  const row = container.querySelector("openclaw-activity-session-media")!;
  await vi.waitFor(() => expect(observers.has(row)).toBe(true));
  observers.get(row)?.(true);
  await vi.waitFor(() => expect(oldRequest).toHaveBeenCalledTimes(1));
  const freshRequest = vi.fn(async () => images("fresh", 1));
  harness.publish({ client: createTestGatewayClient(freshRequest) });
  await vi.waitFor(() => expect(row.querySelector("img")?.getAttribute("alt")).toBe("fresh-0"));
  old.resolve(images("stale"));
  await vi.waitFor(() => expect(row.querySelectorAll("img")).toHaveLength(1));
  expect(row.querySelector("img")?.getAttribute("alt")).toBe("fresh-0");
  row.querySelector<HTMLButtonElement>(".chat-message-image-button")!.click();
  await vi.waitFor(() => expect(row.querySelector("openclaw-image-lightbox")).not.toBeNull());
  harness.publish({ phase: "offline" });
  await vi.waitFor(() => expect(row.querySelector("img")).toBeNull());
  expect(row.querySelector("openclaw-image-lightbox")).toBeNull();
});

it("coalesces queued revisions without moving the session behind later arrivals", async () => {
  const pending = Array.from({ length: 4 }, () => createDeferred<ArtifactsListResult>());
  const request = vi.fn(async () => pending[request.mock.calls.length - 1]!.promise);
  const harness = createGatewayHarness(createTestGatewayClient(request));
  const context = createContext(harness.gateway, createSessions("main", []));
  const show = (revision: number) =>
    render(
      html`${[0, 1, 2, 3].map((index) => html`<openclaw-activity-session-media .context=${context} .sessionKey=${`agent:main:queue-${index}`} agentId="main" .revision=${index === 2 ? revision : 0}></openclaw-activity-session-media>`)}`,
      container,
    );
  show(1);
  await vi.waitFor(() => expect(observers.size).toBe(4));
  for (const notify of observers.values()) {
    notify(true);
  }
  await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
  show(2);
  await Promise.all(
    [...container.querySelectorAll<LitElement>("openclaw-activity-session-media")].map(
      (row) => row.updateComplete,
    ),
  );
  pending[0]!.resolve(images("queue-0"));
  await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(3));
  expect(request.mock.calls[2]).toEqual([
    "artifacts.list",
    { sessionKey: "agent:main:queue-2", agentId: "main", type: "image", limit: 4 },
  ]);
  pending[1]!.resolve(images("queue-1"));
  pending[2]!.resolve(images("queue-2"));
  await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(4));
  pending[3]!.resolve(images("queue-3"));
  await vi.waitFor(() => expect(container.querySelectorAll("img")).toHaveLength(16));
});
