import type { ThemeColor } from "../theme-color.ts";

type Rgb = readonly [number, number, number];
type LuminanceRange = readonly [darkest: number, lightest: number];
export type Oklch = { l: number; c: number; h: number };
type ParticipantPalette = {
  mode: "light" | "dark";
  background: Oklch;
  accent: Oklch;
};

const PARTICIPANT_TONES = {
  light: { peerOffset: -0.035, viewerOffset: -0.05, nameL: 0.46, nameC: 0.07 },
  dark: { peerOffset: 0.07, viewerOffset: 0.1, nameL: 0.79, nameC: 0.055 },
  bubbleC: 0.024,
} as const;

const linear = (channel: number) =>
  channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;

function rgbToOklch(rgb: Rgb): Oklch {
  const [r, g, b] = rgb.map(linear);
  const l = Math.cbrt(0.4122214708 * r! + 0.5363325363 * g! + 0.0514459929 * b!);
  const m = Math.cbrt(0.2119034982 * r! + 0.6806995451 * g! + 0.1073969566 * b!);
  const s = Math.cbrt(0.0883024619 * r! + 0.2817188376 * g! + 0.6299787005 * b!);
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const blue = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const c = Math.hypot(a, blue);
  return {
    l: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    c,
    h: c < 1e-7 ? 0 : ((Math.atan2(blue, a) * 180) / Math.PI + 360) % 360,
  };
}

export function hexToOklch(hex: string): Oklch {
  return rgbToOklch([
    Number.parseInt(hex.slice(1, 3), 16) / 255,
    Number.parseInt(hex.slice(3, 5), 16) / 255,
    Number.parseInt(hex.slice(5, 7), 16) / 255,
  ]);
}

function oklchToLinearRgb({ l, c, h }: Oklch): Rgb {
  const a = c * Math.cos((h * Math.PI) / 180);
  const b = c * Math.sin((h * Math.PI) / 180);
  const ll = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const mm = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const ss = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * ll - 3.3077115913 * mm + 0.2309699292 * ss,
    -1.2684380046 * ll + 2.6097574011 * mm - 0.3413193965 * ss,
    -0.0041960863 * ll - 0.7034186147 * mm + 1.707614701 * ss,
  ];
}

function isSrgb(color: Oklch): boolean {
  return oklchToLinearRgb(color).every((channel) => channel >= 0 && channel <= 1);
}

/** The browser receives an in-gamut OKLCH color; it never has to clip its channels. */
function fitSrgb(color: Oklch): Oklch {
  if (isSrgb(color)) {
    return color;
  }
  let low = 0;
  let high = color.c;
  for (let index = 0; index < 32; index += 1) {
    const c = (low + high) / 2;
    if (isSrgb({ ...color, c })) {
      low = c;
    } else {
      high = c;
    }
  }
  return { ...color, c: low };
}

