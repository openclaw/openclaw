type Rgb = readonly number[];

function luminance(rgb: Rgb): number {
  const channels = rgb.map((value) => {
    const channel = value / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
}

function contrast(first: Rgb, second: Rgb): number {
  const a = luminance(first);
  const b = luminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** Bound every possible image pixel, not a sparse sample of a particular photograph. */
export function backgroundImageOpacityLimit(
  surface: Rgb,
  foregrounds: readonly Rgb[],
  minimumContrast = 4.5,
): number {
  if (!foregrounds.length) {
    return 0;
  }
  const composite = (foreground: Rgb, background: Rgb): Rgb => {
    const alpha = (foreground[3] ?? 255) / 255;
    return foreground
      .slice(0, 3)
      .map((value, index) => value * alpha + background[index]! * (1 - alpha));
  };
  const preservesContrast = (opacity: number) =>
    foregrounds.every((foreground) => {
      // Preserve an imported palette's existing contrast when it is already below AA.
      const target = Math.min(minimumContrast, contrast(surface, composite(foreground, surface)));
      const extremes = [0, 255].map((channel) =>
        surface.map((value) => value * (1 - opacity) + channel * opacity),
      );
      const low = luminance(extremes[0]!);
      const high = luminance(extremes[1]!);
      // Alpha text changes with the image too. Bound both ranges rather than
      // treating a color composited against the plain canvas as fixed.
      const textLow = luminance(composite(foreground, extremes[0]!));
      const textHigh = luminance(composite(foreground, extremes[1]!));
      if (textLow <= high && textHigh >= low) {
        return target <= 1;
      }
      return textLow > high
        ? (textLow + 0.05) / (high + 0.05) >= target
        : (low + 0.05) / (textHigh + 0.05) >= target;
    });
  let low = 0;
  let high = 0.32;
  for (let step = 0; step < 16; step++) {
    const middle = (low + high) / 2;
    if (preservesContrast(middle)) {
      low = middle;
    } else {
      high = middle;
    }
  }
  return low;
}
