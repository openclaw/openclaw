import type { Locator } from "playwright";
import { expect } from "vitest";
import { finishElementAnimations } from "../test-helpers/animations.ts";

export async function expectComposerSurface(composer: Locator, accessible = false) {
  const surface = await composer.evaluate((element) => {
    const style = getComputedStyle(element);
    const probe = document.createElement("div");
    element.appendChild(probe);
    probe.style.backgroundColor = "var(--chat-composer-surface)";
    const solid = getComputedStyle(probe).backgroundColor;
    probe.style.backgroundColor =
      "color-mix(in srgb, var(--chat-composer-surface) 78%, transparent)";
    const translucent = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return {
      background: style.backgroundColor,
      images: [
        style.backgroundImage,
        ...["::before", "::after"].map(
          (pseudo) => getComputedStyle(element, pseudo).backgroundImage,
        ),
      ],
      filter: style.backdropFilter || style.getPropertyValue("-webkit-backdrop-filter"),
      solid,
      translucent,
    };
  });
  expect(surface).toMatchObject({
    images: ["none", "none", "none"],
    background: accessible ? surface.solid : surface.translucent,
    filter: "none",
  });
}

export async function readArtwork(shell: Locator) {
  await shell.evaluate(finishElementAnimations);
  return shell.evaluate(async (element) => {
    const style = getComputedStyle(element);
    const probe = document.createElement("div");
    probe.style.backgroundImage = "var(--app-background-image)";
    probe.style.backgroundColor = "var(--bg-content, var(--bg))";
    probe.style.color = "var(--muted)";
    element.appendChild(probe);
    const tokenImage = getComputedStyle(probe).backgroundImage;
    const canvasColor = getComputedStyle(probe).backgroundColor;
    const mutedColor = getComputedStyle(probe).color;
    probe.remove();

    const match = /^url\(["']?(.*?)["']?\)$/u.exec(style.backgroundImage);
    if (!match?.[1]) {
      throw new Error(`Expected one bundled app image, received ${style.backgroundImage}`);
    }
    const url = new URL(match[1], document.baseURI);
    if (url.origin !== location.origin || !url.pathname.endsWith(".webp")) {
      throw new Error(`App artwork must be a bundled WebP, received ${url.href}`);
    }
    const response = await fetch(url);
    if (!response.ok || response.headers.get("content-type")?.split(";")[0] !== "image/webp") {
      throw new Error(`Cannot load bundled WebP artwork: ${response.status}`);
    }
    const image = new Image();
    image.src = url.href;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const pixels = canvas.getContext("2d", { willReadFrequently: true });
    if (!pixels) {
      throw new Error("Cannot inspect decoded app artwork");
    }
    pixels.drawImage(image, 0, 0);
    const fingerprint = canvas.toDataURL();
    const data = pixels.getImageData(0, 0, canvas.width, canvas.height).data;
    let paintedPixels = 0;
    let maxColorSpread = 0;
    for (let offset = 0; offset < data.length; offset += 4) {
      const alpha = data[offset + 3]!;
      paintedPixels += alpha > 0 ? 1 : 0;
      // Ignore unpremultiplication noise in almost-transparent antialiasing.
      if (alpha >= 8) {
        const channels = [data[offset]!, data[offset + 1]!, data[offset + 2]!];
        maxColorSpread = Math.max(maxColorSpread, Math.max(...channels) - Math.min(...channels));
      }
    }
    // Canvas normalizes modern CSS colors to sRGB without discarding alpha.
    const color = (value: string) => {
      pixels.clearRect(0, 0, 1, 1);
      pixels.fillStyle = value;
      pixels.fillRect(0, 0, 1, 1);
      return [...pixels.getImageData(0, 0, 1, 1).data];
    };
    const transparentAncestors: Array<{
      className: string;
      alpha: number;
      image: string;
      opacity: number;
    }> = [];
    const composer = element.querySelector<HTMLElement>(".agent-chat__input");
    const description = element.querySelector<HTMLElement>(".settings-section__desc");
    const transcript = [
      ...element.querySelectorAll<HTMLElement>(".chat-group.assistant .chat-text"),
    ].at(-1);
    const anchor = composer?.parentElement ?? description;
    if (!anchor) {
      throw new Error("Expected a real composer or Appearance description on the app canvas");
    }
    for (const start of [anchor, transcript]) {
      for (
        let parent: Element | null | undefined = start;
        parent && parent !== element;
        parent = parent.parentElement
      ) {
        const parentStyle = getComputedStyle(parent);
        transparentAncestors.push({
          className: parent.className,
          alpha: color(parentStyle.backgroundColor)[3]!,
          image: parentStyle.backgroundImage,
          opacity: Number(parentStyle.opacity),
        });
      }
    }
    const readingSurfaces = [...element.querySelectorAll(".sidebar, .settings-sidebar")].map(
      (surface) => color(getComputedStyle(surface).backgroundColor)[3],
    );
    const canvasLabel = color(description ? getComputedStyle(description).color : mutedColor);
    const transcriptColor = transcript ? color(getComputedStyle(transcript).color) : null;
    // Measure the visible ellipsized hint, not its transparent native placeholder.
    const placeholder = composer?.querySelector(".agent-chat__composer-placeholder");
    const textarea = composer?.querySelector("textarea");
    const placeholderStyle = placeholder
      ? getComputedStyle(placeholder)
      : textarea
        ? getComputedStyle(textarea, "::placeholder")
        : null;
    const composerLabel = color(placeholderStyle?.color ?? mutedColor);
    composerLabel[3] = composerLabel[3]! * Number(placeholderStyle?.opacity ?? 1);
    const baseColor = color(canvasColor);
    let visiblePaintedPixels = 0;
    const bounds = element.getBoundingClientRect();
    canvas.width = Math.ceil(bounds.width);
    canvas.height = Math.ceil(bounds.height);
    pixels.fillStyle = style.backgroundColor;
    pixels.fillRect(0, 0, canvas.width, canvas.height);
    const scale = Math.max(canvas.width / image.naturalWidth, canvas.height / image.naturalHeight);
    pixels.drawImage(
      image,
      (canvas.width - image.naturalWidth * scale) / 2,
      (canvas.height - image.naturalHeight * scale) / 2,
      image.naturalWidth * scale,
      image.naturalHeight * scale,
    );

    const luminance = (red: number, green: number, blue: number) => {
      const linear = (channel: number) => {
        const value = channel / 255;
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue);
    };
    const minContrast = (
      context: CanvasRenderingContext2D,
      rect: DOMRect,
      foreground: number[],
    ) => {
      const x = Math.max(0, Math.ceil(rect.x - bounds.x));
      const y = Math.max(0, Math.ceil(rect.y - bounds.y));
      const width = Math.min(Math.floor(rect.right - bounds.x), canvas.width) - x;
      const height = Math.min(Math.floor(rect.bottom - bounds.y), canvas.height) - y;
      if (width <= 0 || height <= 0) {
        throw new Error("Contrast must be measured on a visible reading surface");
      }
      const rgba = context.getImageData(x, y, width, height).data;
      const alpha = foreground[3]! / 255;
      let minimum = Infinity;
      for (let offset = 0; offset < rgba.length; offset += 4) {
        const red = rgba[offset]!;
        const green = rgba[offset + 1]!;
        const blue = rgba[offset + 2]!;
        if (
          context === pixels &&
          (red !== baseColor[0] || green !== baseColor[1] || blue !== baseColor[2])
        ) {
          visiblePaintedPixels += 1;
        }
        const bg = luminance(red, green, blue);
        const fg = luminance(
          foreground[0]! * alpha + red * (1 - alpha),
          foreground[1]! * alpha + green * (1 - alpha),
          foreground[2]! * alpha + blue * (1 - alpha),
        );
        minimum = Math.min(minimum, (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05));
      }
      return minimum;
    };
    const content = element.querySelector(".content");
    if (!content) {
      throw new Error("Expected the app content to expose the shell canvas");
    }
    const canvasContrast = minContrast(pixels, content.getBoundingClientRect(), canvasLabel);
    const transcriptContrast = transcriptColor
      ? minContrast(pixels, content.getBoundingClientRect(), transcriptColor)
      : null;
    let composerContrast: number | null = null;
    if (composer) {
      const translucent = document.createElement("canvas");
      translucent.width = canvas.width;
      translucent.height = canvas.height;
      const context = translucent.getContext("2d");
      if (!context) {
        throw new Error("Cannot measure the translucent composer");
      }
      const composerStyle = getComputedStyle(composer);
      context.fillStyle = style.backgroundColor;
      context.fillRect(0, 0, translucent.width, translucent.height);
      context.drawImage(canvas, 0, 0);
      context.fillStyle = composerStyle.backgroundColor;
      context.fillRect(0, 0, translucent.width, translucent.height);
      composerContrast = minContrast(context, composer.getBoundingClientRect(), composerLabel);
    }
    return {
      backgroundColor: style.backgroundColor,
      backgroundImage: style.backgroundImage,
      backgroundPosition: style.backgroundPosition,
      backgroundSize: style.backgroundSize,
      canvasColor,
      canvasContrast,
      composerContrast,
      maxColorSpread,
      paintedPixels,
      pixels: fingerprint,
      readingSurfaces,
      tokenImage,
      transparentAncestors,
      transcriptContrast,
      visiblePaintedPixels,
    };
  });
}

export function expectAppArtwork(artwork: Awaited<ReturnType<typeof readArtwork>>, label: string) {
  expect(artwork, label).toMatchObject({
    backgroundImage: artwork.tokenImage,
    backgroundColor: artwork.canvasColor,
    backgroundPosition: "50% 50%",
    backgroundSize: "cover",
  });
  for (const count of [
    artwork.paintedPixels,
    artwork.visiblePaintedPixels,
    artwork.transparentAncestors.length,
    artwork.readingSurfaces.length,
  ]) {
    expect(count, label).toBeGreaterThan(0);
  }
  for (const ancestor of artwork.transparentAncestors) {
    expect(ancestor, `${label}: ${ancestor.className} hides the canvas`).toMatchObject({
      alpha: 0,
      image: "none",
      opacity: 1,
    });
  }
  expect(
    artwork.readingSurfaces.every((alpha) => alpha === 255),
    label,
  ).toBe(true);
}

export async function expectMobileComposer(composer: Locator) {
  const layout = await composer.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const textarea = element.querySelector("textarea");
    // Chat keeps a hidden desktop action beside the mobile primary action.
    const action = [
      ...element.querySelectorAll<HTMLButtonElement>(
        ".chat-send-btn--send, .new-session-page__start-submit",
      ),
    ].find((button) => button.getClientRects().length > 0);
    if (!textarea || !action) {
      throw new Error("Expected the translucent composer to retain its input and primary action");
    }
    const controls = [textarea, action].map((control) => {
      const bounds = control.getBoundingClientRect();
      const hit = document.elementFromPoint(
        bounds.x + bounds.width / 2,
        bounds.y + bounds.height / 2,
      );
      return {
        left: bounds.left,
        right: bounds.right,
        reachable: hit === control || (hit !== null && control.contains(hit)),
      };
    });
    return {
      bodyWidth: document.body.scrollWidth,
      clientWidth: element.clientWidth,
      controls,
      left: rect.left,
      right: rect.right,
      scrollWidth: element.scrollWidth,
      viewportWidth: window.innerWidth,
    };
  });
  expect(layout.viewportWidth).toBe(390);
  expect(layout.left).toBeGreaterThanOrEqual(0);
  expect(layout.right).toBeLessThanOrEqual(layout.viewportWidth);
  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth);
  expect(layout.bodyWidth).toBeLessThanOrEqual(layout.viewportWidth);
  for (const control of layout.controls) {
    expect(control.left).toBeGreaterThanOrEqual(layout.left);
    expect(control.right).toBeLessThanOrEqual(layout.right);
    expect(control.reachable).toBe(true);
  }
}
