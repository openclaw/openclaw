import { backgroundImageOpacityLimit } from "./session-background-opacity.ts";

/** Ignore preference-only refreshes; only the actual painted palette invalidates contrast. */
export function backgroundPaletteKey(element: HTMLElement): string {
  const style = getComputedStyle(element);
  return JSON.stringify([
    element.ownerDocument.documentElement.dataset.theme,
    ...["--bg-content", "--bg", "--text", "--text-strong", "--muted", "--chat-text"].map((token) =>
      style.getPropertyValue(token),
    ),
  ]);
}

/** Resolve palette CSS with the browser, including color-mix/oklch imported themes. */
export function readBackgroundOpacityLimit(element: HTMLElement): number {
  const canvas = element.ownerDocument.createElement("canvas");
  canvas.width = canvas.height = 1;
  const pixels = canvas.getContext("2d", { willReadFrequently: true });
  if (!pixels) {
    return 0;
  }
  const probe = element.ownerDocument.createElement("span");
  probe.style.cssText = "position:absolute;visibility:hidden;pointer-events:none";
  probe.style.backgroundColor = "var(--bg-content, var(--bg))";
  element.append(probe);
  try {
    const color = (value: string): number[] => {
      pixels.clearRect(0, 0, 1, 1);
      pixels.fillStyle = value;
      pixels.fillRect(0, 0, 1, 1);
      return [...pixels.getImageData(0, 0, 1, 1).data];
    };
    const surface = color(getComputedStyle(probe).backgroundColor);
    if (surface[3] !== 255) {
      return 0;
    }
    const foregrounds = [
      "var(--text)",
      "var(--text-strong)",
      "var(--muted)",
      "var(--chat-text, var(--text))",
    ].map((token) => {
      probe.style.color = token;
      return color(getComputedStyle(probe).color);
    });
    const theme = element.ownerDocument.documentElement.dataset.theme;
    const minimumContrast = theme === "beacon" || theme === "beacon-light" ? 7 : 4.5;
    return backgroundImageOpacityLimit(surface.slice(0, 3), foregrounds, minimumContrast);
  } finally {
    probe.remove();
  }
}
