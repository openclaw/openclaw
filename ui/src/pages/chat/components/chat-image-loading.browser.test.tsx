import { Show } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import { mediaTicketPayload } from "../../../test-helpers/control-ui-attachment-fixtures.ts";
import { cleanupSolid } from "../../../test-helpers/mount-solid.ts";
import { mountSolid } from "../../../test-helpers/solid-render.tsx";
import { waitForFast } from "../../../test-helpers/wait-for.ts";
import { CompactAttachmentCard } from "./chat-attachment-card-solid.tsx";
import { MessageImages, type MessageImagesProps } from "./chat-message-images-solid.tsx";
import {
  projectMessageMedia,
  releaseChatMediaResourceOwner,
  type ImageRenderOptions,
} from "./chat-message-media.ts";
import "../../../test-helpers/load-styles.ts";
import "../../activity/session-activity-media.css";

const browserMode = "__vitest_browser__" in globalThis;
const containers: HTMLElement[] = [];
const subscribers: (() => void)[] = [];
type ImageFixtureProps = MessageImagesProps & {
  role?: string;
  maxWidth?: number;
  withDocument?: boolean;
  nextMessage?: boolean;
};
const views = new Map<HTMLElement, ReturnType<typeof mountSolid<ImageFixtureProps>>>();
const outgoingImage = (alt?: string, width?: number, height?: number) => ({
  url: `/api/chat/media/outgoing/agent%3Amain%3Amain/${crypto.randomUUID()}/full`,
  alt,
  width,
  height,
});
const rectangle = (element: Element) => {
  const { x, y, width, height } = element.getBoundingClientRect();
  return { x, y, width, height };
};
const decodeImages = (container: Element) =>
  Promise.all([...container.querySelectorAll("img")].map((image) => image.decode()));
const attachmentCard = (container: Element) =>
  container.querySelector<HTMLElement>(".chat-assistant-attachment-card");

function pendingResponse() {
  const response = createDeferred<Response>();
  const fetchMock = vi.fn(() => response.promise);
  vi.stubGlobal("fetch", fetchMock);
  return { response, fetchMock };
}

function drawOwned(container: HTMLElement, props: ImageFixtureProps) {
  const draw = () =>
    drawImages(container, {
      ...props,
      options: { ...props.options, mediaOwner: draw },
    });
  subscribers.push(draw);
  draw();
  return draw;
}

function expectSkeleton(container: HTMLElement) {
  expect(frame(container).textContent?.trim()).toBe("");
  expect(container.querySelector(".chat-image-skeleton")).not.toBeNull();
  expect(attachmentCard(container)).toBeNull();
}

function ImageContent(props: ImageFixtureProps) {
  return (
    <>
      <MessageImages images={props.images} options={props.options} />
      <Show when={props.withDocument}>
        <CompactAttachmentCard kind="document" label="notes.pdf" />
      </Show>
      <Show when={props.nextMessage}>
        <p data-next-message>Next message</p>
      </Show>
    </>
  );
}

function ImageFixture(props: ImageFixtureProps) {
  return (
    <Show when={props.role} fallback={<ImageContent {...props} />}>
      {(role) => (
        <div
          class={["chat-group", role()]}
          style={props.maxWidth ? { "--chat-message-max-width": `${props.maxWidth}px` } : undefined}
        >
          <div class="chat-group-messages">
            <ImageContent {...props} />
          </div>
        </div>
      )}
    </Show>
  );
}

function drawImages(container: HTMLElement, props: ImageFixtureProps) {
  const view = views.get(container);
  if (view) {
    view.update(props);
  } else {
    views.set(container, mountSolid(ImageFixture, props, container));
  }
}

function unmountImages(container: HTMLElement) {
  views.get(container)?.dispose();
  views.delete(container);
}

afterEach(() => {
  for (const subscriber of subscribers.splice(0)) {
    releaseChatMediaResourceOwner(subscriber);
  }
  cleanupSolid();
  views.clear();
  for (const container of containers.splice(0)) {
    container.remove();
  }
  vi.unstubAllGlobals();
});

function mount(width: number) {
  const container = document.createElement("div");
  container.style.width = `${width}px`;
  document.body.append(container);
  containers.push(container);
  return container;
}

function frame(container: HTMLElement) {
  const element = container.querySelector<HTMLElement>(".chat-image-frame");
  expect(element).not.toBeNull();
  return element!;
}

