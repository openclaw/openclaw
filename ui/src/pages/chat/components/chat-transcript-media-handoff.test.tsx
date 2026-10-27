/* @vitest-environment jsdom */

import { Buffer } from "node:buffer";
import { expectDefined } from "@openclaw/normalization-core";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { notifyBrowserAuthRestored } from "../../../app/browser-http.ts";
import { createChatSubmissions } from "../../../app/chat-submissions.ts";
import type { ChatAttachment } from "../../../lib/chat/chat-types.ts";
import { ContentPresentation } from "../../../lib/solid/presentation.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { releaseChatAttachmentPayloads } from "../attachment-payload-store.ts";
import { createTestTranscript } from "../chat-view.test-helpers.ts";
import { admitChatSubmission, reduceChatSessionProjection } from "../history-merge.ts";
import { buildInitialChatSubmission, buildLocalUserMessage } from "../user-message-content.ts";
import { releaseChatMediaResourceOwner } from "./chat-message-media.ts";
import type { ChatThreadProps } from "./chat-thread-interactions.ts";
import { ChatThread } from "./chat-thread-view.tsx";
import {
  flushDeferredRowPrune,
  installTranscriptDomMocks,
  resetTranscriptTestDom,
  threadProps,
} from "./chat-transcript.test-support.ts";

const ownedAttachments: ChatAttachment[] = [];
const previewBlobs = new Map<string, Blob>();

function expectImageNodes(actual: HTMLImageElement[], expected: HTMLImageElement[]) {
  expect(actual).toHaveLength(expected.length);
  for (const [index, image] of expected.entries()) {
    expect(actual[index]).toBe(image);
  }
}

function imageEvent(image: HTMLImageElement, event = "load") {
  image.dispatchEvent(new Event(event));
}

async function settleMedia() {
  if (vi.isFakeTimers()) {
    await vi.advanceTimersByTimeAsync(0);
  } else {
    await flushDeferredRowPrune();
  }
}
async function withMediaTimers(run: () => Promise<void>) {
  vi.useFakeTimers();
  try {
    await run();
  } finally {
    vi.clearAllTimers();
    vi.useRealTimers();
  }
}

async function publishedImage(response?: Response) {
  const view = await imageFixture();
  view.publish();
  if (response) {
    await view.receive(response);
  }
  return view;
}

function metadataResponse(available = true, mediaTicket?: string, retryable = false): Response {
  return Response.json({
    available,
    reason: available ? undefined : "Attachment removed",
    retryable,
    ...(mediaTicket
      ? { mediaTicket, mediaTicketExpiresAt: new Date(Date.now() + 31_000).toISOString() }
      : {}),
  });
}

function unreadableMetadataResponse(status = 200): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.error(new TypeError("Connection closed while reading metadata"));
      },
    }),
    { status },
  );
}

function mountTranscriptPane(props: ChatThreadProps) {
  const transcript = createTestTranscript();
  const container = document.body.appendChild(document.createElement("div"));
  const [current, setCurrent] = createSignal(props, { ownedWrite: true });
  const [presented, setPresented] = createSignal(true);
  let root: ReturnType<typeof mountSolid> | undefined;
  const renderPane = () => {
    setCurrent({ ...props, mediaOwner: renderPane });
    flush();
    root ??= mountSolid(
      () => (
        <ContentPresentation value={presented}>
          <ChatThread props={current()} transcript={transcript} />
        </ContentPresentation>
      ),
      { container },
    );
    transcript.update();
    flush();
  };
  const setConnected = (connected: boolean) => {
    if (connected) {
      setPresented(true);
      flush();
      transcript.start();
      transcript.update();
    } else {
      transcript.dispose();
      setPresented(false);
    }
    flush();
  };
  onTestFinished(() => {
    root?.unmount();
    releaseChatMediaResourceOwner(renderPane);
    transcript.dispose();
  });
  renderPane();
  transcript.start();
  flush();
  return { container, renderPane, setConnected };
}

type ImageTranscript = Awaited<ReturnType<typeof imageFixture>>;

