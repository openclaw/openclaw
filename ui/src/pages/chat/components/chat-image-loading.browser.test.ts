import { html, nothing, render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import { waitForFast } from "../../../test-helpers/wait-for.ts";
import { renderCompactAttachmentCard } from "./chat-attachment-card.ts";
import { renderMessageImages } from "./chat-message-images.ts";
import {
  projectMessageMedia,
  releaseChatMediaResourceSubscriber,
  type ImageRenderOptions,
} from "./chat-message-media.ts";
import "../../../test-helpers/load-styles.ts";
import "../../activity/session-activity-media.css";

const browserMode = "__vitest_browser__" in globalThis;
const containers: HTMLElement[] = [];
const subscribers: (() => void)[] = [];

afterEach(() => {
  for (const subscriber of subscribers.splice(0)) {
    releaseChatMediaResourceSubscriber(subscriber);
  }
  for (const container of containers.splice(0)) {
    render(nothing, container);
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
  const imageRect = frame(container).getBoundingClientRect();
  const nextRect = container.querySelector("[data-next-message]")!.getBoundingClientRect();
  return { width: imageRect.width, height: imageRect.height, nextTop: nextRect.top };
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

  it("keeps a horizontally clipped image keyboard reachable before admission", async () => {
    const { userEvent } = await import("vitest/browser");
    const container = mount(132);
    container.className = "activity-feed__media";
    container.style.padding = "0";
    const fetch = vi.fn(async () => svgResponse(128, 80));
    vi.stubGlobal("fetch", fetch);
    const images = ["First", "Clipped"].map((alt) => ({
      url: `/api/chat/media/outgoing/agent%3Amain%3Amain/${crypto.randomUUID()}/full`,
      alt,
    }));
    const onOpenImage = vi.fn<NonNullable<ImageRenderOptions["onOpenImage"]>>();
    const draw = () =>
      render(renderMessageImages(images, { onRequestUpdate: draw, onOpenImage }), container);
    subscribers.push(draw);
    draw();
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

  it.each(
    [
      {
        name: "landscape",
        width: 1200,
        height: 800,
        pane: 500,
        expectedWidth: 400,
        expectedHeight: 400 / 1.5,
      },
      {
        name: "portrait",
        width: 800,
        height: 1600,
        pane: 500,
        expectedWidth: 180,
        expectedHeight: 360,
      },
      {
        name: "tiny image",
        width: 1,
        height: 1,
        pane: 500,
        expectedWidth: 160,
        expectedHeight: 160,
      },
      {
        name: "narrow pane",
        width: 1200,
        height: 800,
        pane: 180,
        expectedWidth: 180,
        expectedHeight: 120,
      },
      {
        name: "panorama",
        width: 1200,
        height: 80,
        pane: 500,
        expectedWidth: 400,
        expectedHeight: 400 / 15,
      },
      {
        name: "tiny tall image",
        width: 80,
        height: 1600,
        pane: 500,
        expectedWidth: 160,
        expectedHeight: 360,
      },
    ].flatMap((scenario) =>
      ["assistant", "user"].map((role) => ({ scenario, role, name: scenario.name })),
    ),
  )(
    "keeps the $role $name frame and next message stationary through fetch, decode, and cache reuse",
    async ({ scenario, role }) => {
      const { page } = await import("vitest/browser");
      await page.viewport(1440, 900);
      // Constrain the message column, not the surrounding avatar row or mobile breakpoint.
      const container = mount(1000);
      const response = createDeferred<Response>();
      const fetchMock = vi.fn(() => response.promise);
      vi.stubGlobal("fetch", fetchMock);
      const source = `/api/chat/media/outgoing/agent%3Amain%3Amain/${crypto.randomUUID()}/full`;
      const images = [
        {
          url: source,
          alt: scenario.name,
          width: scenario.width,
          height: scenario.height,
        },
      ];
      const draw = () =>
        render(
          html`<div
            class="chat-group ${role}"
            style=${`--chat-message-max-width: ${scenario.pane}px`}
          >
            <div class="chat-group-messages">
              ${renderMessageImages(images)}
              <p data-next-message>Next message</p>
            </div>
          </div>`,
          container,
        );
      draw();
      const originalFrame = frame(container);
      const before = geometry(container);
      expect(before.width).toBeCloseTo(scenario.expectedWidth, 1);
      expect(before.height).toBeCloseTo(scenario.expectedHeight, 1);
      expect(getComputedStyle(originalFrame).backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
      expect(originalFrame.getAttribute("aria-busy")).toBe("true");
      expect(originalFrame.textContent?.trim()).toBe("");
      expect(originalFrame.querySelector("svg")).toBeNull();
      expect(container.querySelector(".chat-assistant-attachment-card")).toBeNull();
      response.resolve(svgResponse(scenario.width ?? 800, scenario.height ?? 1600));
      await waitForFast(() => expect(container.querySelector("img")).not.toBeNull());
      const image = container.querySelector("img")!;
      expect(geometry(container)).toEqual(before);
      await image.decode();
      expect(geometry(container)).toEqual(before);
      expect(frame(container)).toBe(originalFrame);
      draw();
      expect(container.querySelector("img")).toBe(image);
      expect(geometry(container)).toEqual(before);
      render(nothing, container);
      draw();
      const remounted = await admittedImage(container);
      expect(remounted.getAttribute("src")).toBe(image.getAttribute("src"));
      await remounted.decode();
      expect(geometry(container)).toEqual(before);
      expect(fetchMock).toHaveBeenCalledOnce();
    },
  );

  it.each(["assistant", "user"])(
    "uses natural decoded geometry for a $role image without dimensions",
    async (role) => {
      const container = mount(500);
      const response = createDeferred<Response>();
      vi.stubGlobal(
        "fetch",
        vi.fn(() => response.promise),
      );
      const source = `/api/chat/media/outgoing/agent%3Amain%3Amain/${crypto.randomUUID()}/full`;
      render(
        html`<div class="chat-group ${role}">
          <div class="chat-group-messages">
            ${renderMessageImages([{ url: source, fileName: "portrait.svg" }])}
            <p data-next-message>Next message</p>
          </div>
        </div>`,
        container,
      );
      expect(geometry(container).height).toBeCloseTo(400 / 1.5, 1);
      expect(frame(container).textContent?.trim()).toBe("");
      expect(container.querySelector(".chat-image-skeleton")).not.toBeNull();
      response.resolve(svgResponse(800, 1600));
      await waitForFast(() => expect(container.querySelector("img")).not.toBeNull());
      await container.querySelector("img")!.decode();
      expect(geometry(container).width).toBe(180);
      expect(geometry(container).height).toBe(360);
    },
  );

  it.each(["attachment", "image block"])(
    "keeps a local %s as a plain skeleton while metadata is pending",
    async (kind) => {
      const container = mount(500);
      const response = createDeferred<Response>();
      vi.stubGlobal(
        "fetch",
        vi.fn(() => response.promise),
      );
      const source = `/tmp/openclaw/${crypto.randomUUID()}.png`;
      const draw = () =>
        render(
          html`${
              kind === "attachment"
                ? renderMessageImages(
                    projectMessageMedia({}, [
                      {
                        type: "attachment",
                        attachment: {
                          kind: "image",
                          url: source,
                          label: "Local image",
                          width: 1200,
                          height: 800,
                        },
                      },
                    ]).images,
                    { sessionKey: "image-proof", agentId: "main", onRequestUpdate: draw },
                  )
                : renderMessageImages(
                    [{ url: source, alt: "Local image", width: 1200, height: 800 }],
                    { sessionKey: "image-proof", agentId: "main", onRequestUpdate: draw },
                  )
            }

            <p data-next-message>Next message</p>`,
          container,
        );
      subscribers.push(draw);
      draw();
      const before = geometry(container);
      expect(before.height).toBeCloseTo(400 / 1.5, 1);
      expect(frame(container).textContent?.trim()).toBe("");
      expect(container.querySelector(".chat-image-skeleton")).not.toBeNull();
      expect(container.querySelector(".chat-assistant-attachment-card")).toBeNull();
      response.resolve(
        Response.json({
          available: true,
          mediaTicket: "test-ticket",
          mediaTicketExpiresAt: new Date(Date.now() + 300_000).toISOString(),
        }),
      );
      await waitForFast(() => expect(container.querySelector("img")).not.toBeNull());
      const loadable = geometry(container);
      expect(loadable.height).toBeCloseTo(400 / 1.5, 1);
      const sourceUrl = container.querySelector("img")!.getAttribute("src");
      expect(container.querySelector("img")!.getAttribute("width")).toBe("1200");
      render(nothing, container);
      draw();
      expect((await admittedImage(container)).getAttribute("src")).toBe(sourceUrl);
      expect(geometry(container)).toEqual(loadable);
      expect(fetch).toHaveBeenCalledOnce();
    },
  );

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
      const images = Array.from({ length: count }, (_, index) => ({
        url: `/api/chat/media/outgoing/agent%3Amain%3Amain/${crypto.randomUUID()}/full`,
        alt: `Image ${index}`,
        width: 1200,
        height: 800,
      }));
      render(
        html`<div class="chat-group user">
          <div class="chat-group-messages">
            ${renderMessageImages(images)}
            <p data-next-message>Next message</p>
          </div>
        </div>`,
        container,
      );
      const rectangles = () =>
        [...container.querySelectorAll(".chat-image-frame")].map((element) => {
          const { x, y, width, height } = element.getBoundingClientRect();
          return { x, y, width, height };
        });
      const before = rectangles();
      expect(before).toHaveLength(count);
      for (const rect of before) {
        expect(rect.width).toBe(tile);
        expect(rect.height).toBe(tile);
      }
      const nextTop = container.querySelector("[data-next-message]")!.getBoundingClientRect().top;
      ready.resolve();
      await waitForFast(() => expect(container.querySelectorAll("img")).toHaveLength(count));
      await Promise.all([...container.querySelectorAll("img")].map((image) => image.decode()));
      expect(rectangles()).toEqual(before);
      expect(container.querySelector("[data-next-message]")!.getBoundingClientRect().top).toBe(
        nextTop,
      );
    },
  );

  it.each([1440, 390])(
    "anchors image actions around tiny and tall previews at %s px",
    async (viewport) => {
      const { page } = await import("vitest/browser");
      // The browser fixture does not scroll; keep all five previews reachable.
      await page.viewport(viewport, 1800);
      const container = mount(Math.min(500, viewport - 32));
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValueOnce(svgResponse(16, 16))
          .mockResolvedValueOnce(svgResponse(420, 1800))
          .mockResolvedValueOnce(svgResponse(80, 1600))
          .mockResolvedValueOnce(svgResponse(80, 1600))
          .mockResolvedValueOnce(svgResponse(1, 1)),
      );
      const images = [
        {
          url: `/api/chat/media/outgoing/agent%3Amain%3Amain/${crypto.randomUUID()}/full`,
          width: 16,
          height: 16,
          alt: "Tiny generated image",
        },
        {
          url: `/api/chat/media/outgoing/agent%3Amain%3Amain/${crypto.randomUUID()}/full`,
          width: 420,
          height: 1800,
          alt: "Tall generated image",
        },
        {
          url: `/api/chat/media/outgoing/agent%3Amain%3Amain/${crypto.randomUUID()}/full`,
          width: 80,
          height: 1600,
          alt: "Narrow generated image",
        },
        {
          url: `/api/chat/media/outgoing/agent%3Amain%3Amain/${crypto.randomUUID()}/full`,
          alt: "Narrow image without dimensions",
        },
        {
          url: `/api/chat/media/outgoing/agent%3Amain%3Amain/${crypto.randomUUID()}/full`,
          alt: "Tiny image without dimensions",
        },
      ];
      render(
        html`<div class="chat-group assistant">
          <div class="chat-group-messages">${renderMessageImages(images)}</div>
        </div>`,
        container,
      );
      await waitForFast(() =>
        expect(container.querySelectorAll("img")).toHaveLength(images.length),
      );
      await Promise.all([...container.querySelectorAll("img")].map((image) => image.decode()));
      const frames = [...container.querySelectorAll<HTMLElement>(".chat-image-frame--managed")];
      expect(frames[1]!.getBoundingClientRect().top).toBeGreaterThan(
        frames[0]!.getBoundingClientRect().bottom,
      );
      for (const [index, expectedWidth] of [160, 84, 160, 160, 160].entries()) {
        const element = frames[index]!;
        await page.getByAltText(images[index]!.alt, { exact: true }).hover();
        for (const animation of element.getAnimations({ subtree: true })) {
          animation.finish();
        }
        const frameRect = element.getBoundingClientRect();
        const actionsRect = element.querySelector(".chat-image-actions")!.getBoundingClientRect();
        expect(getComputedStyle(element, "::after").opacity).toBe("1");
        expect(actionsRect.left).toBeGreaterThanOrEqual(frameRect.left);
        expect(actionsRect.right).toBeLessThanOrEqual(frameRect.right);
        expect(actionsRect.top).toBeGreaterThanOrEqual(frameRect.top);
        expect(actionsRect.bottom).toBeLessThanOrEqual(frameRect.bottom);
        for (const action of element.querySelectorAll<HTMLButtonElement>(".chat-image-action")) {
          const rect = action.getBoundingClientRect();
          expect(
            action.contains(
              document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2),
            ),
          ).toBe(true);
        }
        expect(frameRect.bottom - actionsRect.bottom).toBeLessThanOrEqual(9);
        expect(Number.parseFloat(getComputedStyle(element, "::after").width)).toBeCloseTo(
          frameRect.width,
          0,
        );
        expect(frameRect.width).toBeCloseTo(expectedWidth, 0);
        expect(getComputedStyle(element).overflow).toBe("hidden");
      }
    },
  );

  it.each(
    [1440, 390].flatMap((viewport) =>
      ["light", "dark"].flatMap((theme) =>
        [
          ...[1, 2, 3].flatMap((count) =>
            [false, true].flatMap((withDocument) =>
              [0, 1].map((available) => ({
                role: "assistant",
                name: "unknown dimensions",
                width: undefined,
                height: undefined,
                count,
                document: withDocument,
                available,
              })),
            ),
          ),
          {
            role: "assistant",
            name: "known dimensions",
            width: 1200,
            height: 800,
            count: 2,
            document: true,
            available: 0,
          },
          {
            role: "assistant",
            name: "panorama",
            width: 1200,
            height: 80,
            count: 2,
            document: true,
            available: 0,
          },
          {
            role: "assistant",
            name: "tall image",
            width: 420,
            height: 1800,
            count: 2,
            document: true,
            available: 0,
          },
          {
            role: "assistant",
            name: "tiny tall image",
            width: 80,
            height: 1600,
            count: 2,
            document: true,
            available: 0,
          },
          {
            role: "user",
            name: "pair",
            width: 1200,
            height: 800,
            count: 2,
            document: true,
            available: 0,
          },
          {
            role: "user",
            name: "mixed gallery",
            width: 1200,
            height: 800,
            count: 2,
            document: true,
            available: 3,
          },
        ].map((scenario) => ({ viewport, theme, scenario })),
      ),
    ),
  )(
    "keeps unavailable attachment blocks compact at $viewport px in $theme: $scenario",
    async ({ viewport, theme, scenario }) => {
      const { role, width: imageWidth, height: imageHeight, count, available } = scenario;
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
      const draw = () =>
        render(
          html`<div class="chat-group ${role}">
            <div class="chat-group-messages">
              ${renderMessageImages(images, { sessionKey: "unavailable-geometry", agentId: "main", onRequestUpdate: draw })}
              ${scenario.document ? renderCompactAttachmentCard({ kind: "document", label: "notes.pdf" }) : nothing}
              <p data-next-message>Next message</p>
            </div>
          </div>`,
          container,
        );
      subscribers.push(draw);
      draw();
      await waitForFast(() =>
        expect(
          container.querySelectorAll(".chat-assistant-attachment-card--blocked button"),
        ).toHaveLength(count),
      );
      await Promise.all([...container.querySelectorAll("img")].map((image) => image.decode()));
      const reference = scenario.document ? container : mount(400);
      if (!scenario.document) {
        render(renderCompactAttachmentCard({ kind: "document", label: "notes.pdf" }), reference);
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
      const slots = () =>
        [...gallery.children].map((element) => {
          const { x, y, width, height } = element.getBoundingClientRect();
          return { x, y, width, height };
        });
      const before = slots();
      expect(before).toHaveLength(count + available);
      const galleryStyle = getComputedStyle(gallery);
      const gap = Number.parseFloat(galleryStyle.rowGap);
      const columns = role === "user" ? galleryStyle.gridTemplateColumns.split(" ").length : 1;
      const rowHeights = Array.from({ length: Math.ceil(before.length / columns) }, (_, row) =>
        Math.max(
          ...before
            .slice(row * columns, (row + 1) * columns)
            .map((slot, offset) => (row * columns + offset < count ? fileHeight : slot.height)),
        ),
      );
      const compactHeight =
        rowHeights.reduce((sum, height) => sum + height, 0) + gap * (rowHeights.length - 1);
      expect(gallery.getBoundingClientRect().height).toBeCloseTo(compactHeight, 1);
      if (scenario.document) {
        const parentGap = Number.parseFloat(getComputedStyle(gallery.parentElement!).rowGap);
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
        expect(Math.abs(card.getBoundingClientRect().height - fileHeight)).toBeLessThanOrEqual(1);
        expect(Math.abs(before[index]!.height - fileHeight)).toBeLessThanOrEqual(1);
        const cardCorners = cornerInsets(card);
        const rect = card.getBoundingClientRect();
        // Compare both outlines at the same subpixel coordinates so browser hit
        // testing cannot round two equivalent corners onto different pixels.
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
      for (const remaining of [...gallery.children].slice(1, count)) {
        expect(remaining.getBoundingClientRect().height).toBe(fileHeight);
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
      const source = `/api/chat/media/outgoing/agent%3Amain%3Amain/${crypto.randomUUID()}/full`;
      render(
        html`${renderMessageImages([{ url: source, width: sized ? 1200 : undefined, height: sized ? 800 : undefined }])}
          <p data-next-message>Next message</p>`,
        container,
      );
      const before = geometry(container);
      response.resolve(new Response(null, { status: 404 }));
      await waitForFast(() => expect(frame(container).getAttribute("aria-busy")).toBe("false"));
      expect(container.querySelector(".chat-assistant-attachment-card")?.textContent).toContain(
        "load",
      );
      expect(geometry(container).height).toBe(74);
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
