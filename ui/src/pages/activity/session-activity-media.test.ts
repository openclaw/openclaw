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
        // These fixtures place thumbnails inside the explicitly admitted row.
        queueMicrotask(() => {
          if (target.matches(".chat-image-frame")) {
            observers.get(target)?.(true);
          }
        });
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
      expect(retryButton?.closest(".activity-feed__note")?.parentElement).toBe(
        row.querySelector(".activity-feed__media"),
      );
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

it.each([
  { count: 3, cursor: true, error: false },
  { count: 0, cursor: true, error: false },
  { count: 0, cursor: false, error: true },
  { count: 0, cursor: false, error: false },
])(
  "keeps image discovery feedback inside its media inset (%j)",
  async ({ count, cursor, error }) => {
    vi.useFakeTimers();
    const continued = createDeferred<ArtifactsListResult>();
    try {
      const result: ArtifactsListResult = {
        ...images("preview", count),
        ...(cursor ? { nextCursor: "older" } : {}),
      };
      const request = vi.fn(async () => {
        if (error) {
          throw new Error("Image discovery failed");
        }
        return result;
      });
      const harness = createGatewayHarness(createTestGatewayClient(request));
      const context = createContext(harness.gateway, createSessions("main", []));
      render(
        html`<openclaw-activity-session-media
          .context=${context}
          sessionKey="agent:main:preview"
          agentId="main"
        ></openclaw-activity-session-media>`,
        container,
      );
      const row = container.querySelector<LitElement>("openclaw-activity-session-media")!;
      await row.updateComplete;
      observers.get(row)?.(true);
      await vi.advanceTimersByTimeAsync(0);
      await row.updateComplete;

      const media = row.querySelector(".activity-feed__media");
      expect(Boolean(media)).toBe(count > 0 || cursor || error);
      expect(row.querySelectorAll(".chat-image-frame")).toHaveLength(count);
      const note = row.querySelector(".activity-feed__note");
      expect(Boolean(note)).toBe(error || (count === 0 && cursor));
      if (note) {
        expect(note.parentElement).toBe(media);
      }
      if (error) {
        expect(note?.querySelector('[role="status"]')?.textContent).toBe("Couldn't load images");
        expect(note?.querySelector("button")?.textContent?.trim()).toBe("Retry");
      }
      const action = row.querySelector<HTMLButtonElement>(".activity-feed__note-action");
      expect(action?.classList.contains("btn") ?? false).toBe(false);
      if (cursor && !error) {
        expect(action?.textContent?.trim()).toBe("Older images");
        expect(action?.parentElement).toBe(
          count ? media?.querySelector(".chat-message-images") : note,
        );
        expect(action?.parentElement?.lastElementChild).toBe(action);
        request.mockReturnValueOnce(continued.promise);
        action!.click();
        await row.updateComplete;
        expect(action!.disabled).toBe(true);
        expect(action!.textContent?.trim()).toBe("Loading…");
        continued.resolve(images("finished"));
        await vi.advanceTimersByTimeAsync(0);
        await row.updateComplete;
        expect(row.querySelector(".activity-feed__note-action")).toBeNull();
      }
    } finally {
      continued.resolve({ artifacts: [] });
      vi.useRealTimers();
    }
  },
);

