/* @vitest-environment jsdom */

import { createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import type { ImageLightboxItem } from "../../../components/image-lightbox.types.ts";
import { ContentPresentation } from "../../../lib/solid/presentation.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush } from "../../../test-helpers/solid-settle.ts";
import { resolveAssistantAttachmentAvailability } from "./chat-message-attachment-availability.ts";
import { AssistantAttachments } from "./chat-message-attachments-solid.tsx";
import { MessageImages, type MessageImagesProps } from "./chat-message-images-solid.tsx";
import {
  imageResponse,
  managedSource,
  stubObjectUrls,
  ticketResponse,
} from "./chat-message-media.test-helpers.ts";
import {
  releaseChatMediaResourceOwner,
  type ImageBlock,
  type ImageRenderOptions,
  type AssistantAttachmentItem,
} from "./chat-message-media.ts";
import { TranscriptMediaDisconnect } from "./chat-transcript-media-lifecycle.ts";

let container: HTMLDivElement;
let onMediaChange: () => void;
let disconnectMedia: Set<() => void>;
let view:
  | {
      update: (props: MessageImagesProps) => void;
      setPresented: (presented: boolean) => void;
      unmount: () => void;
    }
  | undefined;
const intersections: (() => void)[] = [];
const imageElement = () => container.querySelector("img");
const imageButton = () => container.querySelector<HTMLButtonElement>(".chat-message-image-button")!;

beforeEach(() => {
  vi.useFakeTimers();
  container = document.body.appendChild(document.createElement("div"));
  onMediaChange = vi.fn();
  disconnectMedia = new Set();
  vi.stubGlobal(
    "IntersectionObserver",
    class implements IntersectionObserver {
      readonly root = null;
      readonly rootMargin = "240px 0px";
      readonly scrollMargin = "0px";
      readonly thresholds = [0];
      private readonly targets = new Set<Element>();
      constructor(private readonly callback: IntersectionObserverCallback) {}
      observe(target: Element) {
        this.targets.add(target);
        intersections.push(() => {
          if (this.targets.has(target)) {
            // SAFETY: The viewport owner reads only target and isIntersecting.
            this.callback([{ target, isIntersecting: true } as IntersectionObserverEntry], this);
          }
        });
      }
      unobserve(target: Element) {
        this.targets.delete(target);
      }
      disconnect() {
        this.targets.clear();
      }
      takeRecords() {
        return [];
      }
    },
  );
  stubObjectUrls();
});

afterEach(() => {
  unmount();
  releaseChatMediaResourceOwner(onMediaChange);
  container.remove();
  intersections.length = 0;
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function draw(images: ImageBlock[], options: ImageRenderOptions = {}) {
  const props = { images, options: { mediaOwner: onMediaChange, ...options } };
  if (view) {
    view.update(props);
    return view;
  }
  view = mountImages(props, container);
  return view;
}

function mountImages(props: MessageImagesProps, target: HTMLElement) {
  const [current, setCurrent] = createSignal<MessageImagesProps>(props);
  const [presented, setPresented] = createSignal(true);
  const mounted = mountSolid(
    () => (
      <ContentPresentation value={presented}>
        <TranscriptMediaDisconnect value={disconnectMedia}>
          <MessageImages {...current()} />
        </TranscriptMediaDisconnect>
      </ContentPresentation>
    ),
    { container: target },
  );
  return {
    update(next: MessageImagesProps) {
      setCurrent(next);
      flush();
    },
    setPresented,
    unmount: mounted.unmount,
  };
}

function unmount() {
  view?.unmount();
  view = undefined;
}

async function loadAdmittedImage() {
  intersections[0]!();
  await vi.advanceTimersByTimeAsync(0);
  const loaded = imageElement()!;
  Object.defineProperties(loaded, { naturalWidth: { value: 20 }, complete: { value: true } });
  loaded.dispatchEvent(new Event("load"));
  return loaded;
}

it("keeps saved network images inert until live admission while retaining local draft bytes", async () => {
  const fetch = vi.fn(async () => imageResponse());
  vi.stubGlobal("fetch", fetch);
  const local = "data:image/png;base64,cG5n";
  const remote = "https://images.example.test/saved.png";
  const images = [{ url: managedSource() }, { url: remote }, { url: local }];
  const options = { authToken: "saved-token", mediaReadAllowed: false };
  draw(images, options);
  for (const intersect of intersections) {
    intersect();
  }
  await vi.advanceTimersByTimeAsync(0);
  expect(fetch).not.toHaveBeenCalled();
  expect(container.querySelector(`img[src="${remote}"]`)).toBeNull();
  expect(container.querySelector(`img[src="${local}"]`)).not.toBeNull();

  options.mediaReadAllowed = true;
  draw(images, options);
  for (const intersect of intersections) {
    intersect();
  }
  await vi.advanceTimersByTimeAsync(0);
  expect(fetch).toHaveBeenCalledOnce();
  expect(container.querySelector(`img[src="${remote}"]`)).not.toBeNull();
});

it("holds saved audio sources and their authorization until live admission", async () => {
  const fetch = vi.fn(async () => ticketResponse());
  vi.stubGlobal("fetch", fetch);
  const source = managedSource();
  const resolveArtifactDownload = vi.fn(async () => ({ url: source + "?mediaTicket=live" }));
  const attachments: AssistantAttachmentItem[] = [
    {
      type: "attachment",
      attachment: {
        kind: "audio",
        label: "Local recording",
        url: "/tmp/saved.wav",
        mimeType: "audio/wav",
      },
    },
    {
      type: "attachment",
      attachment: {
        kind: "audio",
        label: "Managed recording",
        url: source,
        artifactId: crypto.randomUUID(),
        mimeType: "audio/mpeg",
      },
    },
    {
      type: "attachment",
      attachment: {
        kind: "audio",
        label: "Remote recording",
        url: "https://media.example.test/saved.mp3",
        mimeType: "audio/mpeg",
      },
    },
  ];
  const [allowed, setAllowed] = createSignal(false);
  const root = mountSolid(
    () => (
      <AssistantAttachments
        attachments={attachments}
        options={{ mediaReadAllowed: allowed(), authToken: "saved-token", resolveArtifactDownload }}
      />
    ),
    { container },
  );
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).not.toHaveBeenCalled();
    expect(resolveArtifactDownload).not.toHaveBeenCalled();
    expect(container.querySelector("audio, video")).toBeNull();
    setAllowed(true);
    flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalled();
    expect(resolveArtifactDownload).toHaveBeenCalledOnce();
  } finally {
    root.unmount();
  }
});

it.each(["render", "click"] as const)(
  "does not replay an automatic image retry already claimed by %s",
  async (trigger) => {
    const images = [{ url: managedSource() }];
    const fetch = vi.fn(async () => new Response(null, { status: 503 }));
    vi.stubGlobal("fetch", fetch);
    onMediaChange = () => draw([...images]);
    draw(images);
    intersections[0]!();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    if (trigger === "render") {
      // Claim the elapsed retry before its queued timer runs.
      vi.setSystemTime(Date.now() + 5_000);
      onMediaChange();
    } else {
      const retry = container.querySelector<HTMLButtonElement>("button");
      expect(retry?.textContent).toContain("Retry");
      retry?.click();
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  },
);

it("replaces failed native images with unavailable cards and offers local retry", async () => {
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
  flush();
  expect(container.querySelector('img[alt="Local image"]')).toBeNull();
  expect(container.querySelector(".chat-assistant-attachment-card__retry")).not.toBeNull();

  const remoteImage = container.querySelector<HTMLImageElement>('img[alt="Remote image"]')!;
  expect(remoteImage.getAttribute("src")).toBe(remote.url);
  remoteImage.dispatchEvent(new Event("error"));
  flush();
  expect(container.querySelector('img[alt="Remote image"]')).toBeNull();
  const card = container.querySelector(
    ".chat-image-frame--compact .chat-assistant-attachment-card",
  );
  expect(card?.textContent).toContain("Could not load this image. Try again.");
  expect(container.querySelector('img[alt="Local image"]')).toBeNull();
  expect(container.querySelectorAll(".chat-image-action")).toHaveLength(1);
  for (const [index, frame] of [...container.querySelectorAll(".chat-image-frame")].entries()) {
    const retry = frame.querySelector<HTMLButtonElement>(".chat-assistant-attachment-card__retry");
    expect(retry?.textContent?.trim()).toBe("Retry");
    expect(frame.querySelector(".chat-assistant-attachment-card a")).toBeNull();
    if (index === 0) {
      expect(frame.querySelector(".chat-image-actions")).toBeNull();
      continue;
    }
    expect(frame.querySelector(".chat-image-actions [data-value=copy]")?.textContent).toContain(
      "Copy image",
    );
    expect(frame.querySelector(".chat-image-actions [data-value=download]")?.textContent).toContain(
      "Download image",
    );
  }

  card!.querySelector<HTMLButtonElement>(".chat-assistant-attachment-card__retry")!.click();
  flush();
  const retried = container.querySelector<HTMLImageElement>('img[alt="Remote image"]');
  expect(retried?.getAttribute("src")).toBe(remote.url);
  expect(retried).not.toBe(remoteImage);
  retried!.dispatchEvent(new Event("error"));
  flush();

  const replacement = { ...remote, url: "https://images.example.test/replacement.png" };
  draw([replacement, local]);
  intersections.at(-1)!();
  flush();
  expect(container.querySelectorAll(".chat-assistant-attachment-card")).toHaveLength(1);
  expect(container.querySelector('img[alt="Remote image"]')?.getAttribute("src")).toBe(
    replacement.url,
  );
});

it.each(["assistant", "managed", "omitted", "standalone", "aliases"] as const)(
  "defers offscreen %s image reads and shares acquisition after admission",
  async (kind) => {
    const source = kind === "assistant" ? `/tmp/${crypto.randomUUID()}.png` : managedSource();
    const image: ImageBlock =
      kind === "omitted"
        ? { artifactId: crypto.randomUUID() }
        : { url: source, artifactId: crypto.randomUUID() };
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      if (kind !== "assistant") {
        const headers = new Headers(init?.headers);
        expect(headers.has("Authorization")).toBe(false);
        expect(headers.has("x-openclaw-requester-session-key")).toBe(false);
      }
      return kind === "assistant" ? Response.json({ available: true }) : imageResponse();
    });
    vi.stubGlobal("fetch", fetch);
    const resolveArtifactDownload = vi.fn(async () => ({
      url: kind === "omitted" || kind === "aliases" ? "data:image/png;base64,cG5n" : source,
    }));
    const alias: ImageBlock =
      kind === "aliases" ? { ...image, url: `${source}?mediaTicket=historical` } : image;
    const options = {
      sessionKey: "agent:main:main",
      authToken: "must-not-be-forwarded",
      resolveArtifactDownload,
      mediaOwner: kind === "standalone" ? undefined : onMediaChange,
    };
    draw([image, alias], options);

    expect(fetch).not.toHaveBeenCalled();
    expect(resolveArtifactDownload).not.toHaveBeenCalled();
    expect(container.querySelectorAll("img")).toHaveLength(0);

    intersections[0]!();
    intersections[1]!();
    await vi.advanceTimersByTimeAsync(0);

    expect(fetch).toHaveBeenCalledOnce();
    expect(resolveArtifactDownload).toHaveBeenCalledTimes(kind === "assistant" ? 0 : 1);
    expect(container.querySelectorAll("img")).toHaveLength(2);
    draw([alias, image], options);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledOnce();
    expect(resolveArtifactDownload).toHaveBeenCalledTimes(kind === "assistant" ? 0 : 1);
    const urls = [...container.querySelectorAll("img")].map((element) => element.src);
    expect(new Set(urls).size).toBe(1);
  },
);

