/* @vitest-environment jsdom */

import { createSignal } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import { requestVideoPoster } from "../../../lib/media/video-poster.ts";
import { ContentPresentation } from "../../../lib/solid/presentation.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { stubManualIntersectionObserver } from "./chat-media-observer.test-support.ts";
import { loadAssistantAttachmentAvailability } from "./chat-message-attachment-availability.ts";
import { AssistantAttachments } from "./chat-message-attachments-solid.tsx";
import { MessageImages } from "./chat-message-images-view.tsx";
import { stubObjectUrls } from "./chat-message-media.test-helpers.ts";
import type { AttachmentItem, ImageBlock, ImageRenderOptions } from "./chat-message-media.ts";
import { MessageVideoPreview } from "./chat-message-video-preview-solid.tsx";

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
function fetchResponses(
  responses: (Response | Promise<Response>)[],
  fallback?: Response | Promise<Response>,
) {
  const fetcher = vi.fn<typeof fetch>();
  responses.forEach((response) => fetcher.mockReturnValueOnce(Promise.resolve(response)));
  if (fallback) {
    fetcher.mockReturnValue(Promise.resolve(fallback));
  }
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}

const commentAttachment = (url: string): AttachmentItem => ({
  type: "attachment",
  attachment: { kind: "document", label: "selection-comment.txt", mimeType: "text/plain", url },
});
const commentOptions: ImageRenderOptions = {
  sessionKey: "agent:main:first",
  authToken: "test-token",
  policyKey: "first-policy",
  connectionEpoch: 1,
  messageSendId: "same-send",
};
function mountComments(initial: AttachmentItem[], inline = true, initialOptions = commentOptions) {
  const [comments, setComments] = createSignal(initial);
  const [options, setOptions] = createSignal(initialOptions);
  const [presentation, setPresentation] = createSignal({ inline });
  const view = mountSolid(() => (
    <AssistantAttachments
      inlinePlayback={false}
      inlineComments={presentation().inline}
      attachments={comments()}
      options={options()}
    />
  ));
  return { ...view, setComments, setOptions, setPresentation };
}

it.each([
  { retirement: "replacement", inline: false },
  { retirement: "removal", inline: true },
])(
  "reveals comments independently and cancels stale reads on $retirement (inline: $inline)",
  async ({ retirement, inline }) => {
    const first = createDeferred<Response>();
    const second = createDeferred<Response>();
    const fetchMock = fetchResponses([first.promise, second.promise]);
    const initialComments = ["first", "second"].map((name) =>
      commentAttachment(`/__openclaw__/fixtures/${name}.txt`),
    );
    const view = mountComments(initialComments, inline, {});
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
    view.setPresentation({ inline });
    flush();
    expect(view.container.querySelector("blockquote button")).toBe(selection);
    const pendingSignal = fetchMock.mock.calls[0]![1]!.signal!;
    view.setComments(initialComments.slice());
    flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(pendingSignal.aborted).toBe(false);
    if (retirement === "replacement") {
      view.setComments([]);
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

it.each([
  ["session", { sessionKey: "agent:main:second" }],
  ["auth", { authToken: "replacement-token" }],
  ["policy", { policyKey: "second-policy" }],
  ["connection", { connectionEpoch: 2 }],
  ["send", { messageSendId: "another-send" }],
] as const)("clears the previous annotation when %s changes", async (_name, changed) => {
  const pending = createDeferred<Response>();
  const fetchMock = fetchResponses([commentResponse("Original passage")], pending.promise);
  const view = mountComments([commentAttachment("blob:scope")]);
  await waitForSolid(() => expect(view.container.textContent).toContain("Original passage"));
  view.setOptions({ ...commentOptions, ...changed });
  await waitForSolid(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  expect(view.container.textContent).not.toContain("Original passage");
  view.unmount();
  pending.resolve(commentResponse("Replacement passage"));
});

it.each(["denied", "oversized"])(
  "clears a retained annotation when its replacement is %s",
  async (reason) => {
    vi.stubGlobal("IntersectionObserver", undefined);
    const fetchMock = fetchResponses(
      [commentResponse("Original passage")],
      Response.json({ available: false, reason: "Unavailable annotation", retryable: false }),
    );
    const item = commentAttachment("blob:annotation");
    const view = mountComments([item]);
    await waitForSolid(() => expect(view.container.textContent).toContain("Original passage"));
    view.setComments([
      {
        ...item,
        attachment: {
          ...item.attachment,
          ...(reason === "denied"
            ? { url: "media://inbound/denied.txt" }
            : { sizeBytes: 256 * 1024 + 1 }),
        },
      },
    ]);
    await waitForSolid(() =>
      expect(view.container.querySelector(".chat-assistant-attachment-card")).not.toBeNull(),
    );
    expect(view.container.textContent).not.toContain("Original passage");
    expect(fetchMock).toHaveBeenCalledTimes(reason === "denied" ? 2 : 1);
  },
);

it("preserves staggered canonical comments and clears the old set on removal", async () => {
  const firstRead = createDeferred<Response>();
  const secondRead = createDeferred<Response>();
  const replacement = createDeferred<Response>();
  const fetchMock = fetchResponses(
    [
      commentResponse("First passage"),
      commentResponse("Second passage"),
      firstRead.promise,
      secondRead.promise,
    ],
    replacement.promise,
  );
  const indexes = [0, 1];
  const view = mountComments(
    indexes.map((index) => commentAttachment(`blob:local-comment-${index}`)),
  );
  const selected = () =>
    Array.from(view.container.querySelectorAll(".chat-sent-comments-inline__selection")).map(
      (element) => element.textContent,
    );
  try {
    await waitForSolid(() => expect(selected()).toEqual(["First passage", "Second passage"]));
    const canonical = indexes.map((index) =>
      commentAttachment(`/__openclaw__/fixtures/canonical-comment-${index}.txt`),
    );
    view.setComments(canonical);
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
    view.setComments(canonical.slice(1));
    flush();
    expect(selected()).toEqual([]);
  } finally {
    firstRead.resolve(commentResponse("First canonical passage"));
    secondRead.resolve(commentResponse("Second canonical passage"));
    replacement.resolve(commentResponse("Replacement passage"));
    view.unmount();
  }
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
  const fetchMock = fetchResponses([Response.json({ available: true }), retry.promise]);
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
  stubManualIntersectionObserver((_target, notify) => intersections.push(notify));
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
