// @vitest-environment node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const stylesDir = path.dirname(fileURLToPath(import.meta.url));

// #107299: palette edits dimmed --muted to 3.1–3.5:1 on dark surfaces.
const TEXT_TOKENS = [
  "--text",
  "--text-strong",
  "--chat-text",
  "--muted",
  "--muted-strong",
  "--muted-foreground",
] as const;

const SURFACE_TOKENS = ["--bg", "--bg-elevated", "--bg-muted", "--card", "--panel"] as const;

const AA_NORMAL_TEXT_MIN = 4.5;

// Beacon promises AAA; the other themes promise AA.
const AAA_NORMAL_TEXT_MIN = 7;

// Read overrides from CSS: missing Beacon once left white on pale at 1.80:1.
const CONFIRM_BUTTON_RULE = ".chat-confirm-popover__yes";
const AAA_THEMES = new Set(["beacon", "beacon-light"]);

// --secondary matched --card and hid chips in dark user bubbles. File links
// are excluded because they use link ink rather than a chip surface.
const CODE_CHIP_RULE = ".chat-text :where(:not(pre, a.markdown-file-link) > code)";
const CODE_CHIP_HOST_SURFACES = ["--card", "--bg"] as const;
const CHIP_SURFACE_MIN_STEP = 1.05;
const CHIP_BORDER_MIN_STEP = 1.25;

// Missing light-mode overrides left tinted additions at 1.15:1 on --bg-muted.
const DIFF_SELECTORS = [
  ":is(.code-block, .code-block-wrapper pre code.hljs) .hljs-addition",
  ":is(.code-block, .code-block-wrapper pre code.hljs) .hljs-deletion",
] as const;
const DIFF_HOST_SURFACES = ["--bg", "--bg-muted", "--card"] as const;

// Accent-derived bubbles can swallow links; sender tints vary the failing hue.
const CHAT_LINK_RULE = ".chat-text :where(a)";
const CHAT_LINK_HOVER_RULE = ".chat-text :where(a:hover)";
const USER_BUBBLE_RULE = ".chat-group.user .chat-bubble";
// User and forwarded (cross-session) bubbles share one tint rule via :is().
const SENDER_TINT_BUBBLE_RULE =
  ".chat-group:is(.user, .chat-group--forwarded).chat-group--sender-tint .chat-bubble";
// Theme selection changes the skin token without outranking the bare image shell.
const LIGHT_USER_BUBBLE_RULE =
  ':where(:root[data-theme-mode="light"]) .chat-group.user .chat-bubble';
// Only user bubbles override the shared sender tint in light mode.
const LIGHT_SENDER_TINT_BUBBLE_RULE =
  ':where(:root[data-theme-mode="light"]) .chat-group.user.chat-group--sender-tint .chat-bubble';

type TokenMap = Map<string, string>;
type RGB = readonly [red: number, green: number, blue: number];
type Color = { rgb: RGB; alpha: number };

// Include lazy palettes as well as the startup stylesheet.
function readPaletteSources(stylesRoot: string): string {
  const themesDir = path.join(stylesRoot, "..", "..", "public", "themes");
  const palettes = fs
    .readdirSync(themesDir)
    .filter((entry) => entry.endsWith(".css"))
    .toSorted()
    .map((entry) => fs.readFileSync(path.join(themesDir, entry), "utf8"));
  return [fs.readFileSync(path.join(stylesRoot, "base.css"), "utf8"), ...palettes].join("\n");
}

