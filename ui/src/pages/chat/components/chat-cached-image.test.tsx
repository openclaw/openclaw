/* @vitest-environment jsdom */
import { Blob as NodeBlob } from "node:buffer";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ChatRowDisplayFacts } from "../../../lib/chat/row-display-facts.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { MessageImageAction, MessageImages } from "./chat-message-images-solid.tsx";
import {
  imageResponse,
  managedSource,
  stubObjectUrls,
  ticketResponse,
} from "./chat-message-media.test-helpers.ts";
import { ChatRowDisplayContext } from "./chat-row-display-context.ts";

beforeEach(() => vi.stubGlobal("Blob", NodeBlob));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("retains scoped display-only thumbnail bytes without authorizing a read or action", () => {
  const source = managedSource("cached-image");
  const artifactId = "artifact_managed_image_cached-image";
  const key = JSON.stringify([artifactId, source, 480]);
  const thumbnail = new Blob(["synthetic thumbnail"], { type: "image/webp" });
  const facts: ChatRowDisplayFacts = {
    images: { [key]: { width: 480, height: 240, rendition: 480, thumbnail } },
  };
  const write = vi.fn((update: Partial<ChatRowDisplayFacts>) => Object.assign(facts, update));
  const [scope, setScope] = createSignal("gateway/account-a/session/cached-image");
  const row = { read: () => ({ scope: scope(), facts }), write };
  const revoke = stubObjectUrls(() => "blob:cached-thumbnail");
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  const onOpenImage = vi.fn();
  const [live, setLive] = createSignal(false);
  const view = mountSolid(() => (
    <ChatRowDisplayContext value={() => row}>
      <MessageImages
        images={[{ url: source, artifactId }]}
        options={{
          mediaReadAllowed: live(),
          connectionEpoch: live() ? 2 : 1,
          policyKey: live() ? "live-policy" : "cached-policy",
          authToken: live() ? "synthetic-live-token" : undefined,
          onOpenImage,
        }}
      />
      <MessageImageAction
        image={{ url: source, artifactId }}
        options={{ mediaReadAllowed: live(), onOpenImage }}
        render={(action) => <button class="catalog-image" onClick={() => action().onOpen?.()} />}
      />
    </ChatRowDisplayContext>
  ));
  try {
    let image = view.container.querySelector("img");
    expect(image?.getAttribute("src")).toBe("blob:cached-thumbnail");
    expect(view.container.querySelector<HTMLElement>(".chat-image-frame")?.style.cssText).toContain(
      "--chat-image-ratio: 400 / 200",
    );
    const button = view.container.querySelector<HTMLButtonElement>(".chat-message-image-button")!;
    button.click();
    view.container.querySelector<HTMLButtonElement>(".catalog-image")!.click();
    expect(onOpenImage).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    setLive(true);
    flush();
    expect(view.container.querySelector("img")).toBe(image);
    expect(image?.getAttribute("src")).toBe("blob:cached-thumbnail");
    expect(fetch).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    setScope("gateway/account-b/session/cached-image");
    flush();
    expect(view.container.querySelector("img")).not.toBe(image);
    image = view.container.querySelector("img");
    setLive(false);
    flush();
    image?.dispatchEvent(new Event("error"));
    flush();
    expect(facts.images?.[key]?.thumbnail).toBeUndefined();
    expect(view.container.querySelector("img")).toBeNull();
    expect(view.container.querySelector(".chat-image-skeleton")).not.toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    view.unmount();
  }
  expect(revoke).toHaveBeenCalledWith("blob:cached-thumbnail");
});

it("records displayed bytes only from HTTP cache without replacing the live image", async () => {
  vi.stubGlobal("IntersectionObserver", undefined);
  const source = `media://inbound/${crypto.randomUUID()}.png`;
  const key = JSON.stringify([null, source, 480]);
  const [facts, setFacts] = createSignal<ChatRowDisplayFacts>({});
  const row = {
    read: () => ({ scope: "gateway/account/session/live-image", facts: facts() }),
    write: (update: Partial<ChatRowDisplayFacts>) =>
      setFacts((previous) => ({ ...previous, ...update })),
  };
  const createUrl = vi.fn(() => "blob:recorded-thumbnail");
  stubObjectUrls(createUrl);
  const fetch = vi.fn(async (_url: string, init?: RequestInit) =>
    init?.cache === "only-if-cached" ? imageResponse() : ticketResponse("synthetic-live-ticket"),
  );
  vi.stubGlobal("fetch", fetch);
  const [live, setLive] = createSignal(true);
  const mediaOwner = vi.fn();
  const view = mountSolid(() => (
    <ChatRowDisplayContext value={() => row}>
      <MessageImages
        images={[{ url: source }]}
        options={{ mediaReadAllowed: live(), mediaOwner, authToken: "synthetic-live-token" }}
      />
    </ChatRowDisplayContext>
  ));
  try {
    await waitForSolid(() => expect(view.container.querySelector("img")).not.toBeNull());
    const image = view.container.querySelector("img")!;
    const frame = view.container.querySelector<HTMLElement>(".chat-image-frame")!;
    const reservedSize = frame.style.cssText;
    const displayedSource = image.getAttribute("src");
    expect(displayedSource).toContain("mediaTicket=synthetic-live-ticket");
    Object.defineProperties(image, {
      naturalWidth: { value: 480 },
      naturalHeight: { value: 240 },
    });
    image.dispatchEvent(new Event("load"));
    await waitForSolid(() => expect(facts().images?.[key]?.thumbnail).toBeInstanceOf(Blob));
    expect(facts().images?.[key]).toMatchObject({ width: 480, height: 240 });
    expect(frame.style.cssText).toBe(reservedSize);
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining("variant=thumbnail"), {
      cache: "only-if-cached",
      mode: "same-origin",
      credentials: "same-origin",
    });
    expect(view.container.querySelector("img")).toBe(image);
    expect(image.getAttribute("src")).toBe(displayedSource);
    expect(createUrl).not.toHaveBeenCalled();
    setLive(false);
    flush();
    expect(view.container.querySelector(".chat-image-skeleton")).toBeNull();
    expect(view.container.querySelector("img")).toBe(image);
    expect(image.getAttribute("src")).toBe("blob:recorded-thumbnail");
    expect(fetch).toHaveBeenCalledTimes(2);
  } finally {
    view.unmount();
  }
});
