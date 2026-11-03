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
  const hoverColor = hover ?? mix(color, 255, 0.18);
  const active = mix(color, 0, 0.12);
  return {
    normal: { background: color, foreground: controlUiAccentInk(color) },
    hover: { background: hoverColor, foreground: controlUiAccentInk(hoverColor) },
    active: { background: active, foreground: controlUiAccentInk(active) },
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