/** Avatar identity is HSL(h, 48%, 42%); HSL and OKLCH hue angles differ. */
function identityOklchHue(hue: number): number {
  const lightness = 0.42;
  const amplitude = 0.48 * Math.min(lightness, 1 - lightness);
  const channel = (offset: number) => {
    const k = (offset + hue / 30) % 12;
    return lightness - amplitude * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return rgbToOklch([channel(0), channel(8), channel(4)]).h;
}

export function participantColors(palette: ParticipantPalette, identityHue: number | null) {
  const tones = PARTICIPANT_TONES[palette.mode];
  const viewer = identityHue === null;
  const h = viewer ? palette.accent.h : identityOklchHue(identityHue);
  return {
    bubble: fitSrgb({
      l: palette.background.l + (viewer ? tones.viewerOffset : tones.peerOffset),
      c: PARTICIPANT_TONES.bubbleC,
      h,
    }),
    name: fitSrgb({ l: tones.nameL, c: tones.nameC, h }),
  };
}

const css = ({ l, c, h }: Oklch) => `oklch(${l} ${c} ${h})`;

function luminance(color: Oklch): number {
  const [r, g, b] = oklchToLinearRgb(color);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function linkContrast(foreground: Oklch, [darkest, lightest]: LuminanceRange): number {
  const ink = luminance(foreground);
  if (ink < darkest) {
    return (darkest + 0.05) / (ink + 0.05);
  }
  if (ink > lightest) {
    return (ink + 0.05) / (lightest + 0.05);
  }
  return 1;
}

/** Keep readable ink intact; otherwise move L only, fitting C at the gamut boundary. */
function readableLinkColor(
  foreground: Oklch,
  backgrounds: LuminanceRange,
  minimumContrast: number,
): Oklch {
  if (linkContrast(foreground, backgrounds) >= minimumContrast) {
    return foreground;
  }
  // CSS compositing and sRGB rasterization need a small margin at the AA boundary.
  const targetContrast = minimumContrast + 0.1;
  const ends = [0, 1].map((l) => fitSrgb({ ...foreground, l }));
  const candidates: Oklch[] = [];
  for (const end of ends) {
    if (linkContrast(end, backgrounds) < targetContrast) {
      continue;
    }
    let near = foreground.l;
    let far = end.l;
    for (let index = 0; index < 24; index += 1) {
      const l = (near + far) / 2;
      if (linkContrast(fitSrgb({ ...foreground, l }), backgrounds) >= targetContrast) {
        far = l;
      } else {
        near = l;
      }
    }
    candidates.push(fitSrgb({ ...foreground, l: far }));
  }
  // A custom theme's combined surfaces may not admit one 4.5:1 ink.
  if (candidates.length === 0) {
    return ends.reduce((best, color) =>
      linkContrast(color, backgrounds) > linkContrast(best, backgrounds) ? color : best,
    );
  }
  return candidates.reduce((best, color) =>
    Math.abs(color.l - foreground.l) < Math.abs(best.l - foreground.l) ? color : best,
  );
}

/** Keep canvas and tinted-bubble inks separate while covering every supported identity hue. */
export function prepareThemeLinks(
  palette: ParticipantPalette,
  surfaces: readonly ThemeColor[],
  overlays: readonly ThemeColor[],
  minimumContrast = 4.5,
): { normal: string; tint: string } {
  const encode = (channel: number) =>
    channel <= 0.0031308 ? 12.92 * channel : 1.055 * channel ** (1 / 2.4) - 0.055;
  const rgb = (color: Oklch): Rgb => {
    const [r, g, b] = oklchToLinearRgb(color);
    return [encode(r), encode(g), encode(b)];
  };
  const composite = (foreground: ThemeColor, background: Rgb): Rgb => [
    foreground.rgb[0] * foreground.alpha + background[0] * (1 - foreground.alpha),
    foreground.rgb[1] * foreground.alpha + background[1] * (1 - foreground.alpha),
    foreground.rgb[2] * foreground.alpha + background[2] * (1 - foreground.alpha),
  ];
  const normal: [number, number] = [Infinity, -Infinity];
  const tint: [number, number] = [Infinity, -Infinity];
  const include = (range: [number, number], [r, g, b]: Rgb) => {
    const value = 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
    range[0] = Math.min(range[0], value);
    range[1] = Math.max(range[1], value);
  };
  const includeBody = (range: [number, number], background: Rgb) => {
    include(range, background);
    for (const overlay of overlays) {
      include(range, composite(overlay, background));
    }
  };
  const canvas = rgb(palette.background);
  includeBody(normal, canvas);
  for (const surface of surfaces) {
    include(normal, composite(surface, canvas));
  }
  includeBody(tint, rgb(participantColors(palette, null).bubble));
  // Identity hues are integer colorSeed % 360 values, independent of the active roster.
  for (let hue = 0; hue < 360; hue += 1) {
    includeBody(tint, rgb(participantColors(palette, hue).bubble));
  }
  return {
    normal: css(readableLinkColor(palette.accent, normal, minimumContrast)),
    tint: css(readableLinkColor(palette.accent, tint, minimumContrast)),
  };
}

export function prepareParticipantPalette(palette: ParticipantPalette) {
  // One prepared string per identity in this palette; streamed tokens only read it.
  const identityStyles = new Map<number | null, string>();
  return {
    style(identityHue: number | null): string {
      const prepared = identityStyles.get(identityHue);
      if (prepared !== undefined) {
        return prepared;
      }
      const colors = participantColors(palette, identityHue);
      const style = `--chat-participant-surface: ${css(colors.bubble)}; --chat-sender-name-color: ${css(colors.name)}`;
      identityStyles.set(identityHue, style);
      return style;
    },
  };
}
