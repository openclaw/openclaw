import { html, nothing, render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import { renderAssistantAttachments } from "./chat-message-attachments.ts";
import { renderMessageImages } from "./chat-message-images.ts";
import { releaseChatMediaResourceSubscriber } from "./chat-message-media.ts";
import "../../../test-helpers/load-styles.ts";

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
  beforeEach(() => {
    originalViewport = { width: window.innerWidth, height: window.innerHeight };
  });
  afterEach(async () => {
    const { page } = await import("vitest/browser");
    await page.viewport(originalViewport.width, originalViewport.height);
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
        name: "unknown dimensions",
        width: undefined,
        height: undefined,
        pane: 500,
        expectedWidth: 400,
        expectedHeight: 400 / 1.5,
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
      await vi.waitFor(() => expect(container.querySelector("img")).not.toBeNull());
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
      const remounted = container.querySelector("img")!;
      expect(remounted.getAttribute("src")).toBe(image.getAttribute("src"));
      await remounted.decode();
      expect(geometry(container)).toEqual(before);
      expect(fetchMock).toHaveBeenCalledOnce();
    },
  );

  it.each(["attachment", "image block"])(
    "keeps a local %s slot through metadata authorization without a file card",
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
                ? renderAssistantAttachments(
                    [
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
                    ],
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
      expect(container.querySelector(".chat-assistant-attachment-card")).toBeNull();
      response.resolve(
        Response.json({
          available: true,
          mediaTicket: "test-ticket",
          mediaTicketExpiresAt: new Date(Date.now() + 300_000).toISOString(),
        }),
      );
      await vi.waitFor(() => expect(container.querySelector("img")).not.toBeNull());
      expect(geometry(container)).toEqual(before);
      const sourceUrl = container.querySelector("img")!.getAttribute("src");
      expect(container.querySelector("img")!.getAttribute("width")).toBe("1200");
      render(nothing, container);
      draw();
      expect(container.querySelector("img")?.getAttribute("src")).toBe(sourceUrl);
      expect(geometry(container)).toEqual(before);
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
      await vi.waitFor(() => expect(container.querySelectorAll("img")).toHaveLength(count));
      await Promise.all([...container.querySelectorAll("img")].map((image) => image.decode()));
      expect(rectangles()).toEqual(before);
      expect(container.querySelector("[data-next-message]")!.getBoundingClientRect().top).toBe(
        nextTop,
      );
    },
  );

  it("anchors real image actions around tiny and tall previews", async () => {
    const { page } = await import("vitest/browser");
    await page.viewport(1280, 900);
    const container = mount(500);
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(svgResponse(16, 16))
        .mockResolvedValueOnce(svgResponse(420, 1800)),
    );
    const images = [
      {
        url: "/api/chat/media/outgoing/agent%3Amain%3Amain/tiny-actions/full",
        width: 16,
        height: 16,
        alt: "Tiny generated image",
      },
      {
        url: "/api/chat/media/outgoing/agent%3Amain%3Amain/tall-actions/full",
        width: 420,
        height: 1800,
        alt: "Tall generated image",
      },
    ];
    render(
      html`<div class="chat-group assistant">
        <div class="chat-group-messages">${renderMessageImages(images)}</div>
      </div>`,
      container,
    );
    await vi.waitFor(() => expect(container.querySelectorAll("img")).toHaveLength(2));
    await Promise.all([...container.querySelectorAll("img")].map((image) => image.decode()));
    const frames = [...container.querySelectorAll<HTMLElement>(".chat-image-frame--managed")];
    expect(frames[1]!.getBoundingClientRect().top).toBeGreaterThan(
      frames[0]!.getBoundingClientRect().bottom,
    );
    for (const [index, expectedWidth] of [160, 84].entries()) {
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
      expect(frameRect.bottom - actionsRect.bottom).toBeLessThanOrEqual(9);
      expect(Number.parseFloat(getComputedStyle(element, "::after").width)).toBeCloseTo(
        frameRect.width,
        0,
      );
      expect(frameRect.width).toBeCloseTo(expectedWidth, 0);
      expect(getComputedStyle(element).overflow).toBe("hidden");
    }
  });

  it("retains an explained image slot after a failed thumbnail fetch", async () => {
    const container = mount(500);
    const response = createDeferred<Response>();
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => response.promise)
      .mockResolvedValueOnce(svgResponse(1200, 800));
    vi.stubGlobal("fetch", fetchMock);
    const source = `/api/chat/media/outgoing/agent%3Amain%3Amain/${crypto.randomUUID()}/full`;
    render(
      html`${renderMessageImages([{ url: source, width: 1200, height: 800 }])}
        <p data-next-message>Next message</p>`,
      container,
    );
    const before = geometry(container);
    response.resolve(new Response(null, { status: 404 }));
    await vi.waitFor(() => expect(frame(container).getAttribute("aria-busy")).toBe("false"));
    expect(container.querySelector("[role=status]")?.textContent).toContain("load");
    expect(geometry(container)).toEqual(before);
    const { page } = await import("vitest/browser");
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await vi.waitFor(() => expect(container.querySelector("img")).not.toBeNull());
    await container.querySelector("img")!.decode();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(geometry(container)).toEqual(before);
  });
});
