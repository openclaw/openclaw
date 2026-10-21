import { readFile } from "node:fs/promises";
import path from "node:path";
import type { BrowserContextOptions, Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { finishElementAnimations } from "../test-helpers/animations.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { exactButton, newChatPage } from "./chat-flow.test-support.ts";
import { polledAttribute, polledText } from "./chat-presentation.test-support.ts";
import { openChatSidePanelType } from "./chat-side-panel.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI image lightbox",
  trackBrowserContexts: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});
const expectLoadedImage = (image: Locator) =>
  expect
    .poll(() =>
      image.evaluate((element) =>
        element instanceof HTMLImageElement && element.complete ? element.naturalWidth : 0,
      ),
    )
    .toBeGreaterThan(0);
const expectFocused = (element: Locator) =>
  expect.poll(() => element.evaluate((node) => node.matches(":focus"))).toBe(true);
const newPage = (options: BrowserContextOptions = {}) =>
  newChatPage(suite, {
    locale: "en-US",
    serviceWorkers: "block",
    viewport: { height: 900, width: 1440 },
    ...options,
  });
const imageDataUrls = (page: Page, sizes: ReadonlyArray<readonly [number, number]>) =>
  page.evaluate(
    (dimensions) =>
      dimensions.map(([width, height], index) => {
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const drawing = canvas.getContext("2d")!;
        drawing.fillStyle = `rgb(${index * 30}, 50, 80)`;
        drawing.fillRect(0, 0, width, height);
        return canvas.toDataURL("image/png");
      }),
    sizes,
  );
const counterValue = (counter: Locator) =>
  expect.poll(async () => (await counter.textContent())?.trim());
async function installImageGalleries(page: Page) {
  const images = await imageDataUrls(
    page,
    Array.from({ length: 5 }, (_, index) =>
      index % 2 ? ([360, 640] as const) : ([720, 400] as const),
    ),
  );
  const gateway = await installMockGateway(page, {
    historyMessages: [1, 2, 5].map((count) => ({
      role: "assistant",
      content: images.slice(0, count).map((url, index) => ({
        type: "image",
        url,
        alt: `Gallery ${count} image ${index + 1}`,
      })),
      timestamp: 1_800_000_000_000 + count,
    })),
  });
  await page.goto(`${suite.server.baseUrl}chat`);
  await gateway.waitForRequest("chat.startup");
}

