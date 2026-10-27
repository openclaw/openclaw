/* @vitest-environment jsdom */
import { createSignal } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import type { ChatRowDisplayFacts } from "../../../lib/chat/row-display-facts.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush } from "../../../test-helpers/solid-settle.ts";
import { GroupedMessage } from "./chat-message-bubble-view.tsx";
import { MessageImageAction } from "./chat-message-images-view.tsx";
import { prepareChatMessageRender } from "./chat-message-markdown-view.tsx";
import { managedSource, stubObjectUrls } from "./chat-message-media.test-helpers.ts";
import { ChatRowDisplayContext } from "./chat-row-display-context.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("paints saved thumbnail bytes and final geometry before live admission, without authorizing an action", () => {
  const source = managedSource("cached-image");
  const artifactId = "artifact_managed_image_cached-image";
  const key = JSON.stringify([artifactId, source, 480]);
  const thumbnail = new Blob(["synthetic thumbnail"], { type: "image/webp" });
  const facts: ChatRowDisplayFacts = {
    images: { [key]: { width: 480, height: 240, rendition: 480, thumbnail } },
  };
  const write = vi.fn((update: Partial<ChatRowDisplayFacts>) => Object.assign(facts, update));
  const row = { read: () => facts, write };
  const revoke = stubObjectUrls(() => "blob:cached-thumbnail");
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  const onOpenImage = vi.fn();
  const [live, setLive] = createSignal(false);
  const view = mountSolid(() => (
    <ChatRowDisplayContext value={() => row}>
      <GroupedMessage
        preparation={prepareChatMessageRender({
          role: "assistant",
          __openclaw: { id: "cached-image" },
          content: [{ type: "image", url: source, artifactId }],
        })}
        messageKey="cached-image"
        options={{
          isStreaming: false,
          showReasoning: false,
          mediaReadAllowed: live(),
          onOpenImage,
          displayFacts: { forRow: () => row },
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
    const image = view.container.querySelector("img");
    expect(image?.getAttribute("src")).toBe("blob:cached-thumbnail");
    expect(view.container.querySelector(".chat-image-skeleton")).toBeNull();
    expect(
      view.container
        .querySelector<HTMLElement>(".chat-image-frame")
        ?.style.getPropertyValue("--chat-image-ratio"),
    ).toBe("400 / 200");
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