it("retries signed artifact downloads without forwarding gateway or requester credentials", async () => {
  const source = managedSource();
  const ticketedUrl = `${source}?mediaTicket=signed`;
  const resolveArtifactDownload = vi.fn(async () => ({ url: ticketedUrl }));
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(new Response(null, { status: 503 }))
    .mockResolvedValueOnce(imageResponse());
  vi.stubGlobal("fetch", fetch);
  draw([{ url: source, artifactId: crypto.randomUUID() }], {
    sessionKey: "agent:main:main",
    authToken: "must-not-be-forwarded",
    resolveArtifactDownload,
  });
  intersections[0]!();
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(5_000);

  expect(resolveArtifactDownload).toHaveBeenCalledTimes(2);
  expect(fetch).toHaveBeenCalledTimes(2);
  for (const [requestUrl, init] of fetch.mock.calls) {
    expect(requestUrl).toBe(`${ticketedUrl.replace(/\/full(?=\?)/u, "/thumbnail")}&v=4&width=480`);
    const headers = new Headers(init?.headers);
    expect(headers.has("Authorization")).toBe(false);
    expect(headers.has("x-openclaw-requester-session-key")).toBe(false);
  }
  expect(imageElement()?.getAttribute("src")).toMatch(/^blob:/u);
});

