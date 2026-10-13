/* @vitest-environment jsdom */

import { createMemo, createSignal } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import { requestVideoPoster } from "../../../lib/media/video-poster.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { AssistantAttachments, MessageAttachment } from "./chat-message-attachments-solid.tsx";
import { MessageImages } from "./chat-message-images-solid.tsx";
import {
  releaseChatMediaResourceSubscriber,
  type AssistantAttachmentItem,
  type ImageBlock,
} from "./chat-message-media.ts";
import { MessageVideoPreview } from "./chat-message-video-preview-solid.tsx";

vi.mock("../../../lib/media/video-poster.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../lib/media/video-poster.ts")>()),
  requestVideoPoster: vi.fn(),
}));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("keeps the focused native image control and decoded node when gallery metadata changes", () => {
  const source = "data:image/png;base64,cG5n";
  const [images, setImages] = createSignal<ImageBlock[]>([
    { url: source, alt: "Before", width: 800, height: 600 },
  ]);
  const view = mountSolid(() => <MessageImages images={images()} />);
  const button = view.getByRole("button", { name: "Open image Before" });
  const image = view.container.querySelector("img")!;
  button.focus();
  setImages([{ url: source, alt: "After", width: 1600, height: 1200 }]);
  flush();
  expect(view.getByRole("button", { name: "Open image After" })).toBe(button);
  expect(document.activeElement).toBe(button);
  expect(view.container.querySelector("img")).toBe(image);
  expect(image.alt).toBe("After");
  expect(image.width).toBe(1600);
});

it("cancels an offscreen poster request and releases the visible poster on unmount", async () => {
  const intersections: ((visible: boolean) => void)[] = [];
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback: IntersectionObserverCallback) {
        intersections.push((isIntersecting) =>
          callback(
            [{ isIntersecting } as IntersectionObserverEntry],
            this as unknown as IntersectionObserver,
          ),
        );
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  const createObjectURL = vi.fn(() => "blob:video-poster");
  const revokeObjectURL = vi.fn();
  const NativeURL = URL;
  vi.stubGlobal(
    "URL",
    class extends NativeURL {
      static override createObjectURL = createObjectURL;
      static override revokeObjectURL = revokeObjectURL;
    },
  );
  const first = createDeferred<Blob | null>();
  const second = createDeferred<Blob | null>();
  vi.mocked(requestVideoPoster)
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise);
  const view = mountSolid(() => (
    <MessageVideoPreview
      key="video"
      src="/fixture.mp4"
      label="Fixture video"
      onOpen={() => {}}
      fallback={<p>Preview unavailable</p>}
    />
  ));
  expect(requestVideoPoster).not.toHaveBeenCalled();
  intersections[0]!(true);
  const request = vi.mocked(requestVideoPoster).mock.calls[0]![0];
  intersections[0]!(false);
  expect(request.signal?.aborted).toBe(true);
  first.resolve(new Blob(["stale"]));
  await first.promise;
  flush();
  expect(createObjectURL).not.toHaveBeenCalled();
  intersections[0]!(true);
  second.resolve(new Blob(["poster"]));
  await waitForSolid(() =>
    expect(view.container.querySelector("img")?.getAttribute("src")).toBe("blob:video-poster"),
  );
  view.unmount();
  expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:video-poster");
});

it("preserves the playback element when the same attachment snapshot is refreshed", () => {
  const attachment: AssistantAttachmentItem = {
    type: "attachment",
    attachment: {
      kind: "audio",
      label: "Recording",
      url: "https://media.example.test/recording.mp3",
    },
  };
  const [attachments, setAttachments] = createSignal([attachment]);
  const view = mountSolid(() => <AssistantAttachments attachments={attachments()} options={{}} />);
  const player = view.container.querySelector("openclaw-chat-audio-player");
  expect(player).not.toBeNull();
  setAttachments([
    { ...attachment, attachment: { ...attachment.attachment, label: "Updated recording" } },
  ]);
  flush();
  expect(view.container.querySelector("openclaw-chat-audio-player")).toBe(player);
  expect(player?.label).toBe("Updated recording");
});

it.each(["document", "audio", "video"] as const)(
  "retains the focused %s download while admitting its source",
  async (kind) => {
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    const url = `/api/chat/media/outgoing/agent%3Amain%3Amain/${crypto.randomUUID()}/full`;
    const pending = createDeferred<{ url: string }>();
    const resolveArtifactDownload = vi.fn(() => pending.promise);
    const [revision, setRevision] = createSignal(0);
    const onRequestUpdate = () => setRevision((value) => value + 1);
    const options = createMemo(() => {
      revision();
      return { resolveArtifactDownload, onRequestUpdate };
    });
    const view = mountSolid(() => (
      <MessageAttachment
        item={{
          type: "attachment",
          attachment: { kind, label: `${kind} recording`, url, artifactId: `fixture-${kind}` },
        }}
        options={options()}
        presentation="card"
      />
    ));
    try {
      const download = view.container.querySelector<HTMLAnchorElement>("a[download]")!;
      expect(download).not.toBeNull();
      expect(download.hasAttribute("href")).toBe(false);
      download.focus();
      await waitForSolid(() => expect(resolveArtifactDownload).toHaveBeenCalledOnce());
      const readyUrl = `${url}?mediaTicket=fixture`;
      pending.resolve({ url: readyUrl });
      await waitForSolid(() =>
        expect(view.container.querySelector("a[download]")?.getAttribute("href")).toBe(readyUrl),
      );
      expect(view.container.querySelector("a[download]")).toBe(download);
      expect(document.activeElement).toBe(download);
    } finally {
      view.unmount();
      releaseChatMediaResourceSubscriber(onRequestUpdate);
    }
  },
);
