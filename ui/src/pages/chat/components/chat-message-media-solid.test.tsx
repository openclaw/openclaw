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
import { managedSource, stubObjectUrls } from "./chat-message-media.test-helpers.ts";
import type { AttachmentItem, ImageBlock, ImageRenderOptions } from "./chat-message-media.ts";
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
function attachment(
  kind: AttachmentItem["attachment"]["kind"],
  label: string,
  url: string,
  artifactId?: string,
): AttachmentItem {
  return {
    type: "attachment",
    attachment: { kind, label, url, ...(artifactId ? { artifactId } : {}) },
  };
}
const commentResponse = (text: string) =>
  new Response(
    `Selected text:\n${text}\n\nSource session: agent:main:fixture\nDOM text UTF-16 range: [0, ${text.length})`,
  );

it.each([
  { retirement: "replacement", inline: false },
  { retirement: "removal", inline: false },
  { retirement: "replacement", inline: true },
  { retirement: "removal", inline: true },
])(
  "reveals comments independently and cancels stale reads on $retirement (inline: $inline)",
  async ({ retirement, inline }) => {
    const first = createDeferred<Response>();
    const second = createDeferred<Response>();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    vi.stubGlobal("fetch", fetchMock);
    const initialComments = ["first", "second"].map((name) =>
      attachment("document", name, `/__openclaw__/fixtures/${name}.txt`),
    );
    const [comments, setComments] = createSignal(initialComments);
    const [presentation, setPresentation] = createSignal({ inline });
    const view = mountSolid(() => (
      <SentCommentAttachments
        inline={presentation().inline}
        comments={comments()}
        options={{}}
        fallback={() => <span>Unavailable</span>}
      />
    ));
    if (!inline) {
      expect(fetchMock).not.toHaveBeenCalled();
      view.getByRole("button").click();
    }
    await waitForSolid(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    second.resolve(commentResponse("second source"));
    await waitForSolid(() => expect(document.body.textContent).toContain("second source"));
    expect(document.body.textContent).toContain("Loading");
    if (inline) {
      expect(view.container.querySelector("blockquote button")?.textContent).toBe("second source");
    }
    const selection = view.container.querySelector("blockquote button");
    setPresentation({ inline });
    flush();
    expect(view.container.querySelector("blockquote button")).toBe(selection);
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
    first.resolve(commentResponse("first source"));
    await first.promise;
    flush();
    expect(document.body.textContent).not.toContain("first source");
  },
);

it.each(["same send", "session", "auth", "policy", "connection", "different send", "denied"])(
  "keeps annotation admission and isolates retained text for %s",
  async (change) => {
    let reveal: (() => void) | undefined;
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(callback: IntersectionObserverCallback) {
          reveal = () =>
            callback(
              [{ isIntersecting: true } as IntersectionObserverEntry],
              this as unknown as IntersectionObserver,
            );
        }
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    const canonicalRead = createDeferred<Response>();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(commentResponse("Original passage"))
      .mockResolvedValueOnce(
        Response.json(
          change === "denied"
            ? {
                available: false,
                reason: "Unavailable annotation",
                retryable: false,
              }
            : {
                available: true,
                mediaTicket: "test-ticket",
                mediaTicketExpiresAt: new Date(Date.now() + 60_000).toISOString(),
              },
        ),
      )
      .mockReturnValueOnce(canonicalRead.promise);
    vi.stubGlobal("fetch", fetchMock);
    const local = attachment("document", "selection-comment.txt", "blob:local-annotation");
    const canonical = attachment(
      "document",
      "selection-comment.txt",
      "media://inbound/annotation.txt",
    );
    const [comments, setComments] = createSignal([local]);
    const initialOptions: ImageRenderOptions = {
      sessionKey: "agent:main:first",
      agentId: "main",
      connectionEpoch: 1,
      authToken: "test-token",
      policyKey: "first-policy",
      localSubmission: true,
      messageSendId: "same-send",
    };
    const [options, setOptions] = createSignal(initialOptions);
    const view = mountSolid(() => (
      <SentCommentAttachments
        inline
        comments={comments()}
        options={options()}
        fallback={() => <span>Unavailable annotation</span>}
      />
    ));
    await waitForSolid(() => expect(view.container.textContent).toContain("Original passage"));
    setOptions({
      ...initialOptions,
      localSubmission: undefined,
      canonicalMessageKey: "canonical-message",
      ...(change === "session" ? { sessionKey: "agent:main:second" } : {}),
      ...(change === "auth" ? { authToken: "replacement-test-token" } : {}),
      ...(change === "policy" ? { policyKey: "second-policy" } : {}),
      ...(change === "connection" ? { connectionEpoch: 2 } : {}),
      ...(change === "different send" ? { messageSendId: "another-send" } : {}),
    });
    setComments([canonical]);
    flush();
    await waitForSolid(() => expect(reveal).toBeDefined());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const retains = change === "same send" || change === "denied";
    expect(view.container.textContent?.includes("Original passage")).toBe(retains);
    reveal!();
    if (change === "denied") {
      await waitForSolid(() =>
        expect(view.container.textContent).toContain("Unavailable annotation"),
      );
      expect(view.container.textContent).not.toContain("Original passage");
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } else {
      await waitForSolid(() => expect(fetchMock).toHaveBeenCalledTimes(3));
      expect(view.container.textContent?.includes("Original passage")).toBe(retains);
      canonicalRead.resolve(commentResponse("Confirmed passage"));
      await waitForSolid(() => expect(view.container.textContent).toContain("Confirmed passage"));
    }
  },
);

it("rechecks the byte limit when annotation metadata changes under the same URL", async () => {
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(commentResponse("Original passage"));
  vi.stubGlobal("fetch", fetchMock);
  const item = attachment("document", "selection-comment.txt", "blob:annotation-metadata");
  const [comments, setComments] = createSignal([item]);
  const view = mountSolid(() => (
    <SentCommentAttachments
      inline
      comments={comments()}
      options={{ messageSendId: "metadata-send" }}
      fallback={() => <span>Unavailable annotation</span>}
    />
  ));
  await waitForSolid(() => expect(view.container.textContent).toContain("Original passage"));
  setComments([{ ...item, attachment: { ...item.attachment, sizeBytes: 256 * 1024 + 1 } }]);
  await waitForSolid(() => expect(view.container.textContent).toContain("Unavailable annotation"));
  expect(view.container.textContent).not.toContain("Original passage");
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it.each(["removed", "reordered"])(
  "preserves ordered canonical comments and clears the old set when %s",
  async (change) => {
    const firstRead = createDeferred<Response>();
    const secondRead = createDeferred<Response>();
    const replacement = createDeferred<Response>();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(commentResponse("First passage"))
      .mockResolvedValueOnce(commentResponse("Second passage"))
      .mockReturnValueOnce(firstRead.promise)
      .mockReturnValueOnce(secondRead.promise)
      .mockImplementation(() => replacement.promise);
    vi.stubGlobal("fetch", fetchMock);
    const labels = ["first-comment.txt", "second-comment.txt"];
    const [comments, setComments] = createSignal(
      labels.map((label, index) => attachment("document", label, `blob:local-comment-${index}`)),
    );
    const view = mountSolid(() => (
      <SentCommentAttachments
        inline
        comments={comments()}
        options={{ messageSendId: "ordered-send" }}
        fallback={() => <span>Unavailable annotation</span>}
      />
    ));
    const selected = () =>
      Array.from(view.container.querySelectorAll(".chat-sent-comments-inline__selection")).map(
        (element) => element.textContent,
      );
    try {
      await waitForSolid(() => expect(selected()).toEqual(["First passage", "Second passage"]));
      const canonical = labels.map((label, index) =>
        attachment("document", label, `/__openclaw__/fixtures/canonical-comment-${index}.txt`),
      );
      setComments(canonical);
      await waitForSolid(() => expect(fetchMock).toHaveBeenCalledTimes(4));
      expect(selected()).toEqual(["First passage", "Second passage"]);
      firstRead.resolve(commentResponse("First canonical passage"));
      await waitForSolid(() =>
        expect(selected()).toEqual(["First canonical passage", "Second passage"]),
      );
      secondRead.resolve(commentResponse("Second canonical passage"));
      await waitForSolid(() =>
        expect(selected()).toEqual(["First canonical passage", "Second canonical passage"]),
      );
      setComments(change === "removed" ? canonical.slice(1) : canonical.toReversed());
      flush();
      expect(selected()).toEqual([]);
    } finally {
      firstRead.resolve(commentResponse("First canonical passage"));
      secondRead.resolve(commentResponse("Second canonical passage"));
      replacement.resolve(commentResponse("Replacement passage"));
      view.unmount();
    }
  },
);

it("does not read a cold hidden annotation or admit it after removal", async () => {
  let show: (() => void) | undefined;
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback: IntersectionObserverCallback) {
        show = () =>
          callback(
            [{ isIntersecting: true } as IntersectionObserverEntry],
            this as unknown as IntersectionObserver,
          );
      }
      observe() {}
      disconnect() {}
    },
  );
  const fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetchMock);
  const view = mountSolid(() => (
    <SentCommentAttachments
      inline
      comments={[attachment("document", "selection-comment.txt", "media://inbound/hidden.txt")]}
      options={{ sessionKey: "agent:main:hidden", messageId: "hidden-message" }}
      fallback={() => <span>Unavailable annotation</span>}
    />
  ));
  await waitForSolid(() => expect(show).toBeDefined());
  expect(fetchMock).not.toHaveBeenCalled();
  view.unmount();
  show!();
  await Promise.resolve();
  expect(fetchMock).not.toHaveBeenCalled();
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
  expect(image).toMatchObject({ alt: "After", width: 1600 });
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
  view.container.querySelector("img")!.dispatchEvent(new Event("error"));
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
  const revokeObjectURL = stubObjectUrls(createObjectURL);
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
  const recording = attachment("audio", "Recording", "https://media.example.test/recording.mp3");
  const [attachments, setAttachments] = createSignal([recording]);
  const view = mountSolid(() => <AssistantAttachments attachments={attachments()} options={{}} />);
  const player = view.container.querySelector("openclaw-chat-audio-player");
  expect(player).not.toBeNull();
  setAttachments([
    { ...recording, attachment: { ...recording.attachment, label: "Updated recording" } },
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
    const url = managedSource();
    const pending = createDeferred<{ url: string }>();
    const resolveArtifactDownload = vi.fn(() => pending.promise);
    const view = mountSolid(() => (
      <MessageAttachment
        item={attachment(kind, `${kind} recording`, url, `fixture-${kind}`)}
        options={{ resolveArtifactDownload }}
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