it("keeps the artifact's source session in its shared image identity", async () => {
  const artifactId = crypto.randomUUID();
  const resolveArtifactDownload = vi.fn<NonNullable<ImageRenderOptions["resolveArtifactDownload"]>>(
    async () => ({
      url: "data:image/png;base64,cG5n",
      blob: new Blob(["png"], { type: "image/png" }),
    }),
  );
  draw(
    ["agent:main:first", "agent:main:second"].map((sessionKey) => ({
      artifactId,
      url: `/api/chat/media/outgoing/${encodeURIComponent(sessionKey)}/fixture/full`,
    })),
    { sessionKey: "agent:main:main", resolveArtifactDownload },
  );
  intersections[0]!();
  intersections[1]!();
  await vi.advanceTimersByTimeAsync(0);
  expect(resolveArtifactDownload.mock.calls.map(([params]) => params.sessionKey)).toEqual([
    "agent:main:first",
    "agent:main:second",
  ]);
  expect(new Set([...container.querySelectorAll("img")].map((image) => image.src)).size).toBe(2);
});

it("keeps an artifact-only viewer rendition alive when its inline tile rerenders and reopens", async () => {
  vi.stubGlobal("innerWidth", 390);
  vi.stubGlobal("innerHeight", 844);
  vi.stubGlobal("devicePixelRatio", 1);
  const display = createDeferred<{ url: string; blob: Blob }>();
  const thumbnail = new Blob(["inline thumbnail"], { type: "image/png" });
  const resolveArtifactDownload = vi.fn<NonNullable<ImageRenderOptions["resolveArtifactDownload"]>>(
    async (request) =>
      request.previewWidth === 960 ? display.promise : { url: "/thumbnail", blob: thumbnail },
  );
  const onOpenImage = vi.fn<(item: ImageLightboxItem) => void>();
  const image = { artifactId: crypto.randomUUID(), alt: "Artifact-only screenshot" };
  const options = { sessionKey: "main", resolveArtifactDownload, onOpenImage };
  draw([image], options);
  intersections[0]!();
  await vi.advanceTimersByTimeAsync(0);
  const inline = imageElement()!;
  const preview = inline.getAttribute("src");
  imageButton().click();
  const opened = onOpenImage.mock.calls[0]![0];
  expect(opened.src).toBe(preview);
  const pending = opened.loadDisplayImage!();
  await vi.advanceTimersByTimeAsync(0);
  expect(resolveArtifactDownload.mock.calls.map(([request]) => request.previewWidth)).toEqual([
    480, 960,
  ]);
  const signal = resolveArtifactDownload.mock.calls[1]![1]!;
  expect(signal.aborted).toBe(false);

  draw([{ ...image }], { ...options });
  // Reopening reacquires the inline rendition with the same pane subscriber
  // while the earlier viewer request is still pending.
  imageButton().click();
  await vi.advanceTimersByTimeAsync(0);
  expect(signal.aborted).toBe(false);
  expect(imageElement()).toBe(inline);
  expect(inline.getAttribute("src")).toBe(preview);
  expect(resolveArtifactDownload).toHaveBeenCalledTimes(2);

  display.resolve({ url: "/display", blob: new Blob(["viewer rendition"], { type: "image/png" }) });
  const rendition = await pending;
  expect(rendition?.src).toMatch(/^blob:/u);
  expect(rendition?.src).not.toBe(preview);
  const reused = await opened.loadDisplayImage!();
  expect(reused?.src).toBe(rendition?.src);
  expect(resolveArtifactDownload).toHaveBeenCalledTimes(2);
  expect(inline.getAttribute("src")).toBe(preview);
  rendition?.release?.();
  reused?.release?.();
  opened.release?.();
  onOpenImage.mock.calls[1]![0].release?.();
});