async function admittedImage(container: HTMLElement): Promise<HTMLImageElement> {
  const image = container.querySelector("img");
  if (image) {
    return image;
  }
  return new Promise((resolve) => {
    const observer = new MutationObserver(() => {
      const admitted = container.querySelector("img");
      if (admitted) {
        observer.disconnect();
        resolve(admitted);
      }
    });
    observer.observe(container, { childList: true, subtree: true });
  });
}

function geometry(container: HTMLElement) {
  const outer = frame(container);
  const imageRect = (outer.querySelector(".chat-image-surface") ?? outer).getBoundingClientRect();
  const nextRect = container.querySelector("[data-next-message]")!.getBoundingClientRect();
  return { width: imageRect.width, height: imageRect.height, nextTop: nextRect.top };
}

function expectContentSizedError(card: HTMLElement) {
  const header = card.querySelector<HTMLElement>(".chat-assistant-attachment-card__header")!;
  const style = getComputedStyle(header);
  const children = [...header.children].map((child) => child.getBoundingClientRect().height);
  const contentHeight =
    style.flexDirection === "column"
      ? children.reduce((sum, height) => sum + height, 0) + Number.parseFloat(style.rowGap)
      : Math.max(...children);
  const headerHeight =
    contentHeight + Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom);
  const cardStyle = getComputedStyle(card);
  const border =
    Number.parseFloat(cardStyle.borderTopWidth) + Number.parseFloat(cardStyle.borderBottomWidth);
  expect(header.getBoundingClientRect().height).toBeCloseTo(headerHeight, 0);
  expect(card.getBoundingClientRect().height).toBeCloseTo(headerHeight + border, 0);
  const reason = card.querySelector<HTMLElement>(".chat-assistant-attachment-card__status-reason")!;
  expect(reason.textContent?.trim()).not.toBe("");
  expect(reason.scrollWidth).toBeLessThanOrEqual(reason.clientWidth + 1);
  expect(reason.scrollHeight).toBeLessThanOrEqual(reason.clientHeight + 1);
  expect(getComputedStyle(reason).whiteSpace).toBe("normal");
  expect(getComputedStyle(reason).textOverflow).not.toBe("ellipsis");
  const action = card.querySelector("button")!;
  expect(action.getBoundingClientRect().height).toBeGreaterThanOrEqual(24);
  expect(action.getBoundingClientRect().width).toBeGreaterThanOrEqual(44);
}

function svgResponse(width: number, height: number) {
  return new Response(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#cc6633"/></svg>`,
    { headers: { "Content-Type": "image/svg+xml" } },
  );
}