function parseThemeBlocks(baseCss: string): Map<string, TokenMap> {
  const blocks = new Map<string, TokenMap>();
  const blockPattern =
    /(:root(?::where\(\[data-theme-mode="light"\]\)|\[data-theme(?:-mode)?="[^"]+"\])?)\s*\{([^}]*)\}/g;
  for (const match of baseCss.matchAll(blockPattern)) {
    const selector = match[1] ?? "";
    const body = match[2] ?? "";
    // base.css declares `:root` more than once (palette, then the standalone
    // --cursor-action blocks). Merging keeps the palette; overwriting made the
    // default `dark` theme resolve to an empty map and skip every assertion.
    const tokens: TokenMap = blocks.get(selector) ?? new Map();
    for (const line of body.split("\n")) {
      const declaration = line.match(/^\s*(--[\w-]+)\s*:\s*([^;]+);/);
      const name = declaration?.[1];
      const value = declaration?.[2];
      if (name && value) {
        tokens.set(name, value.trim());
      }
    }
    blocks.set(selector, tokens);
  }
  return blocks;
}

/** Compose each selectable theme the way theme.ts layers blocks over :root. */
function resolveThemes(blocks: Map<string, TokenMap>): Map<string, TokenMap> {
  const root = blocks.get(":root") ?? new Map();
  const light = blocks.get(':root:where([data-theme-mode="light"])') ?? new Map();
  const layer = (...overrides: (TokenMap | undefined)[]): TokenMap => {
    const merged: TokenMap = new Map(root);
    for (const override of overrides) {
      for (const [key, value] of override ?? []) {
        merged.set(key, value);
      }
    }
    return merged;
  };
  return new Map([
    ["dark", layer(blocks.get(':root[data-theme="dark"]'))],
    ["light", layer(light)],
    ["openknot", layer(blocks.get(':root[data-theme="openknot"]'))],
    ["openknot-light", layer(light, blocks.get(':root[data-theme="openknot-light"]'))],
    ["dash", layer(blocks.get(':root[data-theme="dash"]'))],
    ["dash-light", layer(light, blocks.get(':root[data-theme="dash-light"]'))],
    ["absolutely", layer(blocks.get(':root[data-theme="absolutely"]'))],
    ["absolutely-light", layer(light, blocks.get(':root[data-theme="absolutely-light"]'))],
    ["tide", layer(blocks.get(':root[data-theme="tide"]'))],
    ["tide-light", layer(light, blocks.get(':root[data-theme="tide-light"]'))],
    ["beacon", layer(blocks.get(':root[data-theme="beacon"]'))],
    ["beacon-light", layer(light, blocks.get(':root[data-theme="beacon-light"]'))],
    ["phosphor", layer(blocks.get(':root[data-theme="phosphor"]'))],
    ["phosphor-light", layer(light, blocks.get(':root[data-theme="phosphor-light"]'))],
    ["crt", layer(blocks.get(':root[data-theme="crt"]'))],
    ["crt-light", layer(light, blocks.get(':root[data-theme="crt-light"]'))],
    ["manuscript", layer(blocks.get(':root[data-theme="manuscript"]'))],
    ["manuscript-light", layer(light, blocks.get(':root[data-theme="manuscript-light"]'))],
    ["rose", layer(blocks.get(':root[data-theme="rose"]'))],
    ["rose-light", layer(light, blocks.get(':root[data-theme="rose-light"]'))],
    ["miami", layer(blocks.get(':root[data-theme="miami"]'))],
    ["miami-light", layer(light, blocks.get(':root[data-theme="miami-light"]'))],
  ]);
}

function parseHex(hex: string): RGB {
  const match = hex.match(/^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/iu);
  if (!match) {
    throw new Error(`could not parse hex color "${hex}"`);
  }
  return [
    Number.parseInt(match[1] ?? "", 16),
    Number.parseInt(match[2] ?? "", 16),
    Number.parseInt(match[3] ?? "", 16),
  ];
}

function relativeLuminance(rgb: RGB): number {
  const [red, green, blue] = rgb.map((value) => {
    const channel = value / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (red ?? 0) + 0.7152 * (green ?? 0) + 0.0722 * (blue ?? 0);
}

function contrastRatio(foreground: RGB, background: RGB): number {
  const [lighter = 0, darker = 0] = [
    relativeLuminance(foreground),
    relativeLuminance(background),
  ].toSorted((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

function parseAlpha(value: string | undefined): number {
  if (!value) {
    return 1;
  }
  return value.endsWith("%") ? Number.parseFloat(value) / 100 : Number.parseFloat(value);
}

function hslToRgb(hue: number, saturation: number, lightness: number): RGB {
  const normalizedHue = ((hue % 360) + 360) % 360;
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const segment = normalizedHue / 60;
  const secondary = chroma * (1 - Math.abs((segment % 2) - 1));
  const [red, green, blue]: RGB =
    segment < 1
      ? [chroma, secondary, 0]
      : segment < 2
        ? [secondary, chroma, 0]
        : segment < 3
          ? [0, chroma, secondary]
          : segment < 4
            ? [0, secondary, chroma]
            : segment < 5
              ? [secondary, 0, chroma]
              : [chroma, 0, secondary];
  const offset = lightness - chroma / 2;
  return [(red + offset) * 255, (green + offset) * 255, (blue + offset) * 255];
}

function resolveNumber(value: string, tokens: TokenMap): number {
  const variable = value.match(/^var\((--[\w-]+)\)$/u)?.[1];
  const resolved = variable ? tokens.get(variable) : value;
  if (resolved === undefined || !Number.isFinite(Number.parseFloat(resolved))) {
    throw new Error(`could not resolve numeric value "${value}"`);
  }
  return Number.parseFloat(resolved);
}

function mixColors(first: Color, firstWeight: number, second: Color): Color {
  const secondWeight = 1 - firstWeight;
  const alpha = first.alpha * firstWeight + second.alpha * secondWeight;
  if (alpha === 0) {
    return { rgb: [0, 0, 0], alpha };
  }
  // Premultiplied, matching CSS color-mix: a translucent operand contributes in
  // proportion to its own alpha, not just its declared weight.
  const channel = (index: 0 | 1 | 2): number =>
    (first.rgb[index] * first.alpha * firstWeight +
      second.rgb[index] * second.alpha * secondWeight) /
    alpha;
  return { rgb: [channel(0), channel(1), channel(2)], alpha };
}

function resolveColor(value: string, tokens: TokenMap, resolving = new Set<string>()): Color {
  const color = value.trim();
  if (color.startsWith("#")) {
    return { rgb: parseHex(color), alpha: 1 };
  }

  const variable = color.match(/^var\((--[\w-]+)\)$/u)?.[1];
  if (variable) {
    if (resolving.has(variable)) {
      throw new Error(`circular color token "${variable}"`);
    }
    const resolved = tokens.get(variable);
    if (!resolved) {
      throw new Error(`could not resolve color token "${variable}"`);
    }
    return resolveColor(resolved, tokens, new Set(resolving).add(variable));
  }

  const rgb = color.match(
    /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+%?))?\s*\)$/u,
  );
  if (rgb) {
    return {
      rgb: [
        Number.parseFloat(rgb[1] ?? ""),
        Number.parseFloat(rgb[2] ?? ""),
        Number.parseFloat(rgb[3] ?? ""),
      ],
      alpha: parseAlpha(rgb[4]),
    };
  }

  const hsl = color.match(
    /^hsl\(\s*(var\(--[\w-]+\)|-?[\d.]+)\s+([\d.]+)%\s+([\d.]+)%(?:\s*\/\s*([\d.]+%?))?\s*\)$/u,
  );
  if (hsl) {
    return {
      rgb: hslToRgb(
        resolveNumber(hsl[1] ?? "", tokens),
        Number.parseFloat(hsl[2] ?? "") / 100,
        Number.parseFloat(hsl[3] ?? "") / 100,
      ),
      alpha: parseAlpha(hsl[4]),
    };
  }

  const mix = color.match(
    /^color-mix\(in srgb,\s*(var\(--[\w-]+\))\s+([\d.]+)%,\s*(var\(--[\w-]+\))\s*\)$/u,
  );
  if (mix) {
    return mixColors(
      resolveColor(mix[1] ?? "", tokens, resolving),
      Number.parseFloat(mix[2] ?? "") / 100,
      resolveColor(mix[3] ?? "", tokens, resolving),
    );
  }

  throw new Error(`could not resolve color "${value}"`);
}

function composite(color: Color, background: RGB): RGB {
  return [
    color.rgb[0] * color.alpha + background[0] * (1 - color.alpha),
    color.rgb[1] * color.alpha + background[1] * (1 - color.alpha),
    color.rgb[2] * color.alpha + background[2] * (1 - color.alpha),
  ];
}

function resolveOpaqueColor(value: string, tokens: TokenMap): RGB {
  const color = resolveColor(value, tokens);
  if (color.alpha !== 1) {
    throw new Error(`expected opaque color "${value}"`);
  }
  return color.rgb;
}

/** Read the surface/border tokens the shipped code-chip rule actually paints. */
function readCodeChipTokens(chatTextCss: string): { surface: string; border: string } {
  const rule = chatTextCss.split(CODE_CHIP_RULE)[1]?.split("}")[0] ?? "";
  const surface = rule.match(/background:\s*var\((--[\w-]+)\)/u)?.[1];
  const border = rule.match(/border:[^;]*var\((--[\w-]+)\)/u)?.[1];
  if (!surface || !border) {
    throw new Error(`could not read chip tokens from "${CODE_CHIP_RULE}"`);
  }
  return { surface, border };
}

type ConfirmButtonPaint = { background: string; color: string };

function readConfirmButtonPaint(groupedCss: string): {
  base: ConfirmButtonPaint;
  overrides: Map<string, ConfirmButtonPaint>;
} {
  const pattern = /([^{}]*\.chat-confirm-popover__yes(?![\w-])[^{}]*)\{([^}]*)\}/gu;
  let base: ConfirmButtonPaint | undefined;
  const overrides = new Map<string, ConfirmButtonPaint>();
  for (const match of groupedCss.matchAll(pattern)) {
    const selector = (match[1] ?? "").trim();
    const body = match[2] ?? "";
    if (selector.includes(":hover")) {
      continue;
    }
    const background = body.match(/background:\s*var\((--[\w-]+)\)/u)?.[1];
    const color = body.match(/color:\s*var\((--[\w-]+)\)/u)?.[1];
    if (!background || !color) {
      continue;
    }
    const themes = [...selector.matchAll(/\[data-theme="([^"]+)"\]/gu)].map((m) => m[1] ?? "");
    if (themes.length === 0) {
      base = { background, color };
      continue;
    }
    for (const theme of themes) {
      overrides.set(theme, { background, color });
    }
  }
  if (!base) {
    throw new Error(`could not read the base "${CONFIRM_BUTTON_RULE}" paint`);
  }
  return { base, overrides };
}

function readRuleBody(css: string, selector: string): string {
  const body = css.split(`${selector} {`)[1]?.split("}")[0];
  if (body === undefined) {
    throw new Error(`could not read rule "${selector}"`);
  }
  return body;
}

function readChatLinkTokens(chatTextCss: string): { link: string; hover: string } {
  const link = readRuleBody(chatTextCss, CHAT_LINK_RULE).match(/color:\s*var\((--[\w-]+)\)/u)?.[1];
  const hover = readRuleBody(chatTextCss, CHAT_LINK_HOVER_RULE).match(
    /color:\s*var\((--[\w-]+)\)/u,
  )?.[1];
  if (!link) {
    throw new Error(`could not read link token from "${CHAT_LINK_RULE}"`);
  }
  return { link, hover: hover ?? link };
}

function readBubbleBackgrounds(groupedCss: string): {
  user: string;
  lightUser: string;
  lightUserText: string;
  senderTint: string;
  lightSenderTint: string;
} {
  const readBackground = (selector: string): string => {
    const background = readRuleBody(groupedCss, selector).match(
      /^\s*--chat-bubble-background:\s*([^;]+);/mu,
    )?.[1];
    if (!background) {
      throw new Error(`could not read bubble background token from "${selector}"`);
    }
    return background.trim();
  };
  return {
    user: readBackground(USER_BUBBLE_RULE),
    lightUser: readBackground(LIGHT_USER_BUBBLE_RULE),
    lightUserText:
      readRuleBody(groupedCss, LIGHT_USER_BUBBLE_RULE).match(/color:\s*var\((--[\w-]+)\)/u)?.[1] ??
      "",
    senderTint: readBackground(SENDER_TINT_BUBBLE_RULE),
    lightSenderTint: readBackground(LIGHT_SENDER_TINT_BUBBLE_RULE),
  };
}

describe("Control UI theme contrast", () => {
  const baseCss = readPaletteSources(stylesDir);
  const themes = resolveThemes(parseThemeBlocks(baseCss));

  it("keeps every text token at WCAG AA on every theme surface, AAA on themes that promise it", () => {
    for (const [themeName, tokens] of themes) {
      for (const textToken of TEXT_TOKENS) {
        const foreground = resolveOpaqueColor(`var(${textToken})`, tokens);
        for (const surfaceToken of SURFACE_TOKENS) {
          const background = resolveOpaqueColor(`var(${surfaceToken})`, tokens);
          const ratio = contrastRatio(foreground, background);
          const floor = AAA_THEMES.has(themeName) ? AAA_NORMAL_TEXT_MIN : AA_NORMAL_TEXT_MIN;
          expect(
            ratio,
            `${themeName}: ${textToken} rgb(${foreground.join(", ")}) on ${surfaceToken} rgb(${background.join(", ")})`,
          ).toBeGreaterThanOrEqual(floor);
        }
      }
    }
  });

  it("keeps selected controls and session labels at WCAG AA across themes", () => {
    const cases = [
      ["components.css", ".btn.active", "var(--accent-subtle)"],
      [
        "settings-controls.css",
        ".settings-segmented--accent > .settings-segmented__btn--active",
        "var(--accent-subtle)",
      ],
      ["sessions.css", ".session-label-chip", null],
      ["sessions.css", ".session-kind--direct", null],
    ] as const;
    const failures: string[] = [];
    for (const [filename, selector, tint] of cases) {
      const rule = readRuleBody(fs.readFileSync(path.join(stylesDir, filename), "utf8"), selector);
      const ink = rule.match(/(?:^|;)\s*color:\s*([^;]+);/u)?.[1];
      if (!ink) {
        throw new Error(`could not read text color from "${selector}"`);
      }
      for (const [themeName, tokens] of themes) {
        const foreground = resolveOpaqueColor(ink, tokens);
        for (const surfaceToken of SURFACE_TOKENS) {
          const host = resolveOpaqueColor(`var(${surfaceToken})`, tokens);
          const background = tint ? composite(resolveColor(tint, tokens), host) : host;
          const ratio = contrastRatio(foreground, background);
          if (ratio < AA_NORMAL_TEXT_MIN) {
            failures.push(`${themeName}: ${selector} on ${surfaceToken} = ${ratio.toFixed(2)}:1`);
          }
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it("keeps the markdown code chip separated from every surface it sits on", () => {
    const chatTextCss = fs.readFileSync(path.join(stylesDir, "chat", "text.css"), "utf8");
    const chip = readCodeChipTokens(chatTextCss);
    for (const [themeName, tokens] of themes) {
      const surface = tokens.get(chip.surface);
      const border = tokens.get(chip.border);
      expect(surface, `${themeName}: ${chip.surface} is not a hex token`).toMatch(/^#/u);
      expect(border, `${themeName}: ${chip.border} is not a hex token`).toMatch(/^#/u);
      for (const hostToken of CODE_CHIP_HOST_SURFACES) {
        const host = tokens.get(hostToken);
        if (!host?.startsWith("#")) {
          continue;
        }
        const surfaceStep = contrastRatio(parseHex(surface ?? ""), parseHex(host));
        const borderStep = contrastRatio(parseHex(border ?? ""), parseHex(host));
        expect(
          surfaceStep,
          `${themeName}: chip ${chip.surface} ${surface} on ${hostToken} ${host}`,
        ).toBeGreaterThanOrEqual(CHIP_SURFACE_MIN_STEP);
        expect(
          borderStep,
          `${themeName}: chip border ${chip.border} ${border} on ${hostToken} ${host}`,
        ).toBeGreaterThanOrEqual(CHIP_BORDER_MIN_STEP);
      }
    }
  });

  it("keeps the chat confirmation button legible on every theme", () => {
    const groupedCss = fs.readFileSync(path.join(stylesDir, "chat", "grouped.css"), "utf8");
    const { base, overrides } = readConfirmButtonPaint(groupedCss);
    for (const [themeName, tokens] of themes) {
      const paint = overrides.get(themeName) ?? base;
      const background = tokens.get(paint.background);
      const color = tokens.get(paint.color);
      if (!background?.startsWith("#") || !color?.startsWith("#")) {
        continue;
      }
      const ratio = contrastRatio(parseHex(color), parseHex(background));
      const floor = AAA_THEMES.has(themeName) ? AAA_NORMAL_TEXT_MIN : AA_NORMAL_TEXT_MIN;
      expect(
        ratio,
        `${themeName}: ${paint.color} ${color} on ${paint.background} ${background}`,
      ).toBeGreaterThanOrEqual(floor);
    }
  });

  it("keeps highlighted diff lines at WCAG AA on every code surface", () => {
    const componentsCss = fs.readFileSync(path.join(stylesDir, "components.css"), "utf8");
    const diffStyles = DIFF_SELECTORS.map((selector) => {
      const rule = readRuleBody(componentsCss, selector);
      const foregroundToken = rule.match(/color:\s*var\((--[\w-]+)\)/u)?.[1];
      const tint = rule.match(/background:\s*([^;]+);/u)?.[1];
      if (!foregroundToken || !tint) {
        throw new Error(`could not read diff colors from "${selector}"`);
      }
      return { foregroundToken, tint };
    });
    for (const [themeName, tokens] of themes) {
      for (const { foregroundToken, tint } of diffStyles) {
        const foreground = resolveOpaqueColor(`var(${foregroundToken})`, tokens);
        const resolvedTint = resolveColor(tint, tokens);
        for (const surfaceToken of DIFF_HOST_SURFACES) {
          const host = resolveOpaqueColor(`var(${surfaceToken})`, tokens);
          const background = composite(resolvedTint, host);
          const ratio = contrastRatio(foreground, background);
          const floor = AAA_THEMES.has(themeName) ? AAA_NORMAL_TEXT_MIN : AA_NORMAL_TEXT_MIN;
          expect(
            ratio,
            `${themeName}: ${foregroundToken} on ${tint} over ${surfaceToken}`,
          ).toBeGreaterThanOrEqual(floor);
        }
      }
    }
  });

  it("keeps chat links at WCAG AA on every bubble surface", () => {
    const chatTextCss = fs.readFileSync(path.join(stylesDir, "chat", "text.css"), "utf8");
    const groupedCss = fs.readFileSync(path.join(stylesDir, "chat", "grouped.css"), "utf8");
    const linkTokens = readChatLinkTokens(chatTextCss);
    const bubbleBackgrounds = readBubbleBackgrounds(groupedCss);
    for (const [themeName, tokens] of themes) {
      const page = resolveOpaqueColor("var(--bg)", tokens);
      const isLight = themeName === "light" || themeName.endsWith("-light");
      const userFill = isLight ? bubbleBackgrounds.lightUser : bubbleBackgrounds.user;
      const senderTint = isLight ? bubbleBackgrounds.lightSenderTint : bubbleBackgrounds.senderTint;
      const userBubble = composite(resolveColor(userFill, tokens), page);

      if (isLight) {
        expect(bubbleBackgrounds.lightUserText).not.toBe("");
        const foreground = resolveOpaqueColor(`var(${bubbleBackgrounds.lightUserText})`, tokens);
        const ratio = contrastRatio(foreground, userBubble);
        expect(
          ratio,
          `${themeName}: text ${bubbleBackgrounds.lightUserText} on user bubble ${userFill}`,
        ).toBeGreaterThanOrEqual(AA_NORMAL_TEXT_MIN);
      }

      for (const [state, token] of [
        ["link", linkTokens.link],
        ["link hover", linkTokens.hover],
      ] as const) {
        const foreground = resolveColor(`var(${token})`, tokens);
        const userRatio = contrastRatio(composite(foreground, userBubble), userBubble);
        expect(
          userRatio,
          `${themeName}: ${state} ${token} on user bubble ${userFill}`,
        ).toBeGreaterThanOrEqual(AA_NORMAL_TEXT_MIN);

        let worstRatio = Number.POSITIVE_INFINITY;
        let worstHue = 0;
        for (let hue = 0; hue < 360; hue += 1) {
          const hueTokens = new Map(tokens).set("--chat-sender-hue", String(hue));
          const bubble = composite(resolveColor(senderTint, hueTokens), page);
          const ratio = contrastRatio(composite(foreground, bubble), bubble);
          if (ratio < worstRatio) {
            worstRatio = ratio;
            worstHue = hue;
          }
        }
        expect(
          worstRatio,
          `${themeName}: ${state} ${token} on sender-tinted bubble ${senderTint} at hue ${worstHue}`,
        ).toBeGreaterThanOrEqual(AA_NORMAL_TEXT_MIN);
      }
    }
  });
});
