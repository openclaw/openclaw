import type { Locator } from "playwright";
import { expect } from "vitest";
import { finishElementAnimations } from "../test-helpers/animations.ts";

export async function expectComposerSurface(composer: Locator, accessible = false) {
  const surface = await composer.evaluate((element, solidSurface) => {
    const style = getComputedStyle(element);
    const probe = document.createElement("div");
    element.appendChild(probe);
    probe.style.backgroundColor = solidSurface
      ? "var(--chat-composer-surface)"
      : "color-mix(in srgb, var(--chat-composer-surface) 78%, transparent)";
    const expected = getComputedStyle(probe).backgroundColor;
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
      expected,
    };
  }, accessible);
  expect(surface).toMatchObject({
    images: ["none", "none", "none"],
    background: surface.expected,
    filter: "none",
  });
}

export async function readArtwork(shell: Locator, artworkDetail?: "fingerprint" | "color-spread") {
  await shell.evaluate(finishElementAnimations);
  return shell.evaluate(async (element, detail) => {
    const style = getComputedStyle(element);
    const probe = document.createElement("div");
    probe.style.backgroundImage = "var(--app-background-image)";
    probe.style.backgroundColor = "var(--bg-content, var(--bg))";
    probe.style.color = "var(--muted)";
    element.appendChild(probe);
    const tokenImage = getComputedStyle(probe).backgroundImage;
    const canvasColor = getComputedStyle(probe).backgroundColor;
    const mutedColor = getComputedStyle(probe).color;
    probe.style.backgroundColor = "var(--bg)";
    const nativeCanvasColor = getComputedStyle(probe).backgroundColor;
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
    const data = pixels.getImageData(0, 0, canvas.width, canvas.height).data;
    // Compare decoded artwork without PNG encoding or transporting full images.
    const fingerprint =
      detail === "fingerprint"
        ? `${canvas.width}x${canvas.height}:${Array.from(
            new Uint8Array(await crypto.subtle.digest("SHA-256", data)),
            (byte) => byte.toString(16).padStart(2, "0"),
          ).join("")}`
        : null;
    let paintedPixels = 0;
    let maxColorSpread = 0;
    for (let offset = 0; offset < data.length; offset += 4) {
      const alpha = data[offset + 3]!;
      paintedPixels += alpha > 0 ? 1 : 0;
      // Ignore unpremultiplication noise in almost-transparent antialiasing.
      if (detail === "color-spread" && alpha >= 8) {
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
    let ancestorCount = 0;
    const opaqueAncestors: string[] = [];
    // SPA navigation retains hidden chat panes and their unsent drafts.
    const visible = (surface: HTMLElement) => surface.checkVisibility({ visibilityProperty: true });
    const composer = [...element.querySelectorAll<HTMLElement>(".agent-chat__input")].find(visible);
    const description = [...element.querySelectorAll<HTMLElement>(".settings-section__desc")].find(
      visible,
    );
    const transcript = [
      ...element.querySelectorAll<HTMLElement>(".chat-group.assistant .chat-text"),
    ].findLast(visible);
    const anchor = composer?.parentElement ?? description;
    if (!anchor) {
      throw new Error("Expected a real composer or Appearance description on the app canvas");
    }
    const nativeCanvas = anchor.closest<HTMLElement>(".sidebar-region--mobile-host");
    const nativeStyle = nativeCanvas ? getComputedStyle(nativeCanvas) : null;
    const nativeBounds = nativeCanvas?.getBoundingClientRect();
    for (const start of [anchor, transcript]) {
      for (
        let parent: Element | null | undefined = start;
        parent && parent !== element;
        parent = parent.parentElement
      ) {
        const parentStyle = getComputedStyle(parent);
        ancestorCount++;
        if (
          parent !== nativeCanvas &&
          (color(parentStyle.backgroundColor)[3] !== 0 ||
            parentStyle.backgroundImage !== "none" ||
            Number(parentStyle.opacity) !== 1)
        ) {
          opaqueAncestors.push(parent.className);
        }
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

    // The approved mobile pane owns an opaque reading canvas above the app
    // artwork. Contrast must include that surface before the composer fill.
    if (nativeStyle && nativeBounds) {
      pixels.fillStyle = nativeStyle.backgroundColor;
      pixels.fillRect(
        nativeBounds.x - bounds.x,
        nativeBounds.y - bounds.y,
        nativeBounds.width,
        nativeBounds.height,
      );
    }

    const linear = (channel: number) => {
      const value = channel / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    };
    const linearBytes = Float64Array.from({ length: 256 }, (_, channel) => linear(channel));
    const luminance = (red: number, green: number, blue: number) =>
      0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue);
    const minContrast = (rect: DOMRect, foreground: number[], artwork = true) => {
      const x = Math.max(0, Math.ceil(rect.x - bounds.x));
      const y = Math.max(0, Math.ceil(rect.y - bounds.y));
      const width = Math.min(Math.floor(rect.right - bounds.x), canvas.width) - x;
      const height = Math.min(Math.floor(rect.bottom - bounds.y), canvas.height) - y;
      if (width <= 0 || height <= 0) {
        throw new Error("Contrast must be measured on a visible reading surface");
      }
      const rgba = pixels.getImageData(x, y, width, height).data;
      const alpha = foreground[3]! / 255;
      const opaqueLuminance =
        alpha === 1 ? luminance(foreground[0]!, foreground[1]!, foreground[2]!) : null;
      let minimum = Infinity;
      for (let offset = 0; offset < rgba.length; offset += 4) {
        const red = rgba[offset]!;
        const green = rgba[offset + 1]!;
        const blue = rgba[offset + 2]!;
        if (artwork && (red !== baseColor[0] || green !== baseColor[1] || blue !== baseColor[2])) {
          visiblePaintedPixels += 1;
        }
        const bg =
          0.2126 * linearBytes[red]! + 0.7152 * linearBytes[green]! + 0.0722 * linearBytes[blue]!;
        const fg =
          opaqueLuminance ??
          luminance(
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
    const canvasContrast = minContrast(content.getBoundingClientRect(), canvasLabel);
    const transcriptContrast = transcriptColor
      ? minContrast(content.getBoundingClientRect(), transcriptColor)
      : null;
    let composerContrast: number | null = null;
    if (composer) {
      // Add the composer underlay behind the measured artwork, then its translucent fill.
      pixels.globalCompositeOperation = "destination-over";
      pixels.fillStyle = style.backgroundColor;
      pixels.fillRect(0, 0, canvas.width, canvas.height);
      pixels.globalCompositeOperation = "source-over";
      pixels.fillStyle = getComputedStyle(composer).backgroundColor;
      pixels.fillRect(0, 0, canvas.width, canvas.height);
      composerContrast = minContrast(composer.getBoundingClientRect(), composerLabel, false);
    }
    return {
      backgroundImage: style.backgroundImage,
      canvasOwner: nativeCanvas ? "native-mobile" : "shell-artwork",
      canvasContrast,
      composerContrast,
      maxColorSpread,
      pixels: fingerprint,
      transcriptContrast,
      failures: [
        ...Object.entries({
          imageToken: style.backgroundImage === tokenImage,
          canvasColor: style.backgroundColor === canvasColor,
          centered: style.backgroundPosition === "50% 50%",
          cover: style.backgroundSize === "cover",
          painted: paintedPixels > 0,
          visible: nativeBounds
            ? nativeBounds.width > 0 && nativeBounds.height > 0
            : visiblePaintedPixels > 0,
          nativeCanvas:
            !nativeStyle ||
            (nativeStyle.backgroundColor === nativeCanvasColor &&
              color(nativeStyle.backgroundColor)[3] === 255 &&
              nativeStyle.backgroundImage === "none" &&
              Number(nativeStyle.opacity) === 1),
          ancestors: ancestorCount > 0,
          sidebars: readingSurfaces.length > 0 && readingSurfaces.every((alpha) => alpha === 255),
        })
          .filter(([, valid]) => !valid)
          .map(([name]) => name),
        ...opaqueAncestors.map((name) => `opaque ancestor: ${name}`),
      ],
    };
  }, artworkDetail);
}

export function expectAppArtwork(artwork: Awaited<ReturnType<typeof readArtwork>>, label: string) {
  expect(artwork.failures, label).toEqual([]);
}

export async function expectMobileComposer(composer: Locator) {
  // Sample the final editor surface, after its focus-triggered height reveal.
  await composer.evaluate(finishElementAnimations);
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
        withinComposer: bounds.left >= rect.left && bounds.right <= rect.right,
        reachable: hit === control || (hit !== null && control.contains(hit)),
      };
    });
    return {
      controls,
      withinViewport: rect.left >= 0 && rect.right <= window.innerWidth,
      noOverflow:
        element.scrollWidth <= element.clientWidth &&
        document.body.scrollWidth <= window.innerWidth,
      viewportWidth: window.innerWidth,
    };
  });
  expect(layout).toEqual({
    viewportWidth: 390,
    withinViewport: true,
    noOverflow: true,
    controls: [
      { withinComposer: true, reachable: true },
      { withinComposer: true, reachable: true },
    ],
  });
}
