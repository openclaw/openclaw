import photon from "@silvia-odwyer/photon-node";
import type { Locator, Page } from "playwright";
import { expect } from "vitest";

export async function waitForControlUiProofSurface(
  surface: Locator,
  content: readonly Locator[],
): Promise<void> {
  // Lazy hosts can have boxes before their meaningful children have loaded.
  await Promise.all(content.map((locator) => locator.waitFor()));
  // Preserve Playwright screenshot preparation: late fonts change glyphs and boxes.
  await surface.evaluate(async (element) => {
    await element.ownerDocument.fonts.ready;
  });
  // Ancestor transforms affect captured pixels even when the surface has no animation.
  // Settle that presentation chain, including shadow hosts, without waiting on descendants.
  await expect
    .poll(() =>
      surface.evaluate((element) => {
        if (
          !element.checkVisibility({ checkOpacity: true }) ||
          getComputedStyle(element).opacity !== "1"
        ) {
          return false;
        }
        for (let owner: Element | null = element; owner;) {
          if (
            owner
              .getAnimations()
              .some(
                (animation) =>
                  Number.isFinite(animation.effect?.getComputedTiming().endTime) &&
                  animation.playState !== "finished",
              )
          ) {
            return false;
          }
          const root = owner.getRootNode();
          owner = owner.parentElement ?? (root instanceof ShadowRoot ? root.host : null);
        }
        return true;
      }),
    )
    .toBe(true);
}

export async function takeControlUiViewportScreenshot(
  page: Page,
  surface: Locator,
  content: readonly Locator[],
): Promise<Buffer> {
  await waitForControlUiProofSurface(surface, content);
  return captureControlUiViewport(page);
}

async function captureControlUiViewport(page: Page): Promise<Buffer> {
  // CDP repaints the current viewport but does not settle semantic presentation.
  // Keep capture independent of unrelated dashboard RPCs and descendant motion.
  const session = await page.context().newCDPSession(page);
  try {
    const result = await session.send("Page.captureScreenshot", {
      captureBeyondViewport: false,
      format: "png",
      fromSurface: true,
    });
    return Buffer.from(result.data, "base64");
  } finally {
    await session.detach();
  }
}

export async function takeControlUiElementScreenshot(
  page: Page,
  surface: Locator,
  content: readonly Locator[],
): Promise<Buffer> {
  await waitForControlUiProofSurface(surface, content);
  // Playwright's scroll waits for stable geometry without changing the hover target.
  await surface.scrollIntoViewIfNeeded();
  const frame = await captureControlUiFrame(page, [surface]);
  return frame.elements[0]!.png;
}

type ScreenshotFrameOptions = {
  elements?: readonly Locator[];
  viewport?: { width: number; height: number };
  scrollTo?: Locator;
  animations?: "disabled";
  animationFrameBeforeCapture?: boolean;
  fullPage?: boolean;
};