it.each([
  [390, 400, 1, 480, 480],
  [390, 844, 1, 480, 960],
  [390, 844, 2, 960, 1920],
  [1440, 900, 1, 480, 1920],
])(
  "uses bounded artifact renditions at %s × %s / DPR %s and reads originals only on download",
  async (width, height, dpr, inline, display) => {
    vi.stubGlobal("innerWidth", width);
    vi.stubGlobal("innerHeight", height);
    vi.stubGlobal("devicePixelRatio", dpr);
    const artifactId = `artifact_transcript_image_${crypto.randomUUID()}`;
    const thumbnail = new Blob(["thumbnail"], { type: "image/png" });
    const full = new Blob(["original"], { type: "image/jpeg" });
    const resolveArtifactDownload = vi.fn(async (request: { variant?: string }) => ({
      url: request.variant === "full" ? "/original" : "/thumbnail",
      blob: request.variant === "full" ? full : thumbnail,
    }));
    const onOpenImage = vi.fn<(item: ImageLightboxItem) => void>();
    draw([{ artifactId }], { sessionKey: "main", resolveArtifactDownload, onOpenImage });
    intersections[0]!();
    await vi.advanceTimersByTimeAsync(0);
    const preview = imageElement()?.getAttribute("src");
    expect(preview).toBeTruthy();
    expect(resolveArtifactDownload).toHaveBeenCalledExactlyOnceWith(
      { sessionKey: "main", artifactId, variant: "thumbnail", previewWidth: inline },
      expect.any(AbortSignal),
    );
    imageButton().click();
    const opened = onOpenImage.mock.calls[0]![0];
    expect(opened.src).toBe(preview);
    const rendition = await opened.loadDisplayImage!();
    expect(rendition?.src).toBeTruthy();
    expect(resolveArtifactDownload).toHaveBeenLastCalledWith(
      { sessionKey: "main", artifactId, variant: "thumbnail", previewWidth: display },
      expect.any(AbortSignal),
    );
    expect(
      resolveArtifactDownload.mock.calls.every(([request]) => request.variant === "thumbnail"),
    ).toBe(true);
    expect(await rendition!.readOriginalBlob!()).toBe(full);
    expect(resolveArtifactDownload).toHaveBeenLastCalledWith(
      { sessionKey: "main", artifactId, variant: "full" },
      expect.any(AbortSignal),
    );
    expect(resolveArtifactDownload).toHaveBeenCalledTimes(inline === display ? 2 : 3);
    rendition?.release?.();
    opened.release?.();
  },
);