it.each([
  { count: 1, error: false },
  { count: 0, error: false },
  { count: 1, error: true },
])(
  "keeps settled media DOM unchanged during revision revalidation (%j)",
  async ({ count, error }) => {
    vi.useFakeTimers();
    const refresh = createDeferred<ArtifactsListResult>();
    const older = createDeferred<ArtifactsListResult>();
    try {
      const request = vi
        .fn()
        .mockResolvedValue({ ...images("settled", count), nextCursor: "older" });
      if (error) {
        request
          .mockResolvedValueOnce({ ...images("settled", count), nextCursor: "older" })
          .mockRejectedValueOnce(new Error("Unavailable"));
      }
      const harness = createGatewayHarness(createTestGatewayClient(request));
      const context = createContext(harness.gateway, createSessions("main", []));
      render(
        html`<openclaw-activity-session-media
          .context=${context}
          sessionKey="agent:main:stable"
          agentId="main"
        ></openclaw-activity-session-media>`,
        container,
      );
      const row = container.querySelector<LitElement & { revision: number }>(
        "openclaw-activity-session-media",
      )!;
      await row.updateComplete;
      observers.get(row)?.(true);
      await vi.advanceTimersByTimeAsync(0);
      await row.updateComplete;
      const media = row.querySelector(".activity-feed__media")!;
      const nodes = [...media.querySelectorAll("*")];
      const markup = media.innerHTML;
      expect(row.querySelectorAll(".chat-image-frame")).toHaveLength(count);
      expect(media.textContent).toContain(error ? "Couldn't load images" : "Older images");
      const settledCalls = request.mock.calls.length;
      request.mockReturnValueOnce(refresh.promise);
      row.revision++;
      await row.updateComplete;
      expect(request).toHaveBeenCalledTimes(settledCalls + 1);
      expect(row.querySelector(".activity-feed__media")).toBe(media);
      expect(media.innerHTML).toBe(markup);
      for (const [index, node] of [...media.querySelectorAll("*")].entries()) {
        expect(node).toBe(nodes[index]);
      }
      expect(media.querySelector<HTMLButtonElement>(".activity-feed__note-action")?.disabled).toBe(
        false,
      );
      if (!error) {
        request.mockReturnValueOnce(older.promise);
        const button = media.querySelector<HTMLButtonElement>(".activity-feed__note-action")!;
        button.click();
        await row.updateComplete;
        expect(request).toHaveBeenLastCalledWith("artifacts.list", {
          sessionKey: "agent:main:stable",
          agentId: "main",
          type: "image",
          limit: 4 - count,
          cursor: "older",
        });
        expect(button.disabled).toBe(true);
        expect(button.textContent?.trim()).toBe("Loading…");
        older.resolve(images("older", 1));
        await vi.advanceTimersByTimeAsync(0);
        await row.updateComplete;
        expect(row.querySelectorAll(".chat-image-frame")).toHaveLength(count + 1);
      }
      refresh.resolve(images("replacement"));
      await vi.advanceTimersByTimeAsync(0);
      await row.updateComplete;
      expect(row.querySelectorAll(".chat-image-frame")).toHaveLength(4);
      expect(row.querySelector("img")?.getAttribute("alt")).toBe("replacement-0");
      expect(row.querySelector(".activity-feed__note-action")).toBeNull();
      expect(row.querySelector(".activity-feed__note")).toBeNull();
    } finally {
      refresh.resolve({ artifacts: [] });
      older.resolve({ artifacts: [] });
      vi.useRealTimers();
    }
  },
);

it("downloads reference-only images through the shared inline bytes path with their agent", async () => {
  vi.useFakeTimers();
  try {
    const artifact = {
      id: "reference-image",
      type: "image",
      title: "Inline screenshot",
      mimeType: "image/png",
      download: { mode: "bytes" },
    };
    const request = vi.fn(async (method: string) =>
      method === "artifacts.list"
        ? { artifacts: [artifact, artifact] }
        : { artifact, encoding: "base64", data: "cG5n" },
    );
    const harness = createGatewayHarness(createTestGatewayClient(request));
    const context = createContext(harness.gateway, createSessions("main", []));
    render(
      html`<openclaw-activity-session-media
        .context=${context}
        sessionKey="global"
        agentId="work"
      ></openclaw-activity-session-media>`,
      container,
    );
    const row = container.querySelector<LitElement>("openclaw-activity-session-media")!;
    await row.updateComplete;
    observers.get(row)?.(true);
    await vi.advanceTimersByTimeAsync(0);
    await row.updateComplete;
    expect(request).toHaveBeenCalledWith(
      "artifacts.download",
      {
        sessionKey: "global",
        agentId: "work",
        artifactId: "reference-image",
      },
      { timeoutMs: 30_000 },
    );
    expect(row.querySelectorAll("img")).toHaveLength(1);
    const imageSource = row.querySelector("img")!.src;
    expect(imageSource).toMatch(/^blob:/);
    const downloaded = await fetch(imageSource);
    expect(downloaded.headers.get("content-type")).toBe("image/png");
    expect(await downloaded.text()).toBe("png");
    expect(row.querySelector("img")?.getAttribute("alt")).toBe("Inline screenshot");
  } finally {
    vi.useRealTimers();
  }
});

