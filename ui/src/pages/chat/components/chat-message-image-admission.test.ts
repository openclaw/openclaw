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
  vi.restoreAllMocks();
});

const imageResponse = () => new Response("png", { headers: { "Content-Type": "image/png" } });
const ticketResponse = () =>
  Response.json({
    available: true,
    mediaTicket: "image-ticket",
    mediaTicketExpiresAt: new Date(Date.now() + 300_000).toISOString(),
  });

function draw(images: ImageBlock[], options: ImageRenderOptions = {}) {
  render(renderMessageImages(images, { onRequestUpdate, ...options }), container);
}

async function loadAdmittedImage() {
  intersections[0]!();
  await vi.advanceTimersByTimeAsync(0);
  const loaded = container.querySelector("img")!;
  Object.defineProperties(loaded, { naturalWidth: { value: 20 }, complete: { value: true } });
  loaded.dispatchEvent(new Event("load"));
  return loaded;
}

it("replaces failed remote images with an unavailable card while preserving local recovery", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ available: true })),
  );
  const remote = { url: "https://images.example.test/missing.png", alt: "Remote image" };
  const local = { url: `/tmp/${crypto.randomUUID()}.png`, alt: "Local image" };
  draw([remote, local]);
  intersections[0]!();
  intersections[1]!();
  await vi.advanceTimersByTimeAsync(0);

  const localImage = container.querySelector<HTMLImageElement>('img[alt="Local image"]')!;
  expect(localImage).not.toBeNull();
  localImage.dispatchEvent(new Event("error"));
  expect(container.querySelector('img[alt="Local image"]')).toBe(localImage);
  expect(container.querySelector(".chat-assistant-attachment-card")).toBeNull();

  const remoteImage = container.querySelector<HTMLImageElement>('img[alt="Remote image"]')!;
  expect(remoteImage.getAttribute("src")).toBe(remote.url);
  remoteImage.dispatchEvent(new Event("error"));
  expect(container.querySelector('img[alt="Remote image"]')).toBeNull();
  const card = container.querySelector(
    ".chat-image-frame--compact .chat-assistant-attachment-card",
  );
  expect(card?.textContent).toContain("Could not load this image. Try again.");
  expect(container.querySelector('img[alt="Local image"]')).toBe(localImage);

  const replacement = { ...remote, url: "https://images.example.test/replacement.png" };
  draw([replacement, local]);
  intersections.at(-1)!();
  expect(container.querySelector(".chat-assistant-attachment-card")).toBeNull();
  expect(container.querySelector('img[alt="Remote image"]')?.getAttribute("src")).toBe(
    replacement.url,
  );
});

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

it("loads an artifact thumbnail for the tile and distinct full bytes for the lightbox", async () => {
  const artifactId = `artifact_transcript_image_${crypto.randomUUID()}`;
  const thumbnail = new Blob(["thumbnail"], { type: "image/png" });
  const full = new Blob(["original"], { type: "image/jpeg" });
  const resolveArtifactDownload = vi
    .fn()
    .mockResolvedValueOnce({ url: "/thumbnail", blob: thumbnail })
    .mockResolvedValueOnce({ url: "/original", blob: full });
  const onOpenImage = vi.fn<(item: ImageLightboxItem) => void>();
  draw([{ artifactId }], { sessionKey: "main", resolveArtifactDownload, onOpenImage });
  intersections[0]!();
  await vi.advanceTimersByTimeAsync(0);
  const preview = container.querySelector("img")?.getAttribute("src");
  expect(preview).toBeTruthy();
  expect(resolveArtifactDownload).toHaveBeenCalledExactlyOnceWith(
    { sessionKey: "main", artifactId, variant: "thumbnail" },
    expect.any(AbortSignal),
  );

  container.querySelector<HTMLButtonElement>(".chat-message-image-button")!.click();
  const opened = onOpenImage.mock.calls[0]![0];
  expect(opened.src).toBe(preview);
  const original = await opened.loadFullResolution!();
  expect(original?.src).toBeTruthy();
  expect(original?.src).not.toBe(preview);
  expect(resolveArtifactDownload).toHaveBeenLastCalledWith(
    { sessionKey: "main", artifactId, variant: "full" },
    expect.any(AbortSignal),
  );
  expect(resolveArtifactDownload).toHaveBeenCalledTimes(2);
  original?.release?.();
  opened.release?.();
});

