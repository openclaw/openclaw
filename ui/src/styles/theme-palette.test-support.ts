import fs from "node:fs";
import path from "node:path";
import postcss from "postcss";

// Include lazy palettes and merge repeated :root blocks without erasing tokens.
export function readThemeBlocks(stylesDir: string): Map<string, Map<string, string>> {
  const themesDir = path.join(stylesDir, "..", "..", "public", "themes");
  const files = [
    path.join(stylesDir, "base.css"),
    ...fs
      .readdirSync(themesDir)
      .filter((name) => name.endsWith(".css"))
      .toSorted()
      .map((name) => path.join(themesDir, name)),
  ];
  const blocks = new Map<string, Map<string, string>>();
  postcss.parse(files.map((file) => fs.readFileSync(file, "utf8")).join("\n")).walkRules((rule) => {
    for (const selector of rule.selectors) {
      if (
        !/^:root(?::where\(\[data-theme-mode="light"\]\)|\[data-theme(?:-mode)?="[^"]+"\])?$/u.test(
          selector,
        )
      ) {
        continue;
      }
      const tokens = blocks.get(selector) ?? new Map<string, string>();
      for (const node of rule.nodes) {
        if (node.type === "decl" && node.prop.startsWith("--")) {
          tokens.set(node.prop, node.value.trim());
        }
      }
      blocks.set(selector, tokens);
    }
  });
  return blocks;
}

export type TokenMap = Map<string, string>;
export type RGB = readonly [red: number, green: number, blue: number];
export type Color = { rgb: RGB; alpha: number };

function required<T>(value: T | null | undefined, label: string): T {
  if (!value) {
    throw new Error(`could not resolve ${label}`);
  }
  return value;
}

export function resolveThemes(blocks: Map<string, TokenMap>): Map<string, TokenMap> {
  const root = blocks.get(":root") ?? new Map();
  const light = blocks.get(':root:where([data-theme-mode="light"])') ?? new Map();
  const names = [
    "dark",
    "light",
    ..."openknot dash absolutely tide beacon phosphor crt manuscript rose miami"
      .split(" ")
      .flatMap((name) => [name, `${name}-light`]),
  ];
  return new Map(
    names.map((name) => [
      name,
      new Map([
        ...root,
        ...(name === "light" || name.endsWith("-light") ? light : []),
        ...(blocks.get(`:root[data-theme="${name}"]`) ?? []),
      ]),
    ]),
  );
}

function parseHex(hex: string): RGB {
  const match = required(hex.match(/^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/iu), hex);
  const channel = (index: number) => Number.parseInt(match[index] ?? "", 16);
  return [channel(1), channel(2), channel(3)];
}

function parseAlpha(value: string | undefined): number {
  return value ? Number.parseFloat(value) / (value.endsWith("%") ? 100 : 1) : 1;
}

function hslToRgb(hue: number, saturation: number, lightness: number): RGB {
  const normalizedHue = ((hue % 360) + 360) % 360;
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const segment = normalizedHue / 60;
  const secondary = chroma * (1 - Math.abs((segment % 2) - 1));
  const sectors: RGB[] = [
    [chroma, secondary, 0],
    [secondary, chroma, 0],
    [0, chroma, secondary],
    [0, secondary, chroma],
    [secondary, 0, chroma],
    [chroma, 0, secondary],
  ];
  const [red, green, blue] = sectors[Math.floor(segment)]!;
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
  // CSS color-mix weights translucent operands by their alpha too.
  const channel = (index: 0 | 1 | 2): number =>
    (first.rgb[index] * first.alpha * firstWeight +
      second.rgb[index] * second.alpha * secondWeight) /
    alpha;
  return { rgb: [channel(0), channel(1), channel(2)], alpha };
}

export function resolveColor(
  value: string,
  tokens: TokenMap,
  resolving = new Set<string>(),
): Color {
  const color = value.trim();
  if (color === "white") {
    return { rgb: [255, 255, 255], alpha: 1 };
  }
  if (color.startsWith("#")) {
    return { rgb: parseHex(color), alpha: 1 };
  }

  const [, variable, fallback] = color.match(/^var\((--[\w-]+)(?:,\s*(.+))?\)$/u) ?? [];
  if (variable) {
    if (resolving.has(variable)) {
      throw new Error(`circular color token "${variable}"`);
    }
    const resolved = required(tokens.get(variable) ?? fallback, variable);
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
    /^color-mix\(in srgb,\s*(var\(--[\w-]+\))\s+([\d.]+)%,\s*(var\(--[\w-]+\)|white)\s*\)$/u,
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

export function resolveOpaqueColor(value: string, tokens: TokenMap): RGB {
  const color = resolveColor(value, tokens);
  if (color.alpha !== 1) {
    throw new Error(`expected opaque color "${value}"`);
  }
  return color.rgb;
}
