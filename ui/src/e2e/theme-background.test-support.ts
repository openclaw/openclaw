import type { Locator } from "playwright";
import { expect } from "vitest";
import { finishElementAnimations } from "../test-helpers/animations.ts";

export async function expectComposerSurface(composer: Locator) {
  const surface = await composer.evaluate((element) => {
    const style = getComputedStyle(element);
    const probe = document.createElement("div");
    element.appendChild(probe);
    probe.style.backgroundColor = "var(--chat-composer-surface)";
    const expected = getComputedStyle(probe).backgroundColor;
    probe.style.backgroundImage =
      "linear-gradient(var(--chat-composer-surface), var(--chat-composer-surface))";
    const expectedImage = getComputedStyle(probe).backgroundImage;
    probe.remove();
    return {
      opaqueFill:
        (style.backgroundColor === expected && style.backgroundImage === "none") ||
        style.backgroundImage.replace(/(?:, none)+$/u, "") === expectedImage,
      opacity: style.opacity,
      images: ["::before", "::after"].map(
        (pseudo) => getComputedStyle(element, pseudo).backgroundImage,
      ),
      filter: style.backdropFilter || style.getPropertyValue("-webkit-backdrop-filter"),
    };
  });
  expect(surface).toMatchObject({
    opaqueFill: true,
    opacity: "1",
    images: ["none", "none"],
    filter: "none",
  });
}

export async function readPlainCanvas(shell: Locator) {
  await shell.evaluate(finishElementAnimations);
  return shell.evaluate((element) => {
    const shellStyle = getComputedStyle(element);
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const pixels = canvas.getContext("2d", { willReadFrequently: true })!;
    const color = (value: string) => {
      if (value.startsWith("color(srgb ")) {
        const channels = value.slice(11, -1).split(/[ /]+/u).map(Number);
        return [...channels.slice(0, 3).map((channel) => channel * 255), channels[3] ?? 1];
      }
      pixels.clearRect(0, 0, 1, 1);
      pixels.fillStyle = value;
      pixels.fillRect(0, 0, 1, 1);
      const [red, green, blue, alpha] = pixels.getImageData(0, 0, 1, 1).data;
      return [red!, green!, blue!, alpha! / 255];
    };
    const over = (foreground: number[], background: number[]) =>
      foreground
        .slice(0, 3)
        .map((channel, i) => channel * foreground[3]! + background[i]! * (1 - foreground[3]!));
    const luminance = (rgb: number[]) =>
      rgb.slice(0, 3).reduce((sum, value, i) => {
        const channel = value / 255;
        const linear = channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
        return sum + linear * [0.2126, 0.7152, 0.0722][i]!;
      }, 0);
    const contrast = (foreground: number[], background: number[]) => {
      const fg = luminance(over(foreground, background));
      const bg = luminance(background);
      return (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
    };
    const visible = (target: Element) => target.checkVisibility({ visibilityProperty: true });
    const findVisible = (selector: string) => [...element.querySelectorAll(selector)].find(visible);
    const composer = findVisible(".agent-chat__input");
    const description = findVisible(".settings-section__desc");
    const transcript = findVisible(".chat-group.assistant .chat-text");
    const anchor = composer ?? description;
    if (!anchor) {
      throw new Error("Expected a real composer or Appearance description on the app canvas");
    }
    const probe = document.createElement("div");
    probe.style.color = "var(--muted)";
    probe.style.backgroundColor = "var(--chat-composer-surface)";
    anchor.appendChild(probe);
    const muted = color(getComputedStyle(probe).color);
    const composerFill = color(getComputedStyle(probe).backgroundColor);
    probe.remove();
    const nativeCanvas = anchor.closest(".sidebar-region--mobile-host");
    const nativeStyle = nativeCanvas ? getComputedStyle(nativeCanvas) : null;
    const background = color(nativeStyle?.backgroundColor ?? shellStyle.backgroundColor);
    const placeholder = composer?.querySelector(".agent-chat__composer-placeholder");
    const textarea = composer?.querySelector("textarea");
    const label = placeholder
      ? getComputedStyle(placeholder)
      : textarea
        ? getComputedStyle(textarea, "::placeholder")
        : null;
    const labelColor = label ? color(label.color) : muted;
    labelColor[3] = labelColor[3]! * Number(label?.opacity ?? 1);
    return {
      backgroundImage: shellStyle.backgroundImage,
      paintedPanes: [
        ...element.querySelectorAll("openclaw-session-background[data-painted]"),
      ].filter(visible).length,
      canvasOwner: nativeCanvas ? "native-mobile" : "shell",
      nativeImage: nativeStyle?.backgroundImage ?? "none",
      opaqueCanvas: background[3] === 1,
      canvasContrast: contrast(
        description ? color(getComputedStyle(description).color) : muted,
        background,
      ),
      composerContrast: composer ? contrast(labelColor, over(composerFill, background)) : null,
      transcriptContrast: transcript
        ? contrast(color(getComputedStyle(transcript).color), background)
        : null,
    };
  });
}

export async function readBundledArtwork(layer: Locator) {
  return layer.evaluate(async (element) => {
    const backgroundImage = getComputedStyle(element).backgroundImage;
    const match = /^url\(["']?(.*?)["']?\)$/u.exec(backgroundImage);
    if (!match?.[1]) {
      throw new Error(`Expected one bundled app image, received ${backgroundImage}`);
    }
    const url = new URL(match[1], document.baseURI);
    if (url.origin !== location.origin || !url.pathname.endsWith(".webp")) {
      throw new Error(`App artwork must be a bundled WebP, received ${url.href}`);
    }
    const image = new Image();
    image.src = url.href;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const pixels = canvas.getContext("2d", { willReadFrequently: true })!;
    pixels.drawImage(image, 0, 0);
    const data = pixels.getImageData(0, 0, canvas.width, canvas.height).data;
    let maxColorSpread = 0;
    for (let offset = 0; offset < data.length; offset += 4) {
      if (data[offset + 3]! >= 8) {
        const channels = [data[offset]!, data[offset + 1]!, data[offset + 2]!];
        maxColorSpread = Math.max(maxColorSpread, Math.max(...channels) - Math.min(...channels));
      }
    }
    return { backgroundImage, maxColorSpread };
  });
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
      throw new Error("Expected the composer to retain its input and primary action");
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
    };
  });
  expect(layout).toEqual({
    withinViewport: true,
    noOverflow: true,
    controls: [
      { withinComposer: true, reachable: true },
      { withinComposer: true, reachable: true },
    ],
  });
}