function changeImage(
  view: ImageTranscript,
  change: "removal" | "replacement" | "auth" | "connection epoch" | "session",
) {
  if (change === "removal") {
    view.publish({}, []);
  } else if (change === "replacement") {
    view.publish({}, [
      { path: `media://inbound/${crypto.randomUUID()}.png`, contentType: "image/png" },
    ]);
  } else {
    if (change === "auth") {
      view.props.assistantAttachmentAuthToken = "rotated-token";
    } else if (change === "connection epoch") {
      view.props.connectionEpoch = 2;
    } else {
      view.props.sessionKey = "agent:main:other";
    }
    view.renderPane();
  }
}

async function imageFixture(
  factIndexes = [0],
  inlineUrls = ["data:image/png;base64,aW5saW5l"],
  origin: "canonical" | "queued" | "submitted" | "initial receipt" = "canonical",
) {
  const requests: Array<{ resolve: (response: Response) => void; signal?: AbortSignal | null }> =
    [];
  vi.stubGlobal(
    "fetch",
    vi.fn((_source: string, init?: RequestInit) => {
      return new Promise<Response>((resolve) => {
        requests.push({ resolve, signal: init?.signal });
      });
    }),
  );
  const canonical = {
    id: crypto.randomUUID(),
    seq: 1,
    idempotencyKey: "canonical-image-send:user",
    mediaImageLayout: { slots: factIndexes.map((factIndex) => ({ kind: "inline", factIndex })) },
  };
  const input = {
    text: "Cached text",
    createdAt: 1_000,
    runId: "canonical-image-send",
    attachments: inlineUrls.map((dataUrl, index) => ({
      id: crypto.randomUUID(),
      mimeType: "image/png",
      fileName: `image-${index}.png`,
      dataUrl,
    })),
  };
  ownedAttachments.push(...input.attachments);
  const local = expectDefined(buildLocalUserMessage(input), "submitted image message");
  const cached = origin === "canonical" ? { ...local, __openclaw: canonical } : local;
  const owner = {
    sessionKey: "agent:main:main",
    client: {},
    chatSubmissions: createChatSubmissions(),
    chatMessages: [] as unknown[],
  };
  if (origin === "initial receipt") {
    owner.chatSubmissions.retain(
      buildInitialChatSubmission(owner.sessionKey, input, owner.client, input.runId),
    );
    admitChatSubmission(owner, undefined);
  } else if (origin === "submitted") {
    reduceChatSessionProjection(owner, { type: "sendPending", runId: input.runId, message: local });
  }
  const media = Array<{ path: string; contentType: string; fileName?: string } | null>(
    Math.max(...factIndexes) + 1,
  ).fill(null);
  factIndexes.forEach((factIndex, index) => {
    media[factIndex] = {
      path: `media://inbound/${crypto.randomUUID()}.png`,
      contentType: "image/png",
      fileName: `image-${index}.png`,
    };
  });
  const props = threadProps(
    `pane-${crypto.randomUUID()}`,
    owner.sessionKey,
    origin === "canonical" ? [cached] : owner.chatMessages,
    { assistantAttachmentAuthToken: "test-auth-token", connectionEpoch: 1 },
  );
  if (origin === "queued") {
    props.queue = [
      { ...input, id: input.runId, sendRunId: input.runId, sendState: "sending", sendAttempts: 1 },
    ];
  }
  const { container, renderPane, setConnected } = mountTranscriptPane(props);
  await vi.dynamicImportSettled();
  const images = () => [...container.querySelectorAll<HTMLImageElement>(".chat-message-image")];
  await waitForSolid(() => expect(images()).toHaveLength(inlineUrls.length), { interval: 0 });
  const displayed = images();
  const previewUrls = displayed.map((image) =>
    expectDefined(image.getAttribute("src"), "displayed preview URL"),
  );
  const previewBytes = await Promise.all(
    previewUrls.map(async (url) =>
      url.startsWith("data:")
        ? Buffer.from(url.split(",")[1]!, "base64")
        : Buffer.from(
            await expectDefined(previewBlobs.get(url), "owned preview Blob").arrayBuffer(),
          ),
    ),
  );
  expect(previewBytes).toEqual(inlineUrls.map((url) => Buffer.from(url.split(",")[1]!, "base64")));
  if (origin === "initial receipt") {
    expect(previewUrls).toEqual(inlineUrls);
  } else {
    expect(new Set(previewUrls).size).toBe(previewUrls.length);
  }
  for (const image of displayed) {
    // jsdom has no decoder; deliver the browser's successful load boundary.
    Object.defineProperty(image, "naturalWidth", { value: 1 });
    imageEvent(image);
  }
  const publish = (
    metadata: Record<string, unknown> = {},
    nextMedia = media,
    text = "Fresh authoritative text",
    content: unknown[] = [],
  ) => {
    const messages = [
      {
        ...cached,
        content: [{ type: "text", text }, ...content],
        __openclaw: { ...canonical, media: nextMedia, ...metadata },
      },
    ];
    if (origin === "canonical") {
      props.messages = messages;
    } else {
      reduceChatSessionProjection(
        owner,
        { type: "snapshotLoaded", messages },
        { runActive: false },
      );
      props.messages = owner.chatMessages;
    }
    renderPane();
  };
  return {
    container,
    props,
    displayed,
    previewUrls,
    media,
    requests,
    images,
    publish,
    renderPane,
    setConnected,
    expectImages: (expected = displayed) => expectImageNodes(images(), expected),
    receive: async (response = metadataResponse(), index = 0) => {
      const request = await waitForSolid(() => expectDefined(requests[index], "pending metadata"), {
        interval: 0,
      });
      request.resolve(response);
      await settleMedia();
    },
    expectEmpty: (reason?: string) => {
      expect(images()).toHaveLength(0);
      if (reason) {
        expect(container.textContent).toContain(reason);
      }
    },
  };
}