it.each(["assistant remount", "managed remount", "assistant reconnect"] as const)(
  "restores a loaded image without another viewport admission: %s",
  async (mode) => {
    const managed = mode === "managed remount";
    const source = managed ? managedSource() : `/tmp/${crypto.randomUUID()}.png`;
    const fetch = vi.fn(async () => (managed ? imageResponse() : ticketResponse()));
    vi.stubGlobal("fetch", fetch);
    const images = [{ url: source, fileName: "Screenshot.png" }];
    const root = draw(images);
    const loaded = await loadAdmittedImage();
    const src = loaded.getAttribute("src");
    if (mode === "assistant reconnect") {
      root.setPresented(false);
      flush();
      expect(loaded.parentNode).toBeNull();
      root.setPresented(true);
      flush();
    } else {
      unmount();
      await Promise.resolve();
      draw(images);
    }
    expect(container.querySelector(".chat-image-skeleton")).toBeNull();
    expect(imageElement()?.getAttribute("src")).toBe(src);
    if (!managed) {
      expect(imageElement()).toBe(loaded);
    }
    expect(fetch).toHaveBeenCalledOnce();
  },
);

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
  unmount();
  await Promise.resolve();
  expect(loaded.parentNode).toBeNull();
  expect(removeListener.mock.calls.map(([type, listener]) => [type, listener])).toEqual(
    expect.arrayContaining([
      ["load", expect.any(Function)],
      ["error", expect.any(Function)],
    ]),
  );
  if (change === "expiry") {
    await vi.advanceTimersByTimeAsync(300_001);
  } else if (change === "connectionEpoch") {
    options.connectionEpoch = 2;
  } else {
    options[change] = "after";
  }
  draw(images, options);
  expect(imageElement()).toBeNull();
  expect(fetch).toHaveBeenCalledOnce();
  intersections.at(-1)!();
  await vi.advanceTimersByTimeAsync(0);
  expect(imageElement()).not.toBe(loaded);
  expect(fetch).toHaveBeenCalledTimes(2);
});