export async function takeControlUiScreenshotFrame(
  page: Page,
  surface: Locator,
  content: readonly Locator[],
  options: ScreenshotFrameOptions = {},
) {
  if (options.viewport) {
    await page.setViewportSize(options.viewport);
  }
  await Promise.all(content.map((target) => target.waitFor({ state: "attached" })));
  const preparation = await createControlUiFramePreparation(
    page,
    options.animations === "disabled",
  );
  try {
    await expect
      .poll(async () => {
        await preparation.evaluate((state) => state.prepare());
        return (await Promise.all(content.map((target) => target.isVisible()))).every(Boolean);
      })
      .toBe(true);
    await waitForControlUiProofSurface(surface, content);
    const targets = [
      ...new Set([
        surface,
        ...content,
        ...(options.elements ?? []),
        ...(options.scrollTo ? [options.scrollTo] : []),
      ]),
    ];
    let previous: string | undefined;
    let requestedScroll: string | null | undefined;
    await expect
      .poll(
        async () => {
          await preparation.evaluate((state) => state.prepare());
          await waitForControlUiFrameLayout(targets);
          await preparation.evaluate((state) => state.freezeTransitions());
          if (options.scrollTo) {
            requestedScroll = await inspectControlUiProofScroll(options.scrollTo, true);
            await waitForControlUiFrameLayout(targets);
          }
          await page.evaluate(() => document.fonts.ready.then(() => undefined));
          await preparation.evaluate((state) => state.decodeImages());
          await preparation.evaluate((state) => state.prepare());
          await waitForControlUiFrameLayout(targets);
          const images = await preparation.evaluate((state) => state.images());
          const presentation = await inspectControlUiFrameTargets(targets);
          const scroll = options.scrollTo
            ? await inspectControlUiProofScroll(options.scrollTo, false)
            : undefined;
          const current = JSON.stringify({ images, presentation, scroll });
          const stable = current === previous;
          previous = current;
          // A recenter can expose another lazy image; repeat readiness, never captures.
          return (
            stable &&
            requestedScroll !== null &&
            scroll === requestedScroll &&
            presentation.every((target) => target.visible) &&
            images.every((image) => image.decoded)
          );
        },
        { message: "Proof frame did not reach visible, settled targets" },
      )
      .toBe(true);
    const settled = await inspectControlUiFrameTargets(targets);
    expect(
      settled.every((target) => target.visible),
      "Proof content must remain visible",
    ).toBe(true);
    if (options.scrollTo) {
      expect(await inspectControlUiProofScroll(options.scrollTo, false)).toBe(requestedScroll);
    }
    if (options.animationFrameBeforeCapture) {
      await page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            requestAnimationFrame(() => resolve());
          }),
      );
    }
    const frame = await captureControlUiFrame(page, options.elements ?? [], options);
    expect(
      await inspectControlUiFrameTargets(targets),
      "Proof content moved or disappeared during frame capture",
    ).toEqual(settled);
    if (options.scrollTo) {
      expect(await inspectControlUiProofScroll(options.scrollTo, false)).toBe(requestedScroll);
    }
    return frame;
  } finally {
    try {
      if (!page.isClosed()) {
        await preparation.evaluate((state) => state.restore());
      }
    } finally {
      await preparation.dispose();
    }
  }
}

async function inspectControlUiFrameTargets(targets: readonly Locator[]) {
  return Promise.all(
    targets.map(async (target) => {
      const intersects = await target.evaluate(
        (element) =>
          new Promise<boolean>((resolve) => {
            const observer = new IntersectionObserver(([entry]) => {
              observer.disconnect();
              resolve(
                Boolean(
                  entry && entry.intersectionRect.width > 0 && entry.intersectionRect.height > 0,
                ),
              );
            });
            observer.observe(element);
          }),
      );
      const bounds = await target.boundingBox();
      const visible =
        intersects &&
        bounds !== null &&
        bounds.width > 0 &&
        bounds.height > 0 &&
        (await target.evaluate((element) =>
          element.checkVisibility({ checkOpacity: true, visibilityProperty: true }),
        ));
      return { bounds, visible };
    }),
  );
}

