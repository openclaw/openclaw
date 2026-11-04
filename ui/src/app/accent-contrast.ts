function luminance(color: string): number {
  const linearChannel = (offset: number) => {
    const channel = Number.parseInt(color.slice(offset, offset + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linearChannel(1) + 0.7152 * linearChannel(3) + 0.0722 * linearChannel(5);
}

export function controlUiAccentInk(accent: string): "#000000" | "#ffffff" {
  if (!/^#[0-9a-f]{6}$/i.test(accent)) {
    return "#ffffff";
  }
  // Black and white reach equal WCAG contrast at relative luminance 0.179.
  return luminance(accent) > 0.179 ? "#000000" : "#ffffff";
}

function mix(color: string, target: number, amount: number): string {
  return `#${[1, 3, 5]
    .map((offset) =>
      Math.round(
        Number.parseInt(color.slice(offset, offset + 2), 16) * (1 - amount) + target * amount,
      )
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

export function controlUiAccentStates(color: string, hover?: string) {
  const foreground = controlUiAccentInk(color);
  const pair = (preferred: string, amount: number) => {
    // Change the fill direction before changing ink, so interaction does not flash the glyph.
    const alternative = mix(color, foreground === "#ffffff" ? 0 : 255, amount);
    const background = [preferred, alternative].find((candidate) => {
      const values = [luminance(candidate), luminance(foreground)].toSorted((a, b) => b - a);
      return (values[0]! + 0.05) / (values[1]! + 0.05) >= 4.5;
    });
    return {
      background: background ?? preferred,
      foreground: background ? foreground : controlUiAccentInk(preferred),
    };
  };
  return {
    normal: { background: color, foreground },
    hover: pair(hover ?? mix(color, 255, 0.18), 0.18),
    active: pair(mix(color, 0, 0.12), 0.12),
  };
}

export function controlUiAccentFocus(color: string, surfaces: readonly string[]): string {
  const contrast = (candidate: string) =>
    Math.min(
      ...surfaces.map((surface) => {
        const values = [luminance(candidate), luminance(surface)].toSorted((a, b) => b - a);
        return (values[0]! + 0.05) / (values[1]! + 0.05);
      }),
    );
  // Keep the hue only when it remains visible on every surface carrying controls.
  if (contrast(color) >= 3) {
    return color;
  }
  return contrast("#000000") > contrast("#ffffff") ? "#000000" : "#ffffff";
}
