/* @vitest-environment jsdom */

import { createComponent, createStore } from "solid-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ArtifactsListResult } from "../../../../packages/gateway-protocol/src/index.ts";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import {
  createContext,
  createGatewayHarness,
  createSessions,
} from "../../test-helpers/app-sidebar.ts";
import {
  createTestGatewayClient,
  type GatewayRequestHandler,
} from "../../test-helpers/gateway-client.ts";
import { cleanupSolid, mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { ActivitySessionMedia, type ActivitySessionMediaProps } from "./session-activity-media.tsx";

const observers = new Map<Element, (visible: boolean) => void>();
const pendingResults: ReturnType<typeof createDeferred<ArtifactsListResult>>[] = [];
let container: HTMLDivElement;

function deferredResult() {
  const result = createDeferred<ArtifactsListResult>();
  pendingResults.push(result);
  return result;
}

beforeEach(() => {
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      private readonly targets = new Set<Element>();
      constructor(private callback: IntersectionObserverCallback) {}
      observe(target: Element) {
        this.targets.add(target);
        observers.set(target, (visible) => {
          if (this.targets.has(target)) {
            this.callback(
              [{ target, isIntersecting: visible } as IntersectionObserverEntry],
              this as unknown as IntersectionObserver,
            );
          }
        });
        // These fixtures place thumbnails inside the explicitly admitted row.
        queueMicrotask(() => {
          if (target.matches(".chat-image-frame")) {
            observers.get(target)?.(true);
          }
        });
      }
      unobserve(target: Element) {
        this.targets.delete(target);
        observers.delete(target);
      }
      disconnect() {
        for (const target of this.targets) {
          observers.delete(target);
        }
        this.targets.clear();
      }
    },
  );
  container = document.createElement("div");
  document.body.append(container);
});