it("admits on focus without replacing the pending control or opening an empty preview", async () => {
  const metadata = createDeferred<Response>();
  const fetch = vi.fn(() => metadata.promise);
  vi.stubGlobal("fetch", fetch);
  const onOpenImage = vi.fn<NonNullable<ImageRenderOptions["onOpenImage"]>>();
  draw([{ url: `/tmp/${crypto.randomUUID()}.png` }], { onOpenImage });
  const button = imageButton();
  expect(button.disabled).toBe(false);
  expect(button.getAttribute("aria-disabled")).toBe("true");
  expect(fetch).not.toHaveBeenCalled();

  button.focus();
  flush();
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
  const source = managedSource();
  const fetch = vi.fn(async () => imageResponse());
  vi.stubGlobal("fetch", fetch);
  let opened: ImageLightboxItem | undefined;
  draw([{ url: "data:image/png;base64,cG5n" }, { url: source }], {
    onOpenImage: (item) => {
      opened = item;
    },
  });
  imageButton().click();
  expect(fetch).not.toHaveBeenCalled();

  const neighbor = await opened!.gallery!.items[1]!(true);
  expect(neighbor?.src).toMatch(/^blob:/u);
  expect(fetch).toHaveBeenCalledOnce();
  expect(container.querySelectorAll("img")).toHaveLength(1);
  neighbor?.release?.();
});

it("ignores replaced observers and aborts detached artifact resolution before blob fetch", async () => {
  const first = managedSource();
  const second = managedSource();
  const artifact = createDeferred<{ url: string }>();
  const resolveArtifactDownload = vi.fn(() => artifact.promise);
  const fetch = vi.fn(async () => imageResponse());
  vi.stubGlobal("fetch", fetch);
  draw([{ url: first, artifactId: "first" }], { resolveArtifactDownload });
  draw([{ url: second, artifactId: "second" }], { resolveArtifactDownload });

  intersections[0]!();
  expect(resolveArtifactDownload).not.toHaveBeenCalled();
  intersections[1]!();
  flush();
  expect(resolveArtifactDownload).toHaveBeenCalledOnce();
  unmount();
  artifact.resolve({ url: second });
  await vi.advanceTimersByTimeAsync(0);

  expect(fetch).not.toHaveBeenCalled();
  expect(imageElement()).toBeNull();
});