beforeEach(() => {
  installTranscriptDomMocks();
  // jsdom has no native Blob URL store; retain its actual Blob for byte checks.
  vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
    if (!(blob instanceof Blob)) {
      throw new Error("Attachment preview must allocate a Blob URL");
    }
    const url = `blob:${crypto.randomUUID()}`;
    previewBlobs.set(url, blob);
    return url;
  });
  vi.spyOn(URL, "revokeObjectURL").mockImplementation((url) => {
    expect(previewBlobs.delete(url)).toBe(true);
  });
});
afterEach(() => {
  try {
    releaseChatAttachmentPayloads(ownedAttachments);
    expect(previewBlobs.size).toBe(0);
  } finally {
    ownedAttachments.length = 0;
    previewBlobs.clear();
    resetTranscriptTestDom();
  }
});

it.each(["inline", "metadata", "loaded"] as const)(
  "keeps the displayed %s upload when the session workspace arrives",
  async (stage) => {
    const view = await imageFixture(undefined, undefined, "initial receipt");
    if (stage !== "inline") {
      view.publish();
    }
    if (stage === "loaded") {
      await view.receive(metadataResponse(true, "before-workspace"));
      imageEvent(view.displayed[0]!);
    }

    view.props.selectedSession = {
      key: view.props.sessionKey,
      kind: "direct",
      permissionMode: "workspace",
      sessionRoot: "/worktrees/image-upload",
      spawnedCwd: "/worktrees/image-upload",
    };
    view.renderPane();
    view.expectImages();
    expect(view.container.querySelector('[aria-busy="true"]')).toBeNull();

    if (stage === "inline") {
      view.publish();
      view.expectImages();
    } else {
      expect(view.requests).toHaveLength(2);
    }
    // The retained pixels do not suppress the new policy's access check.
    await view.receive(metadataResponse(false), view.requests.length - 1);
    view.expectEmpty("Attachment removed");
  },
);

it.each([
  [
    "different canonical ID with identical text and send key",
    { id: "different-native-id" },
    undefined,
  ],
  ["different canonical sequence", { seq: 2 }, undefined],
  ["missing persisted ID", { id: undefined }, undefined],
  ["imported identity", { importedFrom: "external" }, undefined],
  [
    "import replacing queued send",
    {
      importedFrom: "external",
      cliSessionId: "imported-session",
      externalId: "imported-image",
    },
    "queued",
  ],
  ["pending identity", { id: "pending:input" }, undefined],
  ["missing layout", { mediaImageLayout: undefined }, undefined],
] as const)("does not borrow an inline preview for %s", async (_name, metadata, origin) => {
  const view = await imageFixture(undefined, undefined, origin);
  view.publish(metadata, view.media, "Cached text");
  expect(view.images()).toHaveLength(0);
  expect(view.container.querySelector('[aria-busy="true"]')).not.toBeNull();
});

it("does not lend a displayed inline image to another pane of the same canonical message", async () => {
  const view = await publishedImage();
  const { container } = mountTranscriptPane({ ...view.props, paneId: "other-image-pane" });
  view.expectImages();
  expect(container.querySelector(".chat-message-image")).toBeNull();
  expect(view.requests).toHaveLength(1);
});