describe.runIf(browserMode)("chat image loading geometry", () => {
  let originalViewport: { width: number; height: number };
  let originalTheme: string | undefined;
  beforeEach(() => {
    originalViewport = { width: window.innerWidth, height: window.innerHeight };
    originalTheme = document.documentElement.dataset.themeMode;
  });
  afterEach(async () => {
    const { page } = await import("vitest/browser");
    await page.viewport(originalViewport.width, originalViewport.height);
    if (originalTheme === undefined) {
      delete document.documentElement.dataset.themeMode;
    } else {
      document.documentElement.dataset.themeMode = originalTheme;
    }
  });

  it.each([false, true])(
    "adopts decoded paste dimensions before and after an upload receipt (%s)",
    async (receipt) => {
      const container = mount(500);
      const url = URL.createObjectURL(await svgResponse(1200, 563).blob());
      try {
        const draw = (sized = false) =>
          drawImages(container, {
            images: [
              { url, alt: "Pasted screenshot", ...(sized ? { width: 1200, height: 563 } : {}) },
            ],
            role: "user",
            nextMessage: true,
          });
        draw();
        const originalFrame = frame(container);
        const image = await admittedImage(container);
        await image.decode();
        if (receipt) {
          draw(true);
        }
        await vi.waitFor(() => {
          const box = geometry(container);
          expect(box.width / box.height).toBeCloseTo(1200 / 563, 2);
        });
        expect(frame(container)).toBe(originalFrame);
        const decoded = geometry(container);
        unmountImages(container);
        draw(receipt);
        await (await admittedImage(container)).decode();
        await vi.waitFor(() => expect(geometry(container)).toEqual(decoded));
      } finally {
        URL.revokeObjectURL(url);
      }
    },
  );

  it("replaces a legacy immutable thumbnail rendition before loading its preview", async () => {
    const container = mount(500);
    const source = `/api/chat/media/outgoing/agent%3Amain%3Amain/${crypto.randomUUID()}/thumbnail?v=2`;
    const fetchMock = vi.fn(async (url: string) => {
      // Model the old immutable response separately from the new bounded rendition.
      return new URL(url, location.href).searchParams.get("v") === "2"
        ? svgResponse(2400, 1200)
        : svgResponse(400, 200);
    });
    vi.stubGlobal("fetch", fetchMock);
    drawImages(container, { images: [{ url: source, alt: "Versioned preview" }] });
    const image = await admittedImage(container);
    await image.decode();
    expect(image.naturalWidth).toBe(400);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(new URL(fetchMock.mock.calls[0]![0], location.href).searchParams.get("v")).toBe("4");
  });

  it("keeps a horizontally clipped image keyboard reachable before admission", async () => {
    const { userEvent } = await import("vitest/browser");
    const container = mount(132);
    container.className = "activity-feed__media";
    container.style.padding = "0";
    const fetch = vi.fn(async () => svgResponse(128, 80));
    vi.stubGlobal("fetch", fetch);
    const images = ["First", "Clipped"].map((alt) => outgoingImage(alt));
    const onOpenImage = vi.fn<NonNullable<ImageRenderOptions["onOpenImage"]>>();
    drawOwned(container, { images, options: { onOpenImage } });
    await vi.waitFor(() => expect(container.querySelectorAll("img")).toHaveLength(1));
    expect(fetch).toHaveBeenCalledOnce();
    const frames = container.querySelectorAll<HTMLElement>(".chat-image-frame");
    const strip = container.querySelector<HTMLElement>(".chat-message-images")!;
    expect(frames[1]!.getBoundingClientRect().left).toBeGreaterThan(
      strip.getBoundingClientRect().right,
    );
    const clippedButton = frames[1]!.querySelector("button");
    expect(clippedButton?.getAttribute("aria-disabled")).toBe("true");
    container.querySelector<HTMLButtonElement>(".chat-message-image-button")!.focus();
    await userEvent.tab();
    expect(frames[1]!.contains(document.activeElement)).toBe(true);
    await vi.waitFor(() => expect(frames[1]!.querySelector("img")).not.toBeNull());
    await frames[1]!.querySelector("img")!.decode();
    expect(frames[1]!.querySelector("button")).toBe(clippedButton);
    expect(clippedButton).toBe(document.activeElement);
    expect(clippedButton?.hasAttribute("aria-disabled")).toBe(false);
    await userEvent.keyboard("{Enter}");
    try {
      expect(onOpenImage).toHaveBeenCalledOnce();
      expect(onOpenImage.mock.calls[0]?.[0].gallery?.index).toBe(1);
    } finally {
      onOpenImage.mock.calls[0]?.[0].release?.();
    }
  });

  it.each([
    ["landscape", 1200, 800, 500, 400, 400 / 1.5, "assistant", true],
    ["portrait", 800, 1600, 500, 180, 360, "user", true],
    ["tiny image", 1, 1, 500, 160, 160, "assistant", true],
    ["narrow pane", 1200, 800, 180, 180, 120, "user", true],
    ["panorama", 1200, 80, 500, 400, 400 / 15, "assistant", true],
    ["tiny tall image", 80, 1600, 500, 18, 360, "user", true],
    ["unknown dimensions", 800, 1600, 500, 400, 400 / 1.5, "assistant", false],
  ] as const)(
    "keeps %s geometry through fetch, decode, and cache reuse",
    async (name, width, height, pane, expectedWidth, expectedHeight, role, sized) => {
      const { page } = await import("vitest/browser");
      await page.viewport(1440, 900);
      // Constrain the message column, not the surrounding avatar row or mobile breakpoint.
      const container = mount(1000);
      const { response, fetchMock } = pendingResponse();
      const images = [outgoingImage(name, sized ? width : undefined, sized ? height : undefined)];
      const draw = () => drawImages(container, { images, role, maxWidth: pane, nextMessage: true });
      draw();
      const originalFrame = frame(container);
      const before = geometry(container);
      expect(before.width).toBeCloseTo(sized ? expectedWidth : 400, 1);
      expect(before.height).toBeCloseTo(sized ? expectedHeight : 400 / 1.5, 1);
      expectSkeleton(container);
      expect(
        getComputedStyle(originalFrame.querySelector(".chat-image-surface")!).backgroundColor,
      ).not.toBe("rgba(0, 0, 0, 0)");
      expect(originalFrame.getAttribute("aria-busy")).toBe("true");
      expect(originalFrame.querySelector("svg")).toBeNull();
      response.resolve(svgResponse(width, height));
      await waitForFast(() => expect(container.querySelector("img")).not.toBeNull());
      const image = container.querySelector("img")!;
      expect(geometry(container)).toEqual(before);
      await image.decode();
      await vi.waitFor(() => {
        expect(geometry(container).width).toBeCloseTo(expectedWidth, 1);
        expect(geometry(container).height).toBeCloseTo(expectedHeight, 1);
      });
      const decoded = geometry(container);
      expect(decoded).toEqual(before);
      expect(frame(container)).toBe(originalFrame);
      draw();
      expect(container.querySelector("img")).toBe(image);
      expect(geometry(container)).toEqual(decoded);
      unmountImages(container);
      draw();
      const remounted = await admittedImage(container);
      expect(remounted.getAttribute("src")).toBe(image.getAttribute("src"));
      await remounted.decode();
      await vi.waitFor(() => expect(geometry(container)).toEqual(decoded));
      expect(fetchMock).toHaveBeenCalledOnce();
    },
  );

  it("keeps a local attachment as a plain skeleton while metadata is pending", async () => {
    const container = mount(500);
    const { response } = pendingResponse();
    const source = `/tmp/openclaw/${crypto.randomUUID()}.png`;
    const images = projectMessageMedia({}, [
      {
        type: "attachment",
        attachment: { kind: "image", url: source, label: "Local image", width: 1200, height: 800 },
      },
    ]).images;
    const draw = drawOwned(container, {
      images,
      options: { sessionKey: "image-proof", agentId: "main" },
      nextMessage: true,
    });
    const before = geometry(container);
    expect(before.height).toBeCloseTo(400 / 1.5, 1);
    expectSkeleton(container);
    response.resolve(Response.json(mediaTicketPayload("test-ticket", 300_000)));
    await waitForFast(() => expect(container.querySelector("img")).not.toBeNull());
    const loadable = geometry(container);
    expect(loadable.height).toBeCloseTo(400 / 1.5, 1);
    const sourceUrl = container.querySelector("img")!.getAttribute("src");
    expect(container.querySelector("img")!.getAttribute("width")).toBe("1200");
    unmountImages(container);
    draw();
    expect((await admittedImage(container)).getAttribute("src")).toBe(sourceUrl);
    expect(geometry(container)).toEqual(loadable);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([
    { count: 2, viewport: 375, tile: 109 },
    { count: 5, viewport: 1000, tile: 128 },
  ])(
    "keeps every tile of a $count-image user gallery in place at $viewport px",
    async ({ count, viewport, tile }) => {
      const { page } = await import("vitest/browser");
      await page.viewport(viewport, 812);
      const container = mount(Math.min(700, viewport - 32));
      const ready = createDeferred();
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          await ready.promise;
          return svgResponse(1200, 800);
        }),
      );
      const images = Array.from({ length: count }, (_, index) =>
        outgoingImage(`Image ${index}`, 1200, 800),
      );
      drawImages(container, { images, role: "user", nextMessage: true });
      const rectangles = () => [...container.querySelectorAll(".chat-image-frame")].map(rectangle);
      const before = rectangles();
      expect(before).toHaveLength(count);
      for (const rect of before) {
        expect(rect.width).toBe(tile);
        expect(rect.height).toBe(tile);
      }
      const nextTop = container.querySelector("[data-next-message]")!.getBoundingClientRect().top;
      ready.resolve();
      await waitForFast(() => expect(container.querySelectorAll("img")).toHaveLength(count));
      await decodeImages(container);
      expect(rectangles()).toEqual(before);
      for (const surface of container.querySelectorAll(".chat-image-surface")) {
        const rect = surface.getBoundingClientRect();
        expect(rect.width).toBe(rect.height);
        for (const content of surface.querySelectorAll("button, img")) {
          expect(content.getBoundingClientRect().width).toBe(rect.width);
          expect(content.getBoundingClientRect().height).toBe(rect.height);
        }
      }
      expect(container.querySelector("[data-next-message]")!.getBoundingClientRect().top).toBe(
        nextTop,
      );
    },
  );

  it("reserves the menu footprint before the next short panorama preview", async () => {
    const { page } = await import("vitest/browser");
    await page.viewport(800, 600);
    const container = mount(500);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => svgResponse(1200, 30)),
    );
    drawImages(container, {
      images: ["First panorama", "Second panorama"].map((alt) => ({
        url: `/api/chat/media/outgoing/agent%3Amain%3Amain/${crypto.randomUUID()}/full`,
        alt,
        width: 1200,
        height: 30,
      })),
      role: "assistant",
    });
    await waitForFast(() => expect(container.querySelectorAll("img")).toHaveLength(2));
    await Promise.all([...container.querySelectorAll("img")].map((image) => image.decode()));
    const frames = [...container.querySelectorAll<HTMLElement>(".chat-image-frame")];
    const first = frames[0]!;
    const menu = first.querySelector<HTMLElement>(".chat-image-actions")!;
    const surface = first.querySelector<HTMLElement>(".chat-image-surface")!;
    const box = surface.getBoundingClientRect();
    expect(box.width / box.height).toBeCloseTo(40, 0);
    expect(menu.getBoundingClientRect().height).toBe(44);
    expect(frames[1]!.getBoundingClientRect().top).toBeGreaterThanOrEqual(
      menu.getBoundingClientRect().bottom,
    );
  });

  it.each(
    [1440, 390].flatMap((viewport) => ["ltr", "rtl"].map((direction) => ({ viewport, direction }))),
  )(
    "anchors image actions around tiny and tall previews at $viewport px in $direction",
    async ({ viewport, direction }) => {
      const { page } = await import("vitest/browser");
      // The browser fixture does not scroll; keep all five previews reachable.
      await page.viewport(viewport, 1800);
      const container = mount(Math.min(500, viewport - 32));
      container.dir = direction;
      const variants = [
        ["Tiny generated image", 16, 16, true],
        ["Tall generated image", 420, 1800, true],
        ["Narrow generated image", 80, 1600, true],
        ["Narrow image without dimensions", 80, 1600, false],
        ["Tiny image without dimensions", 1, 1, false],
      ] as const;
      const fetchMock = vi.fn();
      const images = variants.map(([alt, width, height, sized]) => {
        fetchMock.mockResolvedValueOnce(svgResponse(width, height));
        return Object.assign(
          outgoingImage(alt, sized ? width : undefined, sized ? height : undefined),
          { alt },
        );
      });
      vi.stubGlobal("fetch", fetchMock);
      drawImages(container, { images, role: "assistant" });
      await waitForFast(() =>
        expect(container.querySelectorAll("img")).toHaveLength(images.length),
      );
      await decodeImages(container);
      const frames = [...container.querySelectorAll<HTMLElement>(".chat-image-frame--managed")];
      expect(frames[1]!.getBoundingClientRect().top).toBeGreaterThan(
        frames[0]!.getBoundingClientRect().bottom,
      );
      const fallbackWidth = Math.min(
        400,
        container.querySelector(".chat-group-messages")!.clientWidth,
      );
      for (const [index, expectedWidth] of [160, 84, 18, fallbackWidth, fallbackWidth].entries()) {
        const element = frames[index]!;
        await page.getByAltText(images[index]!.alt, { exact: true }).hover();
        for (const animation of element.getAnimations({ subtree: true })) {
          animation.finish();
        }
        const frameRect = element.getBoundingClientRect();
        const actionsRect = element.querySelector(".chat-image-actions")!.getBoundingClientRect();
        const surface = element.querySelector(".chat-image-surface")!;
        const surfaceRect = surface.getBoundingClientRect();
        expect(getComputedStyle(element, "::after").content).toBe("none");
        const overlay = expectedWidth >= 80;
        if (overlay) {
          expect(actionsRect.left).toBeGreaterThanOrEqual(surfaceRect.left);
          expect(actionsRect.right).toBeLessThanOrEqual(frameRect.right);
          expect(actionsRect.top).toBeGreaterThanOrEqual(surfaceRect.top);
          expect(actionsRect.bottom).toBeLessThanOrEqual(surfaceRect.bottom);
        } else {
          expect(actionsRect.left).toBeGreaterThanOrEqual(0);
          expect(actionsRect.right).toBeLessThanOrEqual(viewport);
          expect(element.querySelector('[aria-label="Image actions"]')).not.toBeNull();
        }
        const action = element.querySelector<HTMLButtonElement>(".chat-image-action")!;
        const rect = action.getBoundingClientRect();
        expect(rect.width).toBe(overlay ? 30 : 44);
        expect(rect.height).toBe(overlay ? 30 : 44);
        expect(
          action.contains(
            document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2),
          ),
        ).toBe(true);
        expect(surfaceRect.width).toBeCloseTo(expectedWidth, 0);
        expect(getComputedStyle(surface).overflow).toBe("hidden");
      }
    },
  );

  it.each([
    [1440, "light", "assistant", undefined, undefined, 1, false, 0],
    [390, "dark", "assistant", undefined, undefined, 2, true, 1],
    [1440, "dark", "assistant", undefined, undefined, 3, false, 1],
    [390, "light", "assistant", 1200, 80, 2, true, 0],
    [390, "dark", "assistant", 420, 1800, 2, true, 0],
    [1440, "dark", "assistant", 80, 1600, 2, true, 0],
    [390, "light", "user", 1200, 800, 2, true, 0],
    [1440, "dark", "user", 1200, 800, 2, true, 3],
  ] as const)(
    "keeps unavailable attachments compact at %s px in %s: %s %s×%s, %s blocked, document=%s, %s available",
    async (viewport, theme, role, imageWidth, imageHeight, count, withDocument, available) => {
      const { page } = await import("vitest/browser");
      await page.viewport(viewport, 1600);
      document.documentElement.dataset.themeMode = theme;
      const container = mount(Math.min(700, viewport - 32));
      if (role === "user") {
        container.classList.add("chat-thread");
        container.style.height = "800px";
      }
      const allowed = createDeferred<Response>();
      const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "POST") {
          return allowed.promise;
        }
        return Promise.resolve(
          Response.json({
            available: false,
            code: "outside-allowed-folders",
            canAllow: true,
            retryable: false,
          }),
        );
      });
      vi.stubGlobal("fetch", fetchMock);
      const images = Array.from({ length: count + available }, (_, index) => ({
        url:
          index < count
            ? `/outside/${crypto.randomUUID()}.png`
            : "data:image/svg+xml," +
              encodeURIComponent(
                '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800"/>',
              ),
        fileName: `image-${index}.png`,
        width: imageWidth,
        height: imageHeight,
      }));
      drawOwned(container, {
        images,
        options: { sessionKey: "unavailable-geometry", agentId: "main" },
        role,
        withDocument,
        nextMessage: true,
      });
      await waitForFast(() =>
        expect(
          container.querySelectorAll(".chat-assistant-attachment-card--blocked button"),
        ).toHaveLength(count),
      );
      await decodeImages(container);
      const reference = withDocument ? container : mount(400);
      if (!withDocument) {
        mountSolid(CompactAttachmentCard, { kind: "document", label: "notes.pdf" }, reference);
      }
      const file = reference.querySelector<HTMLElement>(
        ".chat-assistant-attachment-card--compact",
      )!;
      const cards = [
        ...container.querySelectorAll<HTMLElement>(".chat-assistant-attachment-card--blocked"),
      ];
      const fileHeight = file.getBoundingClientRect().height;
      expect(fileHeight).toBe(74);
      const gallery = container.querySelector<HTMLElement>(".chat-message-images")!;
      const slots = () => [...gallery.children].map(rectangle);
      const before = slots();
      expect(before).toHaveLength(count + available);
      const galleryBounds = gallery.getBoundingClientRect();
      expect(galleryBounds.bottom).toBeCloseTo(
        Math.max(...before.map((slot) => slot.y + slot.height)),
        1,
      );
      if (withDocument) {
        const parentGap = Number.parseFloat(
          getComputedStyle(gallery.closest(".chat-group-messages")!).rowGap,
        );
        expect(
          file.getBoundingClientRect().top - gallery.getBoundingClientRect().bottom,
        ).toBeCloseTo(parentGap, 1);
      }
      const cornerInsets = (element: HTMLElement) => {
        const rect = element.getBoundingClientRect();
        const radius = Number.parseFloat(getComputedStyle(element).borderTopLeftRadius);
        return [
          [1, 1],
          [-1, 1],
          [1, -1],
          [-1, -1],
        ].map(([dx, dy]) => {
          for (let inset = 0; inset <= radius; inset += 0.5) {
            const x = dx === 1 ? rect.left + inset : rect.right - inset;
            const y = dy === 1 ? rect.top + inset : rect.bottom - inset;
            if (element.contains(document.elementFromPoint(x, y))) {
              return inset;
            }
          }
          return radius;
        });
      };
      for (const [index, card] of cards.entries()) {
        expect(card.getBoundingClientRect().width).toBe(before[index]!.width);
        expectContentSizedError(card);
        expect(before[index]!.height).toBeCloseTo(card.getBoundingClientRect().height, 1);
        expect(card.parentElement!.querySelector(".chat-image-actions")).toBeNull();
        const cardCorners = cornerInsets(card);
        const rect = card.getBoundingClientRect();
        // Hit-test both outlines at identical subpixel coordinates.
        const fileParent = file.parentNode!;
        const fileNext = file.nextSibling;
        document.body.append(file);
        file.style.cssText = `position: fixed; left: ${rect.left}px; top: ${rect.top}px; width: ${rect.width}px; height: ${rect.height}px; z-index: 1`;
        const fileCorners = cornerInsets(file);
        file.removeAttribute("style");
        fileParent.insertBefore(file, fileNext);
        expect.soft(cardCorners).toEqual(fileCorners);
        expect(getComputedStyle(card).borderTopWidth).toBe(getComputedStyle(file).borderTopWidth);
        const action = card.querySelector("button")!;
        expect(action.scrollWidth).toBeLessThanOrEqual(action.clientWidth);
        const button = action.getBoundingClientRect();
        expect(button.left).toBeGreaterThanOrEqual(rect.left);
        expect(button.right).toBeLessThanOrEqual(rect.right);
        expect(button.bottom).toBeLessThanOrEqual(rect.bottom);
      }
      await page.getByRole("button", { name: "Allow image", exact: true }).first().click();
      expect(fetchMock).toHaveBeenLastCalledWith(
        expect.stringContaining("&allow=1"),
        expect.objectContaining({ method: "POST" }),
      );
      expect(frame(container).getAttribute("aria-busy")).toBe("true");
      expect(frame(container).textContent?.trim()).toBe("");
      expect(frame(container).querySelector(".chat-image-skeleton")).not.toBeNull();
      expect(
        slots()
          .slice(1)
          .map(({ width, height }) => ({ width, height })),
      ).toEqual(before.slice(1).map(({ width, height }) => ({ width, height })));
      allowed.resolve(Response.json({ available: true }));
      await waitForFast(() => expect(frame(container).querySelector("img")).not.toBeNull());
      for (const [index, remaining] of [...gallery.children].slice(1, count).entries()) {
        expect(remaining.getBoundingClientRect().height).toBe(before[index + 1]!.height);
      }
    },
  );

  it.each([true, false])(
    "shows a compact retry card after a failed thumbnail fetch (dimensions: %s)",
    async (sized) => {
      const container = mount(500);
      const response = createDeferred<Response>();
      const fetchMock = vi
        .fn()
        .mockImplementationOnce(() => response.promise)
        .mockResolvedValueOnce(svgResponse(1200, 800));
      vi.stubGlobal("fetch", fetchMock);
      drawImages(container, {
        images: [outgoingImage(undefined, sized ? 1200 : undefined, sized ? 800 : undefined)],
        nextMessage: true,
      });
      const before = geometry(container);
      response.resolve(new Response(null, { status: 404 }));
      await waitForFast(() => expect(frame(container).getAttribute("aria-busy")).toBe("false"));
      const card = attachmentCard(container)!;
      expect(card.textContent).toContain("load");
      expect(
        frame(container).querySelector('.chat-image-actions [aria-label="Image actions"]'),
      ).not.toBeNull();
      expectContentSizedError(card);
      expect(geometry(container).height).toBeCloseTo(card.getBoundingClientRect().height, 1);
      expect(geometry(container).height).toBeLessThan(before.height);
      const { page } = await import("vitest/browser");
      await page.getByRole("button", { name: "Retry", exact: true }).click();
      await waitForFast(() => expect(container.querySelector("img")).not.toBeNull());
      await container.querySelector("img")!.decode();
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(geometry(container).height).toBeCloseTo(400 / 1.5, 1);
      if (sized) {
        expect(geometry(container)).toEqual(before);
      }
    },
  );
});