suite.define(() => {
  it("opens transcript and sidebar images in one accessible modal", async () => {
    const banner = await readFile(path.join(process.cwd(), "docs/assets/openclaw-banner-dark.png"));
    const bannerBase64 = banner.toString("base64");
    const page = await newPage();
    const artifact = {
      id: "artifact-image-lightbox",
      mimeType: "image/png",
      sizeBytes: banner.byteLength,
      title: "openclaw-banner.png",
      type: "image",
    };
    const gateway = await installMockGateway(page, {
      historyMessages: [
        {
          role: "assistant",
          content: [
            {
              type: "image",
              url: `data:image/png;base64,${bannerBase64}`,
              alt: "OpenClaw banner",
            },
          ],
          timestamp: Date.now(),
        },
      ],
      methodResponses: {
        "artifacts.list": {
          artifacts: [{ ...artifact, download: { mode: "bytes" } }],
        },
        "artifacts.download": {
          artifact,
          data: bannerBase64,
          encoding: "base64",
        },
        "sessions.files.list": {
          browser: { entries: [], path: "" },
          files: [],
          root: "/workspace",
          sessionKey: "main",
        },
      },
    });

    await page.goto(`${suite.server.baseUrl}chat`);
    await gateway.waitForRequest("chat.startup");

    const transcriptTrigger = page.getByRole("button", { name: "Open image OpenClaw banner" });
    await transcriptTrigger.waitFor({ state: "visible", timeout: 10_000 });
    const transcriptImage = transcriptTrigger.getByRole("img");
    const contextMenuPrevented = transcriptImage.evaluate(
      (image) =>
        new Promise<boolean>((resolve) => {
          image.addEventListener(
            "contextmenu",
            (event) => setTimeout(() => resolve(event.defaultPrevented), 0),
            { once: true },
          );
        }),
    );
    await transcriptImage.click({ button: "right" });
    expect(await contextMenuPrevented).toBe(false);
    expect(await page.locator(".chat-reply-context-menu").count()).toBe(0);
    await page.keyboard.press("Escape");
    await transcriptTrigger.click();

    const dialog = page.getByRole("dialog", { name: "Image preview: OpenClaw banner" });
    await dialog.waitFor({ state: "visible" });
    const closeButton = page.getByRole("button", { name: "Close image preview" });
    const downloadImage = exactButton(page, "Download image");
    await downloadImage.waitFor({ state: "visible" });
    expect(await page.getByRole("link", { name: "Open in new tab" }).count()).toBe(0);
    const readControlContrast = () =>
      page.locator("openclaw-image-lightbox").evaluate((lightbox) => {
        return [".download-image", ".close", '[aria-label="Zoom in"]'].map((selector) => {
          const style = getComputedStyle(lightbox.querySelector(selector)!);
          return {
            backdropFilter: style.backdropFilter,
            backgroundColor: style.backgroundColor,
            borderWidth: style.borderWidth,
            color: style.color,
          };
        });
      });
    for (const [theme, backgroundColor] of [
      ["dark", "rgba(255, 255, 255, 0.16)"],
      ["light", "rgba(12, 16, 24, 0.64)"],
    ] as const) {
      await page.evaluate(
        (mode) => document.documentElement.setAttribute("data-theme-mode", mode),
        theme,
      );
      await expect.poll(readControlContrast).toEqual(
        Array.from({ length: 3 }, () =>
          expect.objectContaining({
            backdropFilter: expect.stringContaining("blur(16px)"),
            backgroundColor,
            borderWidth: "0px",
            color: "rgb(255, 255, 255)",
          }),
        ),
      );
    }
    await page.evaluate(() => document.documentElement.setAttribute("data-theme-mode", "dark"));
    const focusIsInsideLightbox = () =>
      page.locator("openclaw-image-lightbox").evaluate((lightbox) => {
        let active: Element | null = document.activeElement;
        while (active instanceof HTMLElement && active.shadowRoot?.activeElement) {
          active = active.shadowRoot.activeElement;
        }
        let node: Node | null = active;
        while (node) {
          if (node === lightbox) {
            return true;
          }
          const root = node.getRootNode();
          node = root instanceof ShadowRoot ? root.host : node.parentNode;
        }
        return false;
      });
    await expectFocused(closeButton);
    const displayedImage = page.getByAltText("OpenClaw banner").last();
    await expectLoadedImage(displayedImage);
    await page
      .locator("openclaw-image-lightbox openclaw-modal-dialog > dialog")
      .evaluate(finishElementAnimations);
    const desktopBox = await page.locator("openclaw-image-lightbox .lightbox").boundingBox();
    const viewport = page.viewportSize();
    expect(desktopBox).toMatchObject({
      x: 0,
      y: 0,
      width: viewport?.width,
      height: viewport?.height,
    });
    const requestedDownload = page.waitForEvent("download");
    await downloadImage.click();
    expect((await requestedDownload).suggestedFilename()).toBe("OpenClaw banner.png");
    await closeButton.focus();
    await page.keyboard.press("Tab");
    await expect.poll(focusIsInsideLightbox).toBe(true);
    await page.keyboard.press("Shift+Tab");
    await expect.poll(focusIsInsideLightbox).toBe(true);
    await page.keyboard.press("Escape");
    await expect.poll(() => dialog.count()).toBe(0);
    await expectFocused(transcriptTrigger);

    await openChatSidePanelType(page, "Files");
    const artifactRow = page
      .locator(".workspace-desktop")
      .getByRole("button", { name: "openclaw-banner.png", exact: true });
    await artifactRow.waitFor({ state: "visible", timeout: 10_000 });
    await artifactRow.click();
    const sidebarTrigger = page
      .getByRole("button", { name: "Open image openclaw-banner.png", exact: true })
      .filter({ has: page.getByRole("img", { name: "openclaw-banner.png", exact: true }) });
    await sidebarTrigger.waitFor({ state: "visible", timeout: 10_000 });

    await sidebarTrigger.click();
    const sidebarDialog = page.getByRole("dialog", {
      name: "Image preview: openclaw-banner.png",
    });
    await sidebarDialog.waitFor({ state: "visible" });
    await page.getByRole("button", { name: "Close image preview" }).click();
    await expect.poll(() => sidebarDialog.count()).toBe(0);
    await expectFocused(sidebarTrigger);

    await page.setViewportSize({ height: 844, width: 390 });
    await sidebarTrigger.click();
    await sidebarDialog.waitFor({ state: "visible" });
    await page
      .locator("openclaw-image-lightbox openclaw-modal-dialog > dialog")
      .evaluate(finishElementAnimations);
    await page.locator("openclaw-image-lightbox").evaluate((lightbox) => {
      lightbox.style.setProperty("--safe-area-top", "18px");
      lightbox.style.setProperty("--safe-area-right", "12px");
      lightbox.style.setProperty("--safe-area-bottom", "22px");
      lightbox.style.setProperty("--safe-area-left", "12px");
      lightbox.setAttribute(
        "src",
        "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='600' height='1200'%3E%3Crect width='600' height='1200' fill='%2386a5ff'/%3E%3C/svg%3E",
      );
    });
    await expect
      .poll(() =>
        page
          .locator("openclaw-image-lightbox .image")
          .evaluate((image) =>
            image instanceof HTMLImageElement && image.complete ? image.naturalHeight : 0,
          ),
      )
      .toBe(1200);
    const mobileBox = await page.locator("openclaw-image-lightbox .lightbox").boundingBox();
    const mobileImage = page.locator("openclaw-image-lightbox .image");
    const readMobileLayout = () =>
      page.locator("openclaw-image-lightbox .stage").evaluate((stage) => {
        const root = stage.closest("openclaw-image-lightbox");
        const image = stage.querySelector("img");
        const header = root?.querySelector(".header");
        const controls = root?.querySelector(".zoom-controls");
        if (!image || !header || !controls) {
          throw new Error("missing lightbox geometry");
        }
        const rect = (element: Element) => {
          const box = element.getBoundingClientRect();
          return { bottom: box.bottom, left: box.left, right: box.right, top: box.top };
        };
        const imageBox = rect(image);
        const stageBox = rect(stage);
        const overlaps = (other: ReturnType<typeof rect>) =>
          Math.min(imageBox.right, other.right) > Math.max(imageBox.left, other.left) &&
          Math.min(imageBox.bottom, other.bottom) > Math.max(imageBox.top, other.top);
        return {
          image: imageBox,
          stage: stageBox,
          overlapsControls: overlaps(rect(controls)),
          overlapsHeader: overlaps(rect(header)),
        };
      });
    const mobileImageLayout = await readMobileLayout();
    const mobileViewport = await page.evaluate(() => ({
      height: window.innerHeight,
      width: window.innerWidth,
    }));
    expect(mobileBox?.width).toBeCloseTo(mobileViewport.width, 0);
    expect(mobileBox?.height).toBeCloseTo(mobileViewport.height, 0);
    expect(mobileImageLayout.image.left).toBeGreaterThanOrEqual(mobileImageLayout.stage.left);
    expect(mobileImageLayout.image.right).toBeLessThanOrEqual(mobileImageLayout.stage.right);
    expect(mobileImageLayout.image.top).toBeGreaterThanOrEqual(mobileImageLayout.stage.top);
    expect(mobileImageLayout.image.bottom).toBeLessThanOrEqual(mobileImageLayout.stage.bottom);
    expect(mobileImageLayout).toMatchObject({ overlapsHeader: false, overlapsControls: false });
    await page.setViewportSize({ height: 500, width: 932 });
    const landscapeLayout = await readMobileLayout();
    expect(landscapeLayout).toMatchObject({ overlapsHeader: false, overlapsControls: false });
    await page.setViewportSize({ height: 844, width: 390 });
    const readMobileScale = () =>
      mobileImage.evaluate((image) =>
        Number(new DOMMatrixReadOnly(getComputedStyle(image).transform).a.toFixed(2)),
      );
    await mobileImage.dblclick();
    await expect.poll(readMobileScale).toBeGreaterThan(1);
    await page.getByRole("button", { name: "Reset zoom" }).click();
    await expect.poll(readMobileScale).toBe(1);
    await page.getByRole("button", { name: "Zoom in" }).click();
    await expect.poll(readMobileScale).toBeGreaterThan(1);
    const zoomedImageBox = await mobileImage.boundingBox();
    expect((zoomedImageBox?.x ?? 0) + (zoomedImageBox?.width ?? 0)).toBeGreaterThan(0);
    expect((zoomedImageBox?.y ?? 0) + (zoomedImageBox?.height ?? 0)).toBeGreaterThan(0);
    expect(zoomedImageBox?.x ?? mobileViewport.width).toBeLessThan(mobileViewport.width);
    expect(zoomedImageBox?.y ?? mobileViewport.height).toBeLessThan(mobileViewport.height);
    await page.keyboard.press("Escape");
    await expect.poll(() => sidebarDialog.count()).toBe(0);
  });

  it("navigates inbound MEDIA renditions in their message after history reload", async () => {
    const page = await newPage();
    const names = ["before", "after", "hover"];
    const images = (
      await imageDataUrls(
        page,
        names.map(() => [800, 480] as const),
      )
    ).map((dataUrl) => dataUrl.split(",")[1]!);
    const sources = names.map((name) => "media://inbound/" + name + ".png");
    const mediaRequests: { source: string; variant: string | null; width: string | null }[] = [];
    const renditionSources = () =>
      mediaRequests.filter((request) => request.width === "1920").map((request) => request.source);
    await page.route("**/__openclaw__/assistant-media?**", async (route) => {
      const url = new URL(route.request().url());
      const index = sources.indexOf(url.searchParams.get("source") ?? "");
      expect(index).toBeGreaterThanOrEqual(0);
      if (url.searchParams.get("meta") === "1") {
        await route.fulfill({
          json: {
            available: true,
            mediaTicket: "gallery-proof",
            mediaTicketExpiresAt: new Date(Date.now() + 300_000).toISOString(),
          },
        });
      } else {
        expect(url.searchParams.get("mediaTicket")).toBe("gallery-proof");
        mediaRequests.push({
          source: sources[index]!,
          variant: url.searchParams.get("variant"),
          width: url.searchParams.get("width"),
        });
        await route.fulfill({
          contentType: "image/png",
          body: Buffer.from(images[index]!, "base64"),
        });
      }
    });
    const gateway = await installMockGateway(page, {
      historyMessages: [
        {
          role: "assistant",
          content: [
            {
              type: "text",
              text:
                "Three image attachments in one reply.\n\n" +
                sources.map((source) => "MEDIA:" + source).join("\n"),
            },
          ],
          timestamp: 1_800_000_000_000,
        },
      ],
    });
    await page.goto(suite.server.baseUrl + "chat");
    await gateway.waitForRequest("chat.startup");
    const trigger = exactButton(page, "Open image before.png");
    const lightbox = page.locator("openclaw-image-lightbox");
    const image = lightbox.locator(".image");
    for (const reloaded of [false, true]) {
      if (reloaded) {
        await page.reload();
      }
      await trigger.click();
      await lightbox.getByRole("dialog").waitFor({ state: "visible" });
      await expectLoadedImage(image);
      await polledAttribute(image, "src").toContain("width=1920");
      expect(renditionSources()).toEqual([sources[0]]);
      expect(mediaRequests.every((request) => request.variant === "thumbnail")).toBe(true);
      await page.keyboard.press("ArrowRight");
      await polledAttribute(image, "alt").toBe("after.png");
      await polledText(lightbox.locator(".gallery-counter")).toContain("2 / 3");
      expect(renditionSources()).toEqual(sources.slice(0, 2));
      await page.keyboard.press("ArrowRight");
      await polledAttribute(image, "alt").toBe("hover.png");
      await page.keyboard.press("ArrowLeft");
      await polledAttribute(image, "alt").toBe("after.png");
      expect(renditionSources()).toEqual(sources);
      expect(mediaRequests.every((request) => request.variant === "thumbnail")).toBe(true);
      const requestedDownload = page.waitForEvent("download");
      await exactButton(lightbox, "Download image").click();
      expect((await requestedDownload).suggestedFilename()).toBe("after.png");
      expect(mediaRequests.filter((request) => request.variant !== "thumbnail")).toEqual([
        { source: sources[1], variant: null, width: null },
      ]);
      mediaRequests.length = 0;
      await page.keyboard.press("Escape");
      await expect.poll(() => lightbox.count()).toBe(0);
      await expectFocused(trigger);
    }
  });

  it("navigates only the opened message gallery and restores its original tile focus", async () => {
    const page = await newPage();
    await installImageGalleries(page);
    const lightbox = page.locator("openclaw-image-lightbox");
    const counter = lightbox.locator(".gallery-counter");
    const previous = exactButton(lightbox, "Previous image");
    const next = exactButton(lightbox, "Next image");
    const image = lightbox.locator(".image");
    for (const count of [1, 2, 5]) {
      const openedIndex = count > 1 ? 2 : 1;
      const trigger = exactButton(page, `Open image Gallery ${count} image ${openedIndex}`);
      await trigger.click();
      await lightbox.getByRole("dialog").waitFor({ state: "visible" });
      await polledAttribute(image, "alt").toBe(`Gallery ${count} image ${openedIndex}`);
      if (count === 1) {
        expect(await counter.count()).toBe(0);
        expect(await previous.count()).toBe(0);
        expect(await next.count()).toBe(0);
        await page.keyboard.press("ArrowRight");
        expect(await image.getAttribute("alt")).toBe("Gallery 1 image 1");
      } else {
        await counterValue(counter).toBe(`2 / ${count}`);
        expect(await counter.getAttribute("aria-live")).toBe("polite");
        await previous.click();
        await polledAttribute(image, "alt").toBe(`Gallery ${count} image 1`);
        expect(await previous.isDisabled()).toBe(true);
        await page.keyboard.press("ArrowLeft");
        expect((await counter.textContent())?.trim()).toBe(`1 / ${count}`);
        await lightbox.locator("openclaw-modal-dialog > dialog").evaluate(finishElementAnimations);
        const stageBox = await lightbox.locator(".stage").boundingBox();
        for (let index = 2; index <= count; index++) {
          if (index === 2) {
            await next.click();
          } else {
            await page.keyboard.press("ArrowRight");
          }
          await counterValue(counter).toBe(`${index} / ${count}`);
          await polledAttribute(image, "alt").toBe(`Gallery ${count} image ${index}`);
          await expectLoadedImage(image);
          expect(await lightbox.locator(".stage").boundingBox()).toEqual(stageBox);
        }
        expect(await next.isDisabled()).toBe(true);
        await page.keyboard.press("ArrowRight");
        expect((await counter.textContent())?.trim()).toBe(`${count} / ${count}`);
      }
      await page.keyboard.press("Escape");
      await expect.poll(() => lightbox.count()).toBe(0);
      await expectFocused(trigger);
    }
  });

  it("tracks touch swipes, cancels short and vertical gestures, and preserves pinch zoom", async () => {
    const page = await newPage({
      hasTouch: true,
      isMobile: true,
      viewport: { height: 844, width: 390 },
    });
    await installImageGalleries(page);
    await exactButton(page, "Open image Gallery 5 image 2").click();
    const lightbox = page.locator("openclaw-image-lightbox");
    const counter = lightbox.locator(".gallery-counter");
    const image = lightbox.locator(".image");
    await counterValue(counter).toBe("2 / 5");
    await expect.poll(() => exactButton(lightbox, "Zoom in").isEnabled()).toBe(true);
    await lightbox.locator("openclaw-modal-dialog > dialog").evaluate(finishElementAnimations);
    const touch = await page.context().newCDPSession(page);
    const readSlideOffset = () =>
      lightbox
        .locator(".slide")
        .evaluate((element) => new DOMMatrixReadOnly(getComputedStyle(element).transform).m41);
    const readScale = () =>
      image.evaluate((element) => new DOMMatrixReadOnly(getComputedStyle(element).transform).a);
    const center = async () => {
      const box = await image.boundingBox();
      if (!box) {
        throw new Error("missing gallery image geometry");
      }
      return { x: box.x + box.width / 2, y: box.y + box.height / 2, id: 1 };
    };
    const swipe = async (dx: number, dy = 0, inspectDrag = false, cancel = false) => {
      const point = await center();
      await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
      for (let step = 1; step <= 5; step++) {
        await touch.send("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: [{ ...point, x: point.x + (dx * step) / 5, y: point.y + (dy * step) / 5 }],
        });
      }
      if (inspectDrag) {
        await expect.poll(readSlideOffset).toBeLessThan(-30);
      }
      await touch.send("Input.dispatchTouchEvent", {
        type: cancel ? "touchCancel" : "touchEnd",
        touchPoints: [],
      });
      await expect.poll(readSlideOffset).toBe(0);
    };
    for (const button of ["Previous image", "Next image"]) {
      expect(
        await exactButton(lightbox, button).evaluate(
          (element) => getComputedStyle(element).opacity,
        ),
      ).toBe("1");
    }
    await swipe(-24);
    expect((await counter.textContent())?.trim()).toBe("2 / 5");
    await swipe(-30, 120);
    expect((await counter.textContent())?.trim()).toBe("2 / 5");
    await swipe(-130, 0, true, true);
    expect((await counter.textContent())?.trim()).toBe("2 / 5");
    await swipe(-130, 0, true);
    await counterValue(counter).toBe("3 / 5");

    await exactButton(lightbox, "Zoom in").click();
    await expect.poll(readScale).toBeGreaterThan(1);
    await swipe(-130);
    expect((await counter.textContent())?.trim()).toBe("3 / 5");
    await exactButton(lightbox, "Reset zoom").click();
    await expect.poll(readScale).toBe(1);
    const point = await center();
    await touch.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [
        { ...point, x: point.x - 30 },
        { ...point, id: 2, x: point.x + 30 },
      ],
    });
    await touch.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [
        { ...point, x: point.x - 100 },
        { ...point, id: 2, x: point.x + 100 },
      ],
    });
    await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await expect.poll(readScale).toBeGreaterThan(1);
    expect((await counter.textContent())?.trim()).toBe("3 / 5");
    await exactButton(lightbox, "Reset zoom").click();
    await expect.poll(readScale).toBe(1);

    await page.evaluate(() => {
      document.documentElement.dir = "rtl";
    });
    const headerOverlaps = () =>
      lightbox.evaluate((element) => {
        const counterBounds = element.querySelector(".gallery-counter")!.getBoundingClientRect();
        const actions = element.querySelector(".actions")!.getBoundingClientRect();
        return (
          Math.min(counterBounds.right, actions.right) >
            Math.max(counterBounds.left, actions.left) &&
          Math.min(counterBounds.bottom, actions.bottom) > Math.max(counterBounds.top, actions.top)
        );
      });
    await expect.poll(headerOverlaps).toBe(false);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await swipe(130);
    await counterValue(counter).toBe("4 / 5");
    await page.keyboard.press("ArrowLeft");
    await counterValue(counter).toBe("5 / 5");
    await page.keyboard.press("ArrowLeft");
    expect((await counter.textContent())?.trim()).toBe("5 / 5");
    await page.keyboard.press("ArrowRight");
    await counterValue(counter).toBe("4 / 5");
    await swipe(-130);
    await counterValue(counter).toBe("3 / 5");
    await exactButton(lightbox, "Close image preview").click();
    await expect.poll(() => lightbox.count()).toBe(0);
    await touch.detach();
  });
});