async function createControlUiFramePreparation(page: Page, disableAnimations: boolean) {
  return page.evaluateHandle((staticFrame) => {
    const roots = () => {
      const result: Array<Document | ShadowRoot> = [document];
      for (const root of result) {
        for (const element of root.querySelectorAll("*")) {
          if (element.shadowRoot) {
            result.push(element.shadowRoot);
          }
        }
      }
      return result;
    };
    const resumed = new Set<Animation>();
    const transitionStyles = new Map<Document | ShadowRoot, HTMLStyleElement>();
    const listeners = new Map<Document | ShadowRoot, () => void>();
    const carets = new Map<HTMLElement, { value: string; priority: string }>();
    const decoded = new Map<HTMLImageElement, string>();
    const visibleImages = () =>
      roots()
        .flatMap((root) => Array.from(root.querySelectorAll("img")))
        .filter((image) => {
          const rect = image.getBoundingClientRect();
          return (
            image.isConnected &&
            image.checkVisibility() &&
            rect.right > 0 &&
            rect.bottom > 0 &&
            rect.left < innerWidth &&
            rect.top < innerHeight &&
            Boolean(image.currentSrc || image.src)
          );
        });
    return {
      prepare() {
        if (!staticFrame) {
          return;
        }
        for (const root of roots()) {
          const settle = () => {
            for (const animation of root.getAnimations()) {
              if (
                !animation.effect ||
                animation.playbackRate === 0 ||
                resumed.has(animation) ||
                animation.playState === "finished"
              ) {
                continue;
              }
              if (Number.isFinite(animation.effect.getComputedTiming().endTime)) {
                animation.finish();
              } else {
                animation.cancel();
                resumed.add(animation);
              }
            }
          };
          if (!listeners.has(root)) {
            root.addEventListener("animationstart", settle);
            root.addEventListener("transitionrun", settle);
            listeners.set(root, settle);
          }
          settle();
          for (const element of root.querySelectorAll("input,textarea,[contenteditable]")) {
            if (element instanceof HTMLElement && !carets.has(element)) {
              carets.set(element, {
                value: element.style.getPropertyValue("caret-color"),
                priority: element.style.getPropertyPriority("caret-color"),
              });
              element.style.setProperty("caret-color", "transparent", "important");
            }
          }
        }
      },
      freezeTransitions() {
        if (!staticFrame) {
          return;
        }
        // Finite effects and their completion handlers settle before removing the
        // transition layers, which can otherwise retain fractional shadow paints.
        for (const root of roots()) {
          if (transitionStyles.has(root)) {
            continue;
          }
          const style = document.createElement("style");
          style.textContent = "*, *::before, *::after { transition: none !important; }";
          (root instanceof Document ? root.head : root).append(style);
          transitionStyles.set(root, style);
        }
      },
      async decodeImages() {
        await Promise.all(
          visibleImages().map(async (image) => {
            const source = image.currentSrc || image.src;
            try {
              await image.decode();
            } catch (error) {
              if (source !== (image.currentSrc || image.src) || !image.isConnected) {
                return;
              }
              // A completed broken image is also a settled, visible UI state.
              if (!image.complete || image.naturalWidth !== 0) {
                throw error;
              }
            }
            if (source === (image.currentSrc || image.src)) {
              decoded.set(image, source);
            }
          }),
        );
      },
      images() {
        return visibleImages().map((image) => {
          const source = image.currentSrc || image.src;
          const rect = image.getBoundingClientRect();
          return {
            source,
            decoded: decoded.get(image) === source,
            width: image.naturalWidth,
            height: image.naturalHeight,
            bounds: [rect.x, rect.y, rect.width, rect.height],
          };
        });
      },
      restore() {
        for (const style of transitionStyles.values()) {
          style.remove();
        }
        for (const [root, listener] of listeners) {
          root.removeEventListener("animationstart", listener);
          root.removeEventListener("transitionrun", listener);
        }
        for (const [element, caret] of carets) {
          element.style.setProperty("caret-color", caret.value, caret.priority);
        }
        for (const animation of resumed) {
          animation.play();
        }
      },
    };
  }, disableAnimations);
}

async function inspectControlUiProofScroll(target: Locator, shouldCenter: boolean) {
  return target.evaluate((element, center) => {
    if (!element.isConnected) {
      return null;
    }
    if (center) {
      // Record achieved centering in the same task: a later reset must not become readiness.
      element.scrollIntoView({ behavior: "instant", block: "center", inline: "center" });
    }
    const geometry: number[][] = [];
    for (let owner: Element | null = element; owner;) {
      const rect = owner.getBoundingClientRect();
      geometry.push([rect.x, rect.y, rect.width, rect.height, owner.scrollLeft, owner.scrollTop]);
      const root = owner.getRootNode();
      owner = owner.parentElement ?? (root instanceof ShadowRoot ? root.host : null);
    }
    return JSON.stringify(geometry);
  }, shouldCenter);
}

