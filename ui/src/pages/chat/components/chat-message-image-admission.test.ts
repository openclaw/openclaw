/* @vitest-environment jsdom */

import { nothing, render } from "lit";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import type { ImageLightboxItem } from "../../../components/image-lightbox.types.ts";
import { renderMessageImages } from "./chat-message-images.ts";
import {
  releaseChatMediaResourceSubscriber,
  type ImageBlock,
  type ImageRenderOptions,
} from "./chat-message-media.ts";

let container: HTMLDivElement;
let onRequestUpdate: () => void;
const intersections: (() => void)[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  container = document.body.appendChild(document.createElement("div"));
  onRequestUpdate = vi.fn();
  vi.stubGlobal(
    "IntersectionObserver",
    class implements IntersectionObserver {
      readonly root = null;
      readonly rootMargin = "240px 0px";
      readonly scrollMargin = "0px";
      readonly thresholds = [0];
      constructor(callback: IntersectionObserverCallback) {
        intersections.push(() =>
          callback([{ isIntersecting: true } as IntersectionObserverEntry], this),
        );
      }
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
    },
  );
  const NativeUrl = URL;
  vi.stubGlobal(
    "URL",
    class extends NativeUrl {
      static override createObjectURL = () => `blob:${crypto.randomUUID()}`;
      static override revokeObjectURL = vi.fn();
    },
  );
});

