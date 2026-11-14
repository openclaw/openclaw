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

export function controlUiAccentStates(
  color: string,
  hover?: string,
  foreground: string = controlUiAccentInk(color),
) {
  const inkLuminance = luminance(foreground);
  const contrast = (background: string) => {
    const fill = luminance(background);
    return (Math.max(fill, inkLuminance) + 0.05) / (Math.min(fill, inkLuminance) + 0.05);
  };
  const pair = (preferred: string, amount: number) => {
    let background = preferred;
    // Preserve authored ink too; deepen the fill only as far as readability requires.
    const target = inkLuminance > 0.179 ? 0 : 255;
    for (
      let percent = Math.round(amount * 100);
      contrast(background) < 4.5 && percent <= 100;
      percent++
    ) {
      background = mix(color, target, percent / 100);
    }
    return { background, foreground };
  };
  return {
    normal: { background: color, foreground },
    hover: pair(hover ?? mix(color, 255, 0.18), 0.18),
    active: pair(mix(color, 0, 0.12), 0.12),
  };
}

export function controlUiAccentFocus(color: string, surfaces: readonly string[]): string {
  const backgrounds = [color, ...surfaces].map(luminance);
  let best = "#000000";
  let bestContrast = 0;
  // Inset outlines touch the control fill too. A neutral midtone can contrast
  // with both a near-black control and a light page when black and white cannot.
  for (let channel = 0; channel <= 255; channel++) {
    const candidate = `#${channel.toString(16).padStart(2, "0").repeat(3)}`;
    const value = luminance(candidate);
    const contrast = Math.min(
      ...backgrounds.map(
        (background) => (Math.max(value, background) + 0.05) / (Math.min(value, background) + 0.05),
      ),
    );
    if (contrast > bestContrast) {
      best = candidate;
      bestContrast = contrast;
    }
  }
  return best;
}