it("binds local previews by fact position when inline blocks reorder mixed image receipts", async () => {
  const view = await imageFixture(
    [0, 1],
    ["data:image/png;base64,aW1hZ2VB", "data:image/png;base64,aW1hZ2VC"],
    "queued",
  );
  view.publish(
    {
      mediaImageLayout: {
        slots: [
          { kind: "offloaded", factIndex: 0 },
          { kind: "inline", factIndex: 1 },
        ],
      },
    },
    view.media,
    "Fresh authoritative text",
    [{ type: "image", url: expectDefined(view.media[1], "inline image fact").path }],
  );

  view.expectImages(view.displayed.toReversed());
  expect(view.images().map((image) => image.getAttribute("src"))).toEqual(
    view.previewUrls.toReversed(),
  );
});

it("adopts submitted images across interleaved non-image fact slots", async () => {
  const view = await imageFixture(
    [1, 3],
    ["data:image/png;base64,YQ==", "data:image/png;base64,Yg=="],
    "submitted",
  );
  view.publish();
  view.expectImages();
});

it("retains sparse reordered duplicate slots through reversed completion and removal", async () => {
  const factIndexes = [2, 0, 3];
  const inlineUrls = ["YQ==", "Yg==", "YQ=="].map((bytes) => `data:image/png;base64,${bytes}`);
  const view = await imageFixture(factIndexes, inlineUrls);
  view.media[3] = view.media[2] ?? null;
  view.publish();
  const sourceOrder = [1, 0, 2];
  const expected = sourceOrder.map((index) =>
    expectDefined(view.displayed[index], "displayed slot"),
  );
  view.expectImages(expected);
  expect(view.images().map((image) => image.getAttribute("src"))).toEqual(
    sourceOrder.map((index) => view.previewUrls[index]),
  );

  for (const request of view.requests.toReversed()) {
    request.resolve(metadataResponse());
    await settleMedia();
    view.expectImages(expected);
  }
  for (const image of expected.toReversed()) {
    imageEvent(image);
    view.expectImages(expected);
  }
  for (const [index, factIndex] of [0, 2, 3].entries()) {
    expect(view.images()[index]?.getAttribute("src")).toContain(
      encodeURIComponent(expectDefined(view.media[factIndex], "canonical media fact").path),
    );
  }
  view.publish(
    {},
    view.media.map((fact, index) => (index === 0 ? null : fact)),
  );
  view.expectImages(expected.slice(1));
});

it.each([
  ["auth", "renew"],
  ["connection epoch", "renew"],
  ["session", "renew"],
  ["removal", "native"],
  ["auth", "native"],
  ["replacement", "native"],
  ["connection epoch", "native"],
  ["removal", "clear"],
  ["replacement", "clear"],
  ["disconnect", "clear"],
  ["denial", "clear"],
] as const)("retires %s image handoffs against late %s resources", async (change, stage) => {
  const view = await publishedImage(stage === "native" ? metadataResponse() : undefined);
  view.expectImages();
  const old = expectDefined(view.requests[0], "pending metadata");
  if (change === "disconnect") {
    view.setConnected(false);
    view.container.remove();
    await settleMedia();
    document.body.append(view.container);
    view.setConnected(true);
  } else if (change !== "denial") {
    changeImage(view, change);
  }
  if (change !== "denial") {
    view.expectEmpty();
    if (stage !== "native") {
      expect(old.signal?.aborted).toBe(true);
    }
  }
  if (stage === "native") {
    imageEvent(view.displayed[0]!);
    imageEvent(view.displayed[0]!, "error");
    await settleMedia();
    view.expectEmpty();
  } else {
    old.resolve(metadataResponse(change !== "denial"));
    await settleMedia();
    view.expectEmpty(change === "denial" ? "Attachment removed" : undefined);
    if (stage === "renew") {
      await view.receive(metadataResponse(), view.requests.length - 1);
      expect(view.images()).toHaveLength(1);
      expect(view.images()[0]).not.toBe(view.displayed[0]);
    }
  }
});