async function waitForControlUiFrameLayout(targets: readonly Locator[]): Promise<void> {
  await expect
    .poll(async () => {
      const ready = await Promise.all(
        targets.map((target) =>
          target.evaluate(async (element) => {
            let previous: Array<[Element, ...number[]]> = [];
            let stableFrames = 0;
            for (let frame = 0; frame < 60; frame += 1) {
              await new Promise<void>((resolve) => {
                // Layout delivery continues when a fixture pauses its application clock.
                const observer = new IntersectionObserver(() => {
                  observer.disconnect();
                  resolve();
                });
                observer.observe(element);
              });
              if (!element.isConnected) {
                return false;
              }
              const geometry: typeof previous = [];
              for (let owner: Element | null = element; owner;) {
                const rect = owner.getBoundingClientRect();
                geometry.push([
                  owner,
                  rect.x,
                  rect.y,
                  rect.width,
                  rect.height,
                  owner.scrollLeft,
                  owner.scrollTop,
                ]);
                const root = owner.getRootNode();
                owner = owner.parentElement ?? (root instanceof ShadowRoot ? root.host : null);
              }
              const unchanged =
                geometry.length === previous.length &&
                geometry.every((row, index) =>
                  row.every((value, column) => value === previous[index]![column]),
                );
              stableFrames = unchanged ? stableFrames + 1 : 0;
              if (stableFrames >= 3) {
                return true;
              }
              previous = geometry;
            }
            throw new Error("Proof layout did not settle within 60 layout updates");
          }),
        ),
      );
      return ready.every(Boolean);
    })
    .toBe(true);
}

async function captureControlUiFrame(
  page: Page,
  elements: readonly Locator[],
  options: Pick<ScreenshotFrameOptions, "fullPage"> = {},
) {
  const viewport = page.viewportSize();
  if (!viewport) {
    throw new Error("Proof capture requires a viewport");
  }
  if (options.fullPage) {
    const extent = await page.evaluate(() => ({
      width: Math.max(
        document.body.scrollWidth,
        document.body.offsetWidth,
        document.documentElement.clientWidth,
        document.documentElement.scrollWidth,
        document.documentElement.offsetWidth,
      ),
      height: Math.max(
        document.body.scrollHeight,
        document.body.offsetHeight,
        document.documentElement.clientHeight,
        document.documentElement.scrollHeight,
        document.documentElement.offsetHeight,
      ),
    }));
    expect(extent, "Full-page proof must fit the viewport-frame dimensions").toEqual(viewport);
  }
  const bounds = await Promise.all(elements.map((element) => element.boundingBox()));
  const rectangles = bounds.map((rect) => {
    if (
      !rect ||
      rect.width <= 0 ||
      rect.height <= 0 ||
      rect.x < 0 ||
      rect.y < 0 ||
      rect.x + rect.width > viewport.width ||
      rect.y + rect.height > viewport.height
    ) {
      throw new Error(
        `Proof surface is not contained by the viewport: ${JSON.stringify({ bounds: rect, viewport })}`,
      );
    }
    return rect;
  });
  // Keep the prepared presentation in place while taking one unclipped frame.
  const png = await captureControlUiViewport(page);
  expect(
    await Promise.all(elements.map((element) => element.boundingBox())),
    "Proof surfaces moved during frame capture",
  ).toEqual(rectangles);
  const image = photon.PhotonImage.new_from_byteslice(png);
  try {
    // Backing dimensions can round independently at fractional device scales.
    const scaleX = image.get_width() / viewport.width;
    const scaleY = image.get_height() / viewport.height;
    expect(scaleX, "Proof frame horizontal scale").toBeGreaterThan(0);
    expect(scaleY, "Proof frame vertical scale").toBeGreaterThan(0);
    return {
      png,
      elements: rectangles.map((rect) => {
        const x = Math.floor(rect.x * scaleX);
        const y = Math.floor(rect.y * scaleY);
        const right = Math.ceil((rect.x + rect.width) * scaleX);
        const bottom = Math.ceil((rect.y + rect.height) * scaleY);
        const crop = photon.crop(image, x, y, right, bottom);
        try {
          expect([crop.get_width(), crop.get_height()]).toEqual([right - x, bottom - y]);
          return {
            png: Buffer.from(crop.get_bytes()),
            bounds: rect,
            pixelBounds: { x, y, width: right - x, height: bottom - y },
          };
        } finally {
          crop.free();
        }
      }),
    };
  } finally {
    image.free();
  }
}