describe("message attachment availability", () => {
  const panes: { container: HTMLElement; draw: () => void; unmount: () => void }[] = [];
  afterEach(() => {
    for (const pane of panes.splice(0)) {
      pane.unmount();
      releaseChatMediaResourceOwner(pane.draw);
      pane.container.remove();
    }
  });
  function mountPane(source: string, options: ImageRenderOptions) {
    const target = document.body.appendChild(document.createElement("div"));
    const images = () => [{ url: source, width: 1200, height: 800 }];
    const redraw = () =>
      root.update({ images: images(), options: { ...options, mediaOwner: redraw } });
    const root = mountImages(
      { images: images(), options: { ...options, mediaOwner: redraw } },
      target,
    );
    const pane = { container: target, draw: redraw, unmount: root.unmount };
    panes.push(pane);
    intersections.at(-1)!();
    flush();
    return pane;
  }
  const availabilityTicket = (mediaTicket: string) => ticketResponse(mediaTicket, 60_000);
  it("does not reuse another message's available ticket for the same source", async () => {
    vi.useFakeTimers();
    const source = "/tmp/openclaw/" + crypto.randomUUID() + ".png";
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(availabilityTicket("readable-message-ticket"))
      .mockResolvedValueOnce(
        Response.json({ available: false, reason: "Message unavailable", retryable: false }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const mount = (messageId: string) =>
      mountPane(source, { sessionKey: "agent:main:shared-source", messageId }).container;
    const readable = mount("readable-message");
    await vi.advanceTimersByTimeAsync(0);
    expect(readable.querySelector("img")?.getAttribute("src")).toContain(
      "mediaTicket=readable-message-ticket",
    );

    const unavailable = mount("unavailable-message");
    await vi.advanceTimersByTimeAsync(0);
    expect(unavailable.querySelector("img")).toBeNull();
    expect(unavailable.querySelector(".chat-assistant-attachment-card--blocked")).not.toBeNull();
    expect(readable.querySelector("img")?.getAttribute("src")).toContain(
      "mediaTicket=readable-message-ticket",
    );
    expect(
      fetchMock.mock.calls.map(([url]) =>
        new URL(url instanceof Request ? url.url : url, window.location.origin).searchParams.get(
          "messageId",
        ),
      ),
    ).toEqual(["readable-message", "unavailable-message"]);
  });

  it("does not let an aborted late renewal replace a newly mounted pane retry", async () => {
    vi.useFakeTimers();
    const startedAt = Date.parse("2026-09-19T12:00:00Z");
    vi.setSystemTime(startedAt);
    const source = "/tmp/openclaw/" + crypto.randomUUID() + ".png";
    const retry = createDeferred<Response>();
    let renewalSignal: AbortSignal | undefined;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(availabilityTicket("original"))
      .mockImplementationOnce(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            renewalSignal = init?.signal ?? undefined;
            renewalSignal?.addEventListener(
              "abort",
              () => reject(new DOMException("retry superseded renewal", "AbortError")),
              { once: true },
            );
          }),
      )
      .mockReturnValueOnce(retry.promise);
    vi.stubGlobal("fetch", fetchMock);
    const options = { sessionKey: "renewal-retry-proof", agentId: "main" };
    const first = mountPane(source, options);
    await vi.advanceTimersByTimeAsync(0);
    expect(first.container.querySelector("img")?.getAttribute("src")).toContain(
      "mediaTicket=original",
    );

    // A background tab resumes after its scheduled refresh, then a second pane
    // mounts after expiry while that late renewal is still in flight.
    vi.setSystemTime(startedAt + 59_000);
    first.draw();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.setSystemTime(startedAt + 60_001);
    const second = mountPane(source, options);
    const retryButton = second.container.querySelector<HTMLButtonElement>(
      ".chat-assistant-attachment-card__retry",
    );
    expect(retryButton).not.toBeNull();
    retryButton!.click();
    expect(renewalSignal?.aborted).toBe(true);
    flush();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(0);

    expect(resolveAssistantAttachmentAvailability(source, options).status).toBe("checking");
    expect(second.container.querySelector(".chat-assistant-attachment-card__retry")).toBeNull();
    retry.resolve(availabilityTicket("retry-success"));
    await vi.advanceTimersByTimeAsync(0);
    for (const { container: target } of panes) {
      expect(target.querySelector("img")?.getAttribute("src")).toContain(
        "mediaTicket=retry-success",
      );
    }
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