it.each([
  ["renewal", () => metadataResponse(true, "after-refresh"), undefined],
  ["denial", () => metadataResponse(false), "Attachment removed"],
  ["retryable denial", () => metadataResponse(false, undefined, true), "Attachment removed"],
  ["HTTP 401 with an unreadable body", () => unreadableMetadataResponse(401), "Unavailable"],
] as const)(
  "updates native image presentation after metadata ticket %s",
  (_name, response, reason) =>
    withMediaTimers(async () => {
      const view = await publishedImage(metadataResponse(true, "before-refresh"));
      const displayed = expectDefined(view.displayed[0], "displayed image");
      imageEvent(displayed);
      await vi.advanceTimersByTimeAsync(1_000);
      await view.receive(response(), 1);
      if (reason) {
        imageEvent(displayed);
        view.expectEmpty(reason);
        await vi.advanceTimersByTimeAsync(5_000);
        view.expectEmpty();
      } else {
        view.expectImages();
        expect(displayed.getAttribute("src")).toContain("mediaTicket=after-refresh");
        imageEvent(displayed);
      }
    }),
);

it.each([
  { presentation: "inline-handoff", failure: "network rejection", responseStatus: null },
  { presentation: "canonical", failure: "HTTP 503 non-JSON", responseStatus: 503 },
])(
  "keeps a loaded $presentation image through $failure renewal and expiry",
  ({ presentation, responseStatus }) =>
    withMediaTimers(async () => {
      const view = await imageFixture(undefined, presentation === "canonical" ? [] : undefined);
      view.publish();
      await vi.advanceTimersByTimeAsync(0);
      await view.receive(metadataResponse(true, "before-offline"));
      const displayed = expectDefined(view.images()[0], "loaded canonical image");
      expect(displayed.getAttribute("src")).toContain("mediaTicket=before-offline");
      Object.defineProperty(displayed, "naturalWidth", { value: 1 });
      imageEvent(displayed);
      vi.mocked(fetch).mockImplementation(async () => {
        if (responseStatus === null) {
          throw new TypeError("Gateway offline");
        }
        return new Response("Service temporarily unavailable", { status: responseStatus });
      });

      // Exhaust renewals, then cross the 31-second view ticket's expiry.
      for (const elapsed of [11_000, 20_001]) {
        await vi.advanceTimersByTimeAsync(elapsed);
        view.expectImages([displayed]);
        expect(view.container.querySelector(".chat-assistant-attachment-card")).toBeNull();
      }
    }),
);

it.each(["native load error", "display load deadline"] as const)(
  "ends the retained handoff on %s and recovers only after explicit retry",
  (failure) =>
    withMediaTimers(async () => {
      const view = await publishedImage(metadataResponse());
      const displayed = expectDefined(view.displayed[0], "pending native image");
      if (failure === "native load error") {
        imageEvent(displayed, "error");
        await vi.advanceTimersByTimeAsync(0);
      } else {
        await vi.advanceTimersByTimeAsync(29_999);
        view.expectImages();
        await vi.advanceTimersByTimeAsync(1);
      }
      view.expectEmpty();
      const card = expectDefined(
        view.container.querySelector(".chat-assistant-attachment-card--recoverable"),
        "recoverable image failure",
      );
      expect(card.textContent).toContain("Could not load this image. Try again.");
      const retry = expectDefined(
        card.querySelector<HTMLButtonElement>(".chat-assistant-attachment-card__retry"),
        "explicit Retry button",
      );
      imageEvent(displayed);
      view.renderPane();
      notifyBrowserAuthRestored();
      await vi.advanceTimersByTimeAsync(15_000);
      view.expectEmpty();
      expect(view.requests).toHaveLength(1);

      retry.click();
      await vi.advanceTimersByTimeAsync(0);
      expect(view.requests).toHaveLength(2);
      view.expectEmpty();
      await view.receive(metadataResponse(true, "after-explicit-retry"), 1);
      const recovered = expectDefined(view.images()[0], "retried native image");
      expect(recovered).not.toBe(displayed);
      expect(recovered.getAttribute("src")).toContain("mediaTicket=after-explicit-retry");
      imageEvent(recovered);
      view.expectImages([recovered]);
    }),
);

it("keeps a successfully loaded native image after the handoff deadline", () =>
  withMediaTimers(async () => {
    const view = await publishedImage(metadataResponse());
    const displayed = expectDefined(view.displayed[0], "pending native image");
    imageEvent(displayed);
    await vi.advanceTimersByTimeAsync(30_000);
    view.expectImages([displayed]);
    expect(view.container.querySelector('[aria-busy="true"]')).toBeNull();
  }));