it("keeps queued pagination separate from background revalidation", async () => {
  vi.useFakeTimers();
  const blockers = [createDeferred<ArtifactsListResult>(), createDeferred<ArtifactsListResult>()];
  const refresh = createDeferred<ArtifactsListResult>();
  const older = createDeferred<ArtifactsListResult>();
  try {
    let settled = false;
    const request = vi.fn(async (_method: string, params?: unknown) => {
      const { sessionKey, cursor } = params as { sessionKey: string; cursor?: string };
      if (sessionKey === "target") {
        return settled
          ? cursor
            ? older.promise
            : refresh.promise
          : { ...images("queued", 1), nextCursor: "older" };
      }
      return blockers[Number(sessionKey)]!.promise;
    });
    const harness = createGatewayHarness(createTestGatewayClient(request));
    const context = createContext(harness.gateway, createSessions("main", []));
    render(
      html`${["target", "0", "1"].map((sessionKey) => html`<openclaw-activity-session-media .context=${context} .sessionKey=${sessionKey} agentId="main"></openclaw-activity-session-media>`)}`,
      container,
    );
    const rows = [
      ...container.querySelectorAll<LitElement & { revision: number }>(
        "openclaw-activity-session-media",
      ),
    ];
    const row = rows[0]!;
    await Promise.all(rows.map((element) => element.updateComplete));
    observers.get(row)?.(true);
    await vi.advanceTimersByTimeAsync(0);
    settled = true;
    for (const element of rows.slice(1)) {
      observers.get(element)?.(true);
    }
    await vi.advanceTimersByTimeAsync(0);
    row.revision++;
    await row.updateComplete;
    row.querySelector<HTMLButtonElement>(".activity-feed__note-action")!.click();
    await vi.advanceTimersByTimeAsync(0);
    await row.updateComplete;
    expect(row.querySelector("img")?.getAttribute("alt")).toBe("queued-0");
    expect(row.querySelector<HTMLButtonElement>(".activity-feed__note-action")?.disabled).toBe(
      true,
    );
    blockers[0]!.resolve({ artifacts: [] });
    blockers[1]!.resolve({ artifacts: [] });
    await vi.advanceTimersByTimeAsync(0);
    expect(request).toHaveBeenLastCalledWith("artifacts.list", {
      sessionKey: "target",
      agentId: "main",
      type: "image",
      limit: 3,
      cursor: "older",
    });
    older.resolve(images("older", 1));
    await vi.advanceTimersByTimeAsync(0);
    await row.updateComplete;
    expect(row.querySelectorAll("img")).toHaveLength(2);
    refresh.resolve(images("new"));
    await vi.advanceTimersByTimeAsync(0);
    await row.updateComplete;
    expect(row.querySelectorAll("img")).toHaveLength(4);
    expect(row.querySelector("img")?.getAttribute("alt")).toBe("new-0");
  } finally {
    for (const blocker of blockers) {
      blocker.resolve({ artifacts: [] });
    }
    refresh.resolve({ artifacts: [] });
    older.resolve({ artifacts: [] });
    vi.useRealTimers();
  }
});
