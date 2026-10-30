type Rgb = readonly [number, number, number];
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

function participantColors(palette: ParticipantPalette, identityHue: number | null) {
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

function linkContrast(foreground: Oklch, background: Oklch): number {
  const first = luminance(foreground);
  const second = luminance(background);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

/** Keep readable ink intact; otherwise move L only, fitting C at the gamut boundary. */
function readableLinkColor(foreground: Oklch, background: Oklch): Oklch {
  if (linkContrast(foreground, background) >= 7) {
    return foreground;
  }
  const ends = [0, 1].map((l) => fitSrgb({ ...foreground, l }));
  const candidates: Oklch[] = [];
  for (const end of ends) {
    if (linkContrast(end, background) < 7.01) {
      continue;
    }
    let near = foreground.l;
    let far = end.l;
    for (let index = 0; index < 24; index += 1) {
      const l = (near + far) / 2;
      if (linkContrast(fitSrgb({ ...foreground, l }), background) >= 7.01) {
        far = l;
      } else {
        near = l;
      }
    }
    candidates.push(fitSrgb({ ...foreground, l: far }));
  }
  // Imported midtone canvases may not admit 7:1 even with black or white.
  if (candidates.length === 0) {
    return ends.reduce((best, color) =>
      linkContrast(color, background) > linkContrast(best, background) ? color : best,
    );
  }
  return candidates.reduce((best, color) =>
    Math.abs(color.l - foreground.l) < Math.abs(best.l - foreground.l) ? color : best,
  );
}

export function prepareParticipantPalette(
  palette: ParticipantPalette,
  links: { normal: Oklch; hover: Oklch },
) {
  const linkStyle = (background: Oklch) => {
    const normal = readableLinkColor(links.normal, background);
    const hover = readableLinkColor(links.hover, background);
    return {
      normal: normal === links.normal ? "var(--link)" : css(normal),
      hover: hover === links.hover ? "var(--link-hover)" : css(hover),
    };
  };
  // One prepared string per identity in this palette; streamed tokens only read it.
  const identityStyles = new Map<number | null, string>();
  return {
    canvasLinks: linkStyle(palette.background),
    style(identityHue: number | null): string {
      const prepared = identityStyles.get(identityHue);
      if (prepared !== undefined) {
        return prepared;
      }
      const colors = participantColors(palette, identityHue);
      const ink = linkStyle(colors.bubble);
      const style = `--chat-participant-surface: ${css(colors.bubble)}; --chat-sender-name-color: ${css(colors.name)}; --chat-participant-link: ${ink.normal}; --chat-participant-link-hover: ${ink.hover}`;
      identityStyles.set(identityHue, style);
      return style;
    },
  };
}