afterEach(() => {
  render(nothing, container);
  releaseChatMediaResourceSubscriber(onRequestUpdate);
  container.remove();
  intersections.length = 0;
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const imageResponse = () => new Response("png", { headers: { "Content-Type": "image/png" } });

function draw(images: ImageBlock[], options: ImageRenderOptions = {}) {
  render(renderMessageImages(images, { onRequestUpdate, ...options }), container);
}

it.each(["assistant", "managed", "omitted"] as const)(
  "defers offscreen %s image reads and shares acquisition after admission",
  async (kind) => {
    const source =
      kind === "assistant"
        ? `/tmp/${crypto.randomUUID()}.png`
        : `/api/chat/media/outgoing/agent%3Amain%3Amain/${crypto.randomUUID()}/full`;
    const image: ImageBlock =
      kind === "omitted"
        ? { artifactId: crypto.randomUUID() }
        : { url: source, artifactId: crypto.randomUUID() };
    const fetch = vi.fn(async () =>
      kind === "assistant" ? Response.json({ available: true }) : imageResponse(),
    );
    vi.stubGlobal("fetch", fetch);
    const resolveArtifactDownload = vi.fn(async () => ({
      url: kind === "omitted" ? "data:image/png;base64,cG5n" : source,
    }));
    draw([image, image], { sessionKey: "agent:main:main", resolveArtifactDownload });

    expect(fetch).not.toHaveBeenCalled();
    expect(resolveArtifactDownload).not.toHaveBeenCalled();
    expect(container.querySelectorAll("img")).toHaveLength(0);

    intersections[0]!();
    intersections[1]!();
    await vi.advanceTimersByTimeAsync(0);

    expect(fetch).toHaveBeenCalledOnce();
    expect(resolveArtifactDownload).toHaveBeenCalledTimes(kind === "assistant" ? 0 : 1);
    expect(container.querySelectorAll("img")).toHaveLength(2);
  },
);

it("admits on focus without replacing the pending control or opening an empty preview", async () => {
  const metadata = createDeferred<Response>();
  const fetch = vi.fn(() => metadata.promise);
  vi.stubGlobal("fetch", fetch);
  const onOpenImage = vi.fn<NonNullable<ImageRenderOptions["onOpenImage"]>>();
  draw([{ url: `/tmp/${crypto.randomUUID()}.png` }], { onOpenImage });
  const button = container.querySelector<HTMLButtonElement>(".chat-message-image-button")!;
  expect(button.disabled).toBe(false);
  expect(button.getAttribute("aria-disabled")).toBe("true");
  expect(fetch).not.toHaveBeenCalled();

  button.focus();
  expect(fetch).toHaveBeenCalledOnce();
  button.click();
  expect(onOpenImage).not.toHaveBeenCalled();
  expect(container.querySelector("button")).toBe(button);

  metadata.resolve(Response.json({ available: true }));
  await vi.advanceTimersByTimeAsync(0);
  expect(container.querySelector("button")).toBe(button);
  expect(document.activeElement).toBe(button);
  expect(button.hasAttribute("aria-disabled")).toBe(false);
  button.click();
  expect(onOpenImage).toHaveBeenCalledOnce();
});

it("lets explicit gallery navigation load an offscreen neighbor", async () => {
  const source = `/api/chat/media/outgoing/agent%3Amain%3Amain/${crypto.randomUUID()}/full`;
  const fetch = vi.fn(async () => imageResponse());
  vi.stubGlobal("fetch", fetch);
  let opened: ImageLightboxItem | undefined;
  draw([{ url: "data:image/png;base64,cG5n" }, { url: source }], {
    onOpenImage: (item) => {
      opened = item;
    },
  });
  container.querySelector<HTMLButtonElement>(".chat-message-image-button")!.click();
  expect(fetch).not.toHaveBeenCalled();

  const neighbor = await opened!.gallery!.items[1]!(true);
  expect(neighbor?.src).toMatch(/^blob:/u);
  expect(fetch).toHaveBeenCalledOnce();
  expect(container.querySelectorAll("img")).toHaveLength(1);
  neighbor?.release?.();
});

it("preserves an immediate inline submission and its settled canonical handoff", async () => {
  const artifactId = crypto.randomUUID();
  const inline: ImageBlock = { url: "data:image/png;base64,cG5n", artifactId };
  const metadata = createDeferred<Response>();
  const fetch = vi.fn(() => metadata.promise);
  vi.stubGlobal("fetch", fetch);
  draw([inline], { localSubmission: true });
  const image = container.querySelector("img")!;
  Object.defineProperty(image, "naturalWidth", { value: 20 });
  image.dispatchEvent(new Event("load"));
  expect(intersections).toHaveLength(0);

  const canonical: ImageBlock = { url: `media://inbound/${artifactId}`, artifactId, factIndex: 0 };
  const options = {
    localSubmission: true,
    canonicalMessageKey: "canonical-submission",
  };
  draw([canonical], options);
  expect(fetch).toHaveBeenCalledOnce();
  expect(container.querySelector("img")).toBe(image);
  expect(image.getAttribute("src")).toBe(inline.url);

  metadata.resolve(Response.json({ available: true }));
  await vi.advanceTimersByTimeAsync(0);
  expect(image.getAttribute("src")).not.toBe(inline.url);
  image.dispatchEvent(new Event("load"));
  draw([canonical], options);
  expect(container.querySelector("img")).toBe(image);
  expect(fetch).toHaveBeenCalledOnce();
  expect(intersections).toHaveLength(0);
});

it("ignores replaced observers and aborts detached artifact resolution before blob fetch", async () => {
  const first = `/api/chat/media/outgoing/agent%3Amain%3Amain/${crypto.randomUUID()}/full`;
  const second = `/api/chat/media/outgoing/agent%3Amain%3Amain/${crypto.randomUUID()}/full`;
  const artifact = createDeferred<{ url: string }>();
  const resolveArtifactDownload = vi.fn(() => artifact.promise);
  const fetch = vi.fn(async () => imageResponse());
  vi.stubGlobal("fetch", fetch);
  draw([{ url: first, artifactId: "first" }], { resolveArtifactDownload });
  draw([{ url: second, artifactId: "second" }], { resolveArtifactDownload });

  intersections[0]!();
  expect(resolveArtifactDownload).not.toHaveBeenCalled();
  intersections[1]!();
  expect(resolveArtifactDownload).toHaveBeenCalledOnce();
  render(nothing, container);
  artifact.resolve({ url: second });
  await vi.advanceTimersByTimeAsync(0);

  expect(fetch).not.toHaveBeenCalled();
  expect(container.querySelector("img")).toBeNull();
});
