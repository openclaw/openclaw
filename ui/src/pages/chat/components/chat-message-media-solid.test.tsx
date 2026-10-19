/* @vitest-environment jsdom */

import { createSignal } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import { requestVideoPoster } from "../../../lib/media/video-poster.ts";
import { ContentPresentation } from "../../../lib/solid/presentation.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { loadAssistantAttachmentAvailability } from "./chat-message-attachment-availability.ts";
import { AssistantAttachments, MessageAttachment } from "./chat-message-attachments-solid.tsx";
import { MessageImages } from "./chat-message-images-solid.tsx";
import type { AssistantAttachmentItem, AttachmentItem, ImageBlock } from "./chat-message-media.ts";
import { MessageVideoPreview } from "./chat-message-video-preview-solid.tsx";
import { SentCommentAttachments } from "./chat-sent-comments.tsx";

vi.mock("../../../lib/media/video-poster.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../lib/media/video-poster.ts")>()),
  requestVideoPoster: vi.fn(),
}));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it.each(["replacement", "removal"] as const)(
  "reveals comments independently and cancels stale reads on %s",
  async (retirement) => {
    const first = createDeferred<Response>();
    const second = createDeferred<Response>();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    vi.stubGlobal("fetch", fetchMock);
    const initialComments: AttachmentItem[] = ["first", "second"].map((name) => ({
      type: "attachment",
      attachment: { kind: "document", label: name, url: `https://example.test/${name}.txt` },
    }));
    const [comments, setComments] = createSignal(initialComments);
    const view = mountSolid(() => (
      <SentCommentAttachments
        comments={comments()}
        options={{}}
        resolve={(item) => ({
          identity: item.attachment.url,
          src: item.attachment.url,
          fallback: () => <span>Unavailable</span>,
        })}
      />
    ));
    expect(fetchMock).not.toHaveBeenCalled();
    view.getByRole("button").click();
    await waitForSolid(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    second.resolve(
      new Response(
        "Selected text:\nsecond source\n\nSource session: agent:main:fixture\nDOM text UTF-16 range: [0, 13)",
      ),
    );
    await waitForSolid(() => expect(document.body.textContent).toContain("second source"));
    expect(document.body.textContent).toContain("Loading");
    const pendingSignal = fetchMock.mock.calls[0]![1]!.signal!;
    setComments(initialComments.slice());
    flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(pendingSignal.aborted).toBe(false);
    if (retirement === "replacement") {
      setComments([]);
      flush();
    } else {
      view.unmount();
    }
    expect(pendingSignal.aborted).toBe(true);
    first.resolve(
      new Response(
        "Selected text:\nfirst source\n\nSource session: agent:main:fixture\nDOM text UTF-16 range: [0, 12)",
      ),
    );
    await first.promise;
    flush();
    expect(document.body.textContent).not.toContain("first source");
  },
);

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

it("retries a standalone native image after a failed preview", async () => {
  const source = `/tmp/standalone-preview-${crypto.randomUUID()}.png`;
  const retry = createDeferred<Response>();
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ available: true }))
    .mockImplementationOnce(() => retry.promise);
  vi.stubGlobal("fetch", fetchMock);
  await loadAssistantAttachmentAvailability(source);
  const view = mountSolid(() => <MessageImages images={[{ url: source }]} />);
  await waitForSolid(() => expect(view.container.querySelector("img")).not.toBeNull());
  const image = view.container.querySelector("img")!;
  expect(image).not.toBeNull();
  image.dispatchEvent(new Event("error"));
  flush();
  view.getByRole("button", { name: /^Retry$/ }).click();
  await waitForSolid(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  expect(view.container.querySelector("img")).toBeNull();
  retry.resolve(Response.json({ available: true }));
  await waitForSolid(() => expect(view.container.querySelector("img")).not.toBeNull());
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it("cancels an offscreen poster request and releases a parked poster without replacing its button", async () => {
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
    .mockReturnValueOnce(second.promise)
    .mockResolvedValueOnce(new Blob(["reopened poster"]));
  const [presented, setPresented] = createSignal(true);
  const view = mountSolid(() => (
    <ContentPresentation value={presented}>
      <MessageVideoPreview
        key="video"
        src="/fixture.mp4"
        label="Fixture video"
        onOpen={() => {}}
        fallback={<p>Preview unavailable</p>}
      />
    </ContentPresentation>
  ));
  const button = view.getByRole("button");
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
  setPresented(false);
  flush();
  expect(view.container.querySelector("img")).toBeNull();
  expect(view.getByRole("button")).toBe(button);
  expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:video-poster");
  setPresented(true);
  flush();
  expect(view.getByRole("button")).toBe(button);
  intersections[1]!(true);
  await waitForSolid(() => expect(view.container.querySelector("img")).not.toBeNull());
  view.unmount();
  expect(revokeObjectURL).toHaveBeenCalledTimes(2);
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
    const options = { resolveArtifactDownload };
    const view = mountSolid(() => (
      <MessageAttachment
        item={{
          type: "attachment",
          attachment: { kind, label: `${kind} recording`, url, artifactId: `fixture-${kind}` },
        }}
        options={options}
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
    }
  },
);
