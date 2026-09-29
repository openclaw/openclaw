import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { beforeEach, afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { finishElementAnimations } from "../test-helpers/animations.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";
import { openChatSidePanelType } from "./chat-side-panel.test-support.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;
const captureUiProofEnabled = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
let proofDir: string;
beforeEach(() => {
  if (captureUiProofEnabled) {
    proofDir = createControlUiE2eArtifactDir("image-lightbox");
  }
});

let server: ControlUiE2eServer;
let browser: Browser;
const openContexts = new Set<BrowserContext>();

async function newContext(options: Parameters<Browser["newContext"]>[0]) {
  const context = await browser.newContext(options);
  openContexts.add(context);
  return context;
}

async function closeContext(context: BrowserContext) {
  openContexts.delete(context);
  await context.close().catch(() => {});
}

async function installImageGalleries(page: Page) {
  const images = await page.evaluate(() =>
    Array.from({ length: 12 }, (_, index) => {
      const canvas = document.createElement("canvas");
      canvas.width = index % 2 ? 360 : 720;
      canvas.height = index % 2 ? 640 : 400;
      const context = canvas.getContext("2d")!;
      context.fillStyle = index % 2 ? "#31506f" : "#73583d";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = "white";
      context.font = "48px sans-serif";
      context.fillText(String(index + 1), 40, 80);
      return canvas.toDataURL("image/png");
    }),
  );
  const gateway = await installMockGateway(page, {
    historyMessages: [1, 2, 5, 12].map((count) => ({
      role: "assistant",
      content: images.slice(0, count).map((url, index) => ({
        type: "image",
        url,
        alt: `Gallery ${count} image ${index + 1}`,
      })),
      timestamp: 1_800_000_000_000 + count,
    })),
  });
  await page.goto(`${server.baseUrl}chat`);
  await gateway.waitForRequest("chat.startup");
}

describeControlUiE2e("Control UI image lightbox", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(`Playwright Chromium is unavailable at ${chromiumExecutablePath}`);
    }
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
    server = await startControlUiE2eServer();
  });

  afterEach(async () => {
    await Promise.all([...openContexts].map((context) => closeContext(context)));
  });

  afterAll(async () => {
    await Promise.all([...openContexts].map((context) => closeContext(context)));
    await browser?.close();
    await server?.close();
  });

  it("opens transcript and sidebar images in one accessible modal", async () => {
    const banner = await readFile(path.join(process.cwd(), "docs/assets/openclaw-banner-dark.png"));
    const bannerBase64 = banner.toString("base64");
    const dataUrl = `data:image/png;base64,${bannerBase64}`;
    const context = await newContext({
      locale: "en-US",
      recordVideo: captureUiProofEnabled
        ? { dir: proofDir, size: { height: 900, width: 1440 } }
        : undefined,
      serviceWorkers: "block",
      viewport: { height: 900, width: 1440 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      historyMessages: [
        {
          role: "assistant",
          content: [
            {
              type: "image",
              url: dataUrl,
              alt: "OpenClaw banner",
            },
          ],
          timestamp: Date.now(),
        },
      ],
      methodResponses: {
        "artifacts.list": {
          artifacts: [
            {
              download: { mode: "bytes" },
              id: "artifact-image-lightbox",
              mimeType: "image/png",
              sizeBytes: banner.byteLength,
              title: "openclaw-banner.png",
              type: "image",
            },
          ],
        },
        "artifacts.download": {
          artifact: {
            id: "artifact-image-lightbox",
            mimeType: "image/png",
            sizeBytes: banner.byteLength,
            title: "openclaw-banner.png",
            type: "image",
          },
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

    try {
      await page.goto(`${server.baseUrl}chat`);
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
      const openOriginal = page.getByRole("link", { name: "Open in new tab" });
      await openOriginal.waitFor({ state: "visible" });
      await expect.poll(() => openOriginal.getAttribute("href")).toMatch(/^blob:/);
      const readControlContrast = () =>
        page.locator("openclaw-image-lightbox").evaluate((lightbox) => {
          const root = lightbox.shadowRoot!;
          return [".open-original", ".close", '[aria-label="Zoom in"]'].map((selector) => {
            const style = getComputedStyle(root.querySelector(selector)!);
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
        await expect.poll(readControlContrast).toEqual([
          expect.objectContaining({
            backdropFilter: expect.stringContaining("blur(16px)"),
            backgroundColor,
            borderWidth: "0px",
            color: "rgb(255, 255, 255)",
          }),
          expect.objectContaining({
            backdropFilter: expect.stringContaining("blur(16px)"),
            backgroundColor,
            borderWidth: "0px",
            color: "rgb(255, 255, 255)",
          }),
          expect.objectContaining({
            backdropFilter: expect.stringContaining("blur(16px)"),
            backgroundColor,
            borderWidth: "0px",
            color: "rgb(255, 255, 255)",
          }),
        ]);
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
      await expect
        .poll(() => closeButton.evaluate((element) => element.matches(":focus")))
        .toBe(true);
      const displayedImage = page.getByAltText("OpenClaw banner").last();
      await expect
        .poll(() =>
          displayedImage.evaluate((image) =>
            image instanceof HTMLImageElement && image.complete ? image.naturalWidth : 0,
          ),
        )
        .toBeGreaterThan(0);
      await page
        .locator("openclaw-image-lightbox wa-dialog dialog")
        .evaluate(finishElementAnimations);
      const desktopBox = await page.locator("openclaw-image-lightbox .lightbox").boundingBox();
      const viewport = page.viewportSize();
      expect(desktopBox?.x).toBe(0);
      expect(desktopBox?.y).toBe(0);
      expect(desktopBox?.width).toBe(viewport?.width);
      expect(desktopBox?.height).toBe(viewport?.height);
      const originalPopup = page.waitForEvent("popup");
      await openOriginal.click();
      const originalPage = await originalPopup;
      await expect.poll(() => originalPage.url()).toMatch(/^blob:/);
      await originalPage.close();
      await closeButton.focus();
      await page.keyboard.press("Tab");
      await expect.poll(focusIsInsideLightbox).toBe(true);
      await page.keyboard.press("Shift+Tab");
      await expect.poll(focusIsInsideLightbox).toBe(true);
      await page.keyboard.press("Escape");
      await expect.poll(() => dialog.count()).toBe(0);
      await expect
        .poll(() => transcriptTrigger.evaluate((element) => element.matches(":focus")))
        .toBe(true);

      await openChatSidePanelType(page, "Files");
      await page.locator(".chat-workspace-rail__group-summary", { hasText: "Artifacts" }).click();
      const artifactRow = page.locator(".chat-workspace-rail__file-open", {
        hasText: "openclaw-banner.png",
      });
      await artifactRow.waitFor({ state: "visible", timeout: 10_000 });
      await artifactRow.click();
      const sidebarTrigger = page.getByRole("button", {
        name: "Open image openclaw-banner.png",
      });
      await sidebarTrigger.waitFor({ state: "visible", timeout: 10_000 });

      if (captureUiProofEnabled) {
        await writeFile(
          path.join(proofDir, "01-sidebar-image.png"),
          await takeControlUiViewportScreenshot(page, page.locator(".shell"), [sidebarTrigger]),
        );
      }

      await sidebarTrigger.click();
      const sidebarDialog = page.getByRole("dialog", {
        name: "Image preview: openclaw-banner.png",
      });
      await sidebarDialog.waitFor({ state: "visible" });
      if (captureUiProofEnabled) {
        await writeFile(
          path.join(proofDir, "02-sidebar-lightbox.png"),
          await takeControlUiViewportScreenshot(page, sidebarDialog, [
            page.getByRole("button", { name: "Close image preview" }),
          ]),
        );
      }
      await page.getByRole("button", { name: "Close image preview" }).click();
      await expect.poll(() => sidebarDialog.count()).toBe(0);
      await expect
        .poll(() => sidebarTrigger.evaluate((element) => element.matches(":focus")))
        .toBe(true);

      await page.setViewportSize({ height: 844, width: 390 });
      await sidebarTrigger.click();
      await sidebarDialog.waitFor({ state: "visible" });
      await page
        .locator("openclaw-image-lightbox wa-dialog dialog")
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
          const root = stage.getRootNode();
          const image = stage.querySelector("img");
          const header = root instanceof ShadowRoot ? root.querySelector(".header") : null;
          const controls = root instanceof ShadowRoot ? root.querySelector(".zoom-controls") : null;
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
      expect(mobileImageLayout.overlapsHeader).toBe(false);
      expect(mobileImageLayout.overlapsControls).toBe(false);
      await page.setViewportSize({ height: 500, width: 932 });
      const landscapeLayout = await readMobileLayout();
      expect(landscapeLayout.overlapsHeader).toBe(false);
      expect(landscapeLayout.overlapsControls).toBe(false);
      await page.setViewportSize({ height: 844, width: 390 });
      await mobileImage.dblclick();
      await expect
        .poll(() =>
          mobileImage.evaluate((image) =>
            Number(new DOMMatrixReadOnly(getComputedStyle(image).transform).a.toFixed(2)),
          ),
        )
        .toBeGreaterThan(1);
      await page.getByRole("button", { name: "Reset zoom" }).click();
      await expect
        .poll(() =>
          mobileImage.evaluate((image) =>
            Number(new DOMMatrixReadOnly(getComputedStyle(image).transform).a.toFixed(2)),
          ),
        )
        .toBe(1);
      const zoomIn = page.getByRole("button", { name: "Zoom in" });
      await zoomIn.click();
      await expect
        .poll(() =>
          mobileImage.evaluate((image) =>
            Number(new DOMMatrixReadOnly(getComputedStyle(image).transform).a.toFixed(2)),
          ),
        )
        .toBeGreaterThan(1);
      const zoomedImageBox = await mobileImage.boundingBox();
      expect((zoomedImageBox?.x ?? 0) + (zoomedImageBox?.width ?? 0)).toBeGreaterThan(0);
      expect((zoomedImageBox?.y ?? 0) + (zoomedImageBox?.height ?? 0)).toBeGreaterThan(0);
      expect(zoomedImageBox?.x ?? mobileViewport.width).toBeLessThan(mobileViewport.width);
      expect(zoomedImageBox?.y ?? mobileViewport.height).toBeLessThan(mobileViewport.height);
      if (captureUiProofEnabled) {
        await writeFile(
          path.join(proofDir, "03-mobile-lightbox.png"),
          await takeControlUiViewportScreenshot(page, sidebarDialog, [mobileImage]),
        );
      }
      await page.keyboard.press("Escape");
      await expect.poll(() => sidebarDialog.count()).toBe(0);
    } finally {
      await closeContext(context);
    }
  });

  it("navigates local MEDIA images in their message after history reload", async () => {
    const context = await newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1440 },
    });
    const page = await context.newPage();
    const names = ["before", "after", "hover"];
    const images = await page.evaluate(
      (labels) =>
        labels.map((label, index) => {
          const canvas = document.createElement("canvas");
          canvas.width = 800;
          canvas.height = 480;
          const drawing = canvas.getContext("2d")!;
          drawing.fillStyle = ["#314b69", "#315a49", "#655035"][index]!;
          drawing.fillRect(0, 0, canvas.width, canvas.height);
          drawing.fillStyle = "white";
          drawing.font = "40px sans-serif";
          drawing.fillText("Image gallery regression", 48, 100);
          drawing.fillText(label, 48, 200);
          drawing.font = "24px sans-serif";
          drawing.fillText("Synthetic local image attachment", 48, 360);
          return canvas.toDataURL("image/png").split(",")[1]!;
        }),
      names,
    );
    const sources = names.map((name) => "/workspace/" + name + ".png");
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
    await page.goto(server.baseUrl + "chat");
    await gateway.waitForRequest("chat.startup");
    const trigger = page.getByRole("button", { name: "Open image before.png", exact: true });
    const lightbox = page.locator("openclaw-image-lightbox");
    const image = lightbox.locator(".image");
    for (const reloaded of [false, true]) {
      if (reloaded) {
        await page.reload();
      }
      await trigger.click();
      await lightbox.getByRole("dialog").waitFor({ state: "visible" });
      await expect
        .poll(() =>
          image.evaluate(
            (element) =>
              element instanceof HTMLImageElement && element.complete && element.naturalWidth > 0,
          ),
        )
        .toBe(true);
      if (captureUiProofEnabled && !reloaded) {
        await lightbox.locator("wa-dialog dialog").evaluate(finishElementAnimations);
        await writeFile(
          path.join(proofDir, "media-gallery-open.png"),
          await takeControlUiViewportScreenshot(page, image, [image]),
        );
      }
      await page.keyboard.press("ArrowRight");
      await expect.poll(() => image.getAttribute("alt")).toBe("after.png");
      await expect
        .poll(() => lightbox.locator(".gallery-counter").textContent())
        .toContain("2 / 3");
      if (captureUiProofEnabled && !reloaded) {
        await writeFile(
          path.join(proofDir, "media-gallery-next.png"),
          await takeControlUiViewportScreenshot(page, image, [image]),
        );
      }
      await page.keyboard.press("ArrowRight");
      await expect.poll(() => image.getAttribute("alt")).toBe("hover.png");
      await page.keyboard.press("ArrowLeft");
      await expect.poll(() => image.getAttribute("alt")).toBe("after.png");
      await page.keyboard.press("Escape");
      await expect.poll(() => lightbox.count()).toBe(0);
      await expect.poll(() => trigger.evaluate((element) => element.matches(":focus"))).toBe(true);
    }
  });

  it("navigates only the opened message gallery and restores its original tile focus", async () => {
    const context = await newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1440 },
    });
    const page = await context.newPage();
    await installImageGalleries(page);
    const lightbox = page.locator("openclaw-image-lightbox");
    const counter = lightbox.locator(".gallery-counter");
    const previous = lightbox.getByRole("button", { name: "Previous image", exact: true });
    const next = lightbox.getByRole("button", { name: "Next image", exact: true });
    const image = lightbox.locator(".image");
    for (const count of [1, 2, 5, 12]) {
      const openedIndex = count > 1 ? 2 : 1;
      const trigger = page.getByRole("button", {
        name: `Open image Gallery ${count} image ${openedIndex}`,
        exact: true,
      });
      await trigger.click();
      await lightbox.getByRole("dialog").waitFor({ state: "visible" });
      await expect
        .poll(() => image.getAttribute("alt"))
        .toBe(`Gallery ${count} image ${openedIndex}`);
      if (count === 1) {
        expect(await counter.count()).toBe(0);
        expect(await previous.count()).toBe(0);
        expect(await next.count()).toBe(0);
        await page.keyboard.press("ArrowRight");
        expect(await image.getAttribute("alt")).toBe("Gallery 1 image 1");
      } else {
        await expect.poll(async () => (await counter.textContent())?.trim()).toBe(`2 / ${count}`);
        expect(await counter.getAttribute("aria-live")).toBe("polite");
        await previous.click();
        await expect.poll(() => image.getAttribute("alt")).toBe(`Gallery ${count} image 1`);
        expect(await previous.isDisabled()).toBe(true);
        await page.keyboard.press("ArrowLeft");
        expect((await counter.textContent())?.trim()).toBe(`1 / ${count}`);
        await lightbox.locator("wa-dialog dialog").evaluate(finishElementAnimations);
        const stageBox = await lightbox.locator(".stage").boundingBox();
        for (let index = 2; index <= count; index++) {
          if (index === 2) {
            await next.click();
          } else {
            await page.keyboard.press("ArrowRight");
          }
          await expect
            .poll(async () => (await counter.textContent())?.trim())
            .toBe(`${index} / ${count}`);
          await expect
            .poll(() => image.getAttribute("alt"))
            .toBe(`Gallery ${count} image ${index}`);
          await expect
            .poll(() =>
              image.evaluate(
                (element) =>
                  element instanceof HTMLImageElement &&
                  element.complete &&
                  element.naturalWidth > 0,
              ),
            )
            .toBe(true);
          expect(await lightbox.locator(".stage").boundingBox()).toEqual(stageBox);
        }
        expect(await next.isDisabled()).toBe(true);
        await page.keyboard.press("ArrowRight");
        expect((await counter.textContent())?.trim()).toBe(`${count} / ${count}`);
      }
      await page.keyboard.press("Escape");
      await expect.poll(() => lightbox.count()).toBe(0);
      await expect.poll(() => trigger.evaluate((element) => element.matches(":focus"))).toBe(true);
    }
  });

  it("tracks touch swipes, cancels short and vertical gestures, and preserves pinch zoom", async () => {
    const context = await newContext({
      locale: "en-US",
      hasTouch: true,
      isMobile: true,
      serviceWorkers: "block",
      viewport: { height: 844, width: 390 },
    });
    const page = await context.newPage();
    await installImageGalleries(page);
    await page.getByRole("button", { name: "Open image Gallery 5 image 2", exact: true }).click();
    const lightbox = page.locator("openclaw-image-lightbox");
    const counter = lightbox.locator(".gallery-counter");
    const image = lightbox.locator(".image");
    await expect.poll(async () => (await counter.textContent())?.trim()).toBe("2 / 5");
    await expect
      .poll(() => lightbox.getByRole("button", { name: "Zoom in", exact: true }).isEnabled())
      .toBe(true);
    await lightbox.locator("wa-dialog dialog").evaluate(finishElementAnimations);
    const touch = await context.newCDPSession(page);
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
        await lightbox
          .getByRole("button", { name: button, exact: true })
          .evaluate((element) => getComputedStyle(element).opacity),
      ).toBe("1");
    }
    await swipe(-24);
    expect((await counter.textContent())?.trim()).toBe("2 / 5");
    await swipe(-30, 120);
    expect((await counter.textContent())?.trim()).toBe("2 / 5");
    await swipe(-130, 0, true, true);
    expect((await counter.textContent())?.trim()).toBe("2 / 5");
    await swipe(-130, 0, true);
    await expect.poll(async () => (await counter.textContent())?.trim()).toBe("3 / 5");

    await lightbox.getByRole("button", { name: "Zoom in", exact: true }).click();
    await expect.poll(readScale).toBeGreaterThan(1);
    await swipe(-130);
    expect((await counter.textContent())?.trim()).toBe("3 / 5");
    await lightbox.getByRole("button", { name: "Reset zoom", exact: true }).click();
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
    await lightbox.getByRole("button", { name: "Reset zoom", exact: true }).click();
    await expect.poll(readScale).toBe(1);

    await page.evaluate(() => {
      document.documentElement.dir = "rtl";
    });
    const headerOverlaps = () =>
      lightbox.evaluate((element) => {
        const counterBounds = element
          .shadowRoot!.querySelector(".gallery-counter")!
          .getBoundingClientRect();
        const actions = element.shadowRoot!.querySelector(".actions")!.getBoundingClientRect();
        return (
          Math.min(counterBounds.right, actions.right) >
            Math.max(counterBounds.left, actions.left) &&
          Math.min(counterBounds.bottom, actions.bottom) > Math.max(counterBounds.top, actions.top)
        );
      });
    await expect.poll(headerOverlaps).toBe(false);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await swipe(130);
    await expect.poll(async () => (await counter.textContent())?.trim()).toBe("4 / 5");
    await page.keyboard.press("ArrowLeft");
    await expect.poll(async () => (await counter.textContent())?.trim()).toBe("5 / 5");
    await page.keyboard.press("ArrowLeft");
    expect((await counter.textContent())?.trim()).toBe("5 / 5");
    await page.keyboard.press("ArrowRight");
    await expect.poll(async () => (await counter.textContent())?.trim()).toBe("4 / 5");
    await swipe(-130);
    await expect.poll(async () => (await counter.textContent())?.trim()).toBe("3 / 5");
    await lightbox.getByRole("button", { name: "Close image preview", exact: true }).click();
    await expect.poll(() => lightbox.count()).toBe(0);
    await touch.detach();
  });
});