afterEach(() => {
  cleanupSolid();
  for (const result of pendingResults.splice(0)) {
    result.resolve({ artifacts: [] });
  }
  container.remove();
  observers.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const imageAlt = (root: ParentNode) => root.querySelector("img")?.getAttribute("alt");
const imageUrl = (root: ParentNode | null) => root?.querySelector(".image")?.getAttribute("src");
const waitImage = (root: ParentNode, alt: string) =>
  waitForSolid(() => expect(imageAlt(root)).toBe(alt));
const lightbox = (root: ParentNode) => root.querySelector("openclaw-image-lightbox");
const thumbnail = (root: ParentNode) =>
  root.querySelector<HTMLButtonElement>(".chat-message-image-button")!;
const olderAction = (root: ParentNode) =>
  root.querySelector<HTMLButtonElement>(".activity-feed__note-action");
const listArgs = (sessionKey: string, limit = 4, cursor?: string) =>
  [
    "artifacts.list",
    { sessionKey, agentId: "main", type: "image", limit, ...(cursor ? { cursor } : {}) },
  ] as const;
const waitCalls = (request: unknown, count: number) =>
  waitForSolid(() => expect(request).toHaveBeenCalledTimes(count));
async function admit(row: Element) {
  await waitForSolid(() => expect(observers.has(row)).toBe(true));
  observers.get(row)?.(true);
}
async function settleTimers() {
  await vi.advanceTimersByTimeAsync(0);
  flush();
}
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

type MediaOverrides = Partial<Omit<ActivitySessionMediaProps, "context">>;
function mountMedia(
  request: GatewayRequestHandler,
  overrides: MediaOverrides | MediaOverrides[] = {},
) {
  const harness = createGatewayHarness(createTestGatewayClient(request));
  const context = createContext(harness.gateway, createSessions("main", []));
  const media = (Array.isArray(overrides) ? overrides : [overrides]).map((props) =>
    createStore<ActivitySessionMediaProps>(
      { context, sessionKey: "agent:main:images", agentId: "main", revision: 0, ...props },
      { shallow: true },
    ),
  );
  const view = mountSolid(
    () => media.map(([props]) => createComponent(ActivitySessionMedia, props)),
    { container },
  );
  flush();
  const updates = media.map(
    ([, setProps]) =>
      (patch: Partial<ActivitySessionMediaProps>) =>
        setProps((draft) => {
          Object.assign(draft, patch);
        }),
  );
  const rows = [...container.querySelectorAll<HTMLElement>("openclaw-activity-session-media")];
  const row = rows[0]!;
  const update = updates[0]!;
  return { harness, rows, updates, view, row, update };
}

function seededRequest(initial: ArtifactsListResult) {
  const pending = [deferredResult(), deferredResult()] as const;
  const request = vi.fn().mockResolvedValueOnce(initial);
  for (const response of pending) {
    request.mockReturnValueOnce(response.promise);
  }
  return { pending, request };
}

it("gates and coalesces discovery in FIFO order, retaining thumbnails in the shared viewer", async () => {
  const pending = Array.from({ length: 5 }, deferredResult);
  const request = vi.fn(async () => pending[request.mock.calls.length - 1]!.promise);
  const { rows, updates, update, view } = mountMedia(
    request,
    [0, 1, 2, 3, 4].map((index) => ({
      sessionKey: `agent:main:images-${index}`,
      revision: index === 2 ? 1 : 0,
    })),
  );
  const first = rows[0]!;
  const originalUrl = "https://images.example.test/first-0.png";
  await waitForSolid(() => expect(observers.size).toBe(5));
  expect(request).not.toHaveBeenCalled();
  for (const row of rows.slice(0, 3)) {
    observers.get(row)?.(true);
  }
  await waitCalls(request, 2);
  expect(request).toHaveBeenCalledWith(...listArgs("agent:main:images-0"));
  expect(rows[3]!.querySelectorAll("img")).toHaveLength(0);
  observers.get(rows[3]!)?.(true);
  updates[2]!({ revision: 2 });
  flush();
  pending[0]!.resolve(images("first"));
  await waitCalls(request, 3);
  expect(request.mock.calls[2]).toEqual(listArgs("agent:main:images-2"));
  pending[1]!.resolve(images("second"));
  pending[2]!.resolve(images("third"));
  await waitCalls(request, 4);
  pending[3]!.resolve(images("fourth"));
  await waitForSolid(() => expect(container.querySelectorAll("img")).toHaveLength(16));
  expect(rows[4]!.querySelectorAll("img")).toHaveLength(0);
  await waitForSolid(() => expect(first.querySelectorAll(".chat-message-image")).toHaveLength(4));
  thumbnail(first).click();
  await waitForSolid(() => expect(imageUrl(lightbox(first))).toBe(originalUrl));
  const opened = lightbox(first);
  update({ revision: 1 });
  await waitCalls(request, 5);
  expect(first.querySelectorAll(".chat-message-image")).toHaveLength(4);
  expect(imageAlt(first)).toBe("first-0");
  expect(lightbox(first)).toBe(opened);
  pending[4]!.resolve(images("refreshed"));
  await waitImage(first, "refreshed-0");
  expect(lightbox(first)).toBe(opened);
  expect(imageUrl(opened)).toBe(originalUrl);
  update({ session: { key: "agent:main:images-0", kind: "direct", permissionMode: "workspace" } });
  await waitForSolid(() => expect(lightbox(first)).toBeNull());
  view.unmount();
  expect(observers.size).toBe(0);
});

it.each(["initial discovery", "revision refresh"])(
  "preserves a usable gallery through %s failure and retry",
  async (phase) => {
    const initialDiscovery = phase === "initial discovery";
    const {
      pending: [failedRefresh, retry],
      request,
    } = seededRequest({
      ...images("original", 1),
      ...(initialDiscovery ? { nextCursor: "older" } : {}),
    });
    const { row, update } = mountMedia(request);
    await admit(row);
    if (!initialDiscovery) {
      await waitImage(row, "original-0");
      update({ revision: 1 });
    }
    await waitCalls(request, 2);
    failedRefresh.reject(new Error("Unavailable"));
    await waitForSolid(() => expect(row.querySelector('[role="status"]')).not.toBeNull());
    expect(imageAlt(row)).toBe("original-0");
    const retryButton = [...row.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === "Retry",
    );
    expect(retryButton).toBeDefined();
    expect(retryButton?.closest(".activity-feed__note")?.parentElement).toBe(
      row.querySelector(".activity-feed__media"),
    );
    retryButton!.click();
    await waitCalls(request, 3);
    expect(imageAlt(row)).toBe("original-0");
    retry.resolve(images("fresh", 1));
    await waitImage(row, "fresh-0");
    expect(row.querySelector('[role="status"]')).toBeNull();
    request.mockResolvedValueOnce({ artifacts: [] });
    update({ revision: initialDiscovery ? 1 : 2 });
    await waitCalls(request, 4);
    await waitForSolid(() => expect(row.querySelector("img")).toBeNull());
  },
);

it.each(["session", "agent", "connection"] as const)(
  "retires the previous gallery and pending refresh when its %s changes",
  async (change) => {
    const {
      pending: [stale, fresh],
      request,
    } = seededRequest(images("original", 1));
    const { harness, row, update } = mountMedia(request, {
      session: { key: "agent:main:images", kind: "direct", sessionId: "original" },
    });
    await admit(row);
    await waitImage(row, "original-0");
    update({ revision: 1 });
    await waitCalls(request, 2);
    if (change === "session") {
      update({ session: { key: "agent:main:images", kind: "direct", sessionId: "reset" } });
    } else if (change === "agent") {
      update({ agentId: "other" });
    } else {
      harness.publish({ client: createTestGatewayClient(request) });
    }
    await waitCalls(request, 3);
    expect(row.querySelector("img")).toBeNull();
    if (change !== "connection") {
      stale.resolve(images("stale", 1));
      await Promise.resolve();
      flush();
      expect(row.querySelector("img")).toBeNull();
    }
    fresh.resolve(images("fresh", 1));
    await waitImage(row, "fresh-0");
    expect(row.querySelectorAll("img")).toHaveLength(1);
    if (change === "connection") {
      stale.resolve(images("stale"));
      await Promise.resolve();
      flush();
      expect(row.querySelectorAll("img")).toHaveLength(1);
      expect(imageAlt(row)).toBe("fresh-0");
      thumbnail(row).click();
      await waitForSolid(() => expect(lightbox(row)).not.toBeNull());
      harness.publish({ phase: "offline" });
      await waitForSolid(() => expect(row.querySelector("img")).toBeNull());
      expect(lightbox(row)).toBeNull();
    }
  },
);

it.each([
  { count: 3, cursor: true, omitted: false, error: false, revalidate: false },
  { count: 0, cursor: true, omitted: false, error: false, revalidate: false },
  { count: 0, cursor: false, omitted: true, error: false, revalidate: false },
  { count: 0, cursor: true, omitted: true, error: true, revalidate: false },
  { count: 0, cursor: false, omitted: false, error: false, revalidate: false },
  { count: 1, cursor: true, omitted: false, error: true, revalidate: true },
  { count: 1, cursor: true, omitted: true, error: false, revalidate: true },
  { count: 0, cursor: true, omitted: true, error: false, revalidate: true },
])(
  "keeps media feedback and pagination stable through discovery and revalidation (%j)",
  async ({ count, cursor, omitted, error, revalidate }) => {
    vi.useFakeTimers();
    const refresh = deferredResult();
    const older = deferredResult();
    const result: ArtifactsListResult = {
      ...images("settled", count),
      ...(cursor ? { nextCursor: "older" } : {}),
      ...(omitted ? { omittedOversized: true } : {}),
    };
    const request = vi.fn().mockResolvedValue(result);
    if (error) {
      request.mockResolvedValueOnce(result).mockRejectedValueOnce(new Error("Unavailable"));
    }
    const { row, update } = mountMedia(request, { sessionKey: "agent:main:stable" });
    observers.get(row)?.(true);
    await settleTimers();
    const media = row.querySelector(".activity-feed__media");
    const note = row.querySelector(".activity-feed__note");
    expect(Boolean(media)).toBe(count > 0 || cursor || omitted || error);
    expect(row.querySelectorAll(".chat-image-frame")).toHaveLength(count);
    expect(Boolean(note)).toBe(error || omitted || (count === 0 && cursor));
    if (note) {
      expect(note.parentElement).toBe(media);
    }
    expect(note?.textContent?.includes("Images too large to preview here") ?? false).toBe(omitted);
    if (error) {
      expect(note?.querySelector('[role="status"]')?.textContent).toBe("Couldn't load images");
      expect(note?.querySelector("button")?.textContent?.trim()).toBe("Retry");
    }
    const action = olderAction(row);
    expect(action?.classList.contains("btn") ?? false).toBe(false);
    if (cursor && !error) {
      expect(action?.textContent?.trim()).toBe("Older images");
      expect(action?.parentElement).toBe(
        count ? media?.querySelector(".chat-message-images") : note,
      );
      expect(action?.parentElement?.lastElementChild).toBe(action);
    }
    if (revalidate) {
      const nodes = [...media!.querySelectorAll("*")];
      const markup = media!.innerHTML;
      expect(media!.textContent).toContain(error ? "Couldn't load images" : "Older images");
      const settledCalls = request.mock.calls.length;
      request.mockReturnValueOnce(refresh.promise);
      update({ revision: 1 });
      flush();
      expect(request).toHaveBeenCalledTimes(settledCalls + 1);
      expect(row.querySelector(".activity-feed__media")).toBe(media);
      expect(media!.innerHTML).toBe(markup);
      for (const [index, node] of [...media!.querySelectorAll("*")].entries()) {
        expect(node).toBe(nodes[index]);
      }
      expect(action?.disabled).toBe(false);
    }
    if (cursor && !error) {
      request.mockReturnValueOnce(older.promise);
      action!.click();
      flush();
      if (revalidate) {
        expect(request).toHaveBeenLastCalledWith(
          ...listArgs("agent:main:stable", 4 - count, "older"),
        );
      }
      expect(action!.disabled).toBe(true);
      expect(action!.textContent?.trim()).toBe("Loading…");
      expect(olderAction(row)).toBe(action);
      older.resolve(images("older", revalidate ? 1 : 4));
      await settleTimers();
      if (revalidate) {
        expect(row.querySelectorAll(".chat-image-frame")).toHaveLength(count + 1);
      } else {
        expect(olderAction(row)).toBeNull();
      }
    }
    if (revalidate) {
      refresh.resolve(images("replacement"));
      await settleTimers();
      expect(row.querySelectorAll(".chat-image-frame")).toHaveLength(4);
      expect(imageAlt(row)).toBe("replacement-0");
      expect(olderAction(row)).toBeNull();
      expect(row.querySelector(".activity-feed__note")).toBeNull();
    }
  },
);

it("loads bounded reference-only previews through the shared RPC path with their agent", async () => {
  vi.useFakeTimers();
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
      : {
          artifact: { ...artifact, mimeType: "image/webp" },
          encoding: "base64",
          data: "cHJldmlldw==",
        },
  );
  const { row } = mountMedia(request, { sessionKey: "global", agentId: "work" });
  observers.get(row)?.(true);
  await settleTimers();
  expect(request).toHaveBeenCalledWith(
    "artifacts.download",
    {
      sessionKey: "global",
      agentId: "work",
      artifactId: "reference-image",
      previewWidth: 480,
    },
    { timeoutMs: 30_000 },
  );
  expect(row.querySelectorAll("img")).toHaveLength(1);
  const imageSource = row.querySelector("img")!.src;
  expect(imageSource).toMatch(/^blob:/);
  const downloaded = await fetch(imageSource);
  expect(downloaded.headers.get("content-type")).toBe("image/webp");
  expect(await downloaded.text()).toBe("preview");
  expect(imageAlt(row)).toBe("Inline screenshot");
});

it("keeps queued pagination separate from background revalidation", async () => {
  vi.useFakeTimers();
  const blockers = [deferredResult(), deferredResult()];
  const refresh = deferredResult();
  const older = deferredResult();
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
  const { rows, update } = mountMedia(
    request,
    ["target", "0", "1"].map((sessionKey) => ({ sessionKey })),
  );
  const row = rows[0]!;
  observers.get(row)?.(true);
  await vi.advanceTimersByTimeAsync(0);
  settled = true;
  for (const element of rows.slice(1)) {
    observers.get(element)?.(true);
  }
  await vi.advanceTimersByTimeAsync(0);
  update({ revision: 1 });
  flush();
  olderAction(row)!.click();
  await settleTimers();
  expect(imageAlt(row)).toBe("queued-0");
  expect(olderAction(row)).toMatchObject({ disabled: true });
  blockers[0]!.resolve({ artifacts: [] });
  blockers[1]!.resolve({ artifacts: [] });
  await vi.advanceTimersByTimeAsync(0);
  expect(request).toHaveBeenLastCalledWith(...listArgs("target", 3, "older"));
  older.resolve(images("older", 1));
  await settleTimers();
  expect(row.querySelectorAll("img")).toHaveLength(2);
  refresh.resolve(images("new"));
  await settleTimers();
  expect(row.querySelectorAll("img")).toHaveLength(4);
  expect(imageAlt(row)).toBe("new-0");
});