it.each(["assistant", "managed"] as const)(
  "remounts a loaded %s image immediately without repeating viewport admission",
  async (kind) => {
    const source =
      kind === "assistant"
        ? `/tmp/${crypto.randomUUID()}.png`
        : `/api/chat/media/outgoing/agent%3Amain%3Amain/${crypto.randomUUID()}/full`;
    const fetch = vi.fn(async () => (kind === "assistant" ? ticketResponse() : imageResponse()));
    vi.stubGlobal("fetch", fetch);
    const images = [{ url: source, alt: "Loaded screenshot" }];
    draw(images);
    const loaded = await loadAdmittedImage();
    const src = loaded.getAttribute("src");
    render(nothing, container);
    draw(images);
    expect(container.querySelector(".chat-image-skeleton")).toBeNull();
    expect(container.querySelector("img")?.getAttribute("src")).toBe(src);
    if (kind === "assistant") {
      expect(container.querySelector("img")).toBe(loaded);
    }
    expect(fetch).toHaveBeenCalledOnce();
  },
);

it("restores a native image when its retained Lit root reconnects without another render", async () => {
  const source = `/tmp/${crypto.randomUUID()}.png`;
  const fetch = vi.fn(async () => ticketResponse());
  vi.stubGlobal("fetch", fetch);
  const root = render(
    renderMessageImages([{ url: source, fileName: "Screenshot.png" }], { onRequestUpdate }),
    container,
  );
  const loaded = await loadAdmittedImage();
  root.setConnected(false);
  expect(loaded.parentNode).toBeNull();
  root.setConnected(true);
  expect(container.querySelector("img")).toBe(loaded);
  expect(container.querySelector(".chat-image-skeleton")).toBeNull();
  expect(fetch).toHaveBeenCalledOnce();
});

it.each([
  "authToken",
  "sessionKey",
  "agentId",
  "connectionEpoch",
  "resourceBasePath",
  "policyKey",
  "expiry",
] as const)("does not reuse a detached native image after %s changes", async (change) => {
  const source = `/tmp/${crypto.randomUUID()}.png`;
  const fetch = vi.fn(async () => ticketResponse());
  vi.stubGlobal("fetch", fetch);
  const images = [{ url: source, fileName: "Screenshot.png" }];
  const options: ImageRenderOptions = {
    authToken: "before",
    sessionKey: "before",
    agentId: "before",
    connectionEpoch: 1,
    resourceBasePath: "/before",
    policyKey: "before",
  };
  draw(images, options);
  const loaded = await loadAdmittedImage();
  const removeListener = vi.spyOn(loaded, "removeEventListener");
  render(nothing, container);
  expect(loaded.parentNode).toBeNull();
  expect(removeListener).toHaveBeenCalledWith("load", expect.any(Function));
  expect(removeListener).toHaveBeenCalledWith("error", expect.any(Function));
  if (change === "expiry") {
    await vi.advanceTimersByTimeAsync(300_001);
  } else if (change === "connectionEpoch") {
    options.connectionEpoch = 2;
  } else {
    options[change] = "after";
  }
  draw(images, options);
  expect(container.querySelector("img")).toBeNull();
  expect(fetch).toHaveBeenCalledOnce();
  intersections.at(-1)!();
  await vi.advanceTimersByTimeAsync(0);
  expect(container.querySelector("img")).not.toBe(loaded);
  expect(fetch).toHaveBeenCalledTimes(2);
});

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
