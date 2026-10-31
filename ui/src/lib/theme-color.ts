export type ThemeColor = {
  rgb: readonly [number, number, number];
  alpha: number;
};

export function resolveThemeColor(styles: CSSStyleDeclaration, property: string): string {
  const value = styles.getPropertyValue(property).trim();
  if (!value || /^#[\da-f]{6}$/iu.test(value)) {
    return value.toLowerCase();
  }
  const color = resolveThemeColors([value])?.[0];
  if (!color) {
    return value;
  }
  // Terminal OSC colors and Mermaid require concrete #rrggbb values.
  return `#${color.rgb
    .map((channel) =>
      Math.round(channel * 255)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

/** Resolve a palette in one canvas, retaining alpha for CSS surface compositing. */
export function resolveThemeColors(values: readonly string[]): ThemeColor[] | undefined {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const context = canvas.getContext("2d");
  if (!context) {
    return undefined;
  }
  return values.map<ThemeColor>((value) => {
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = "transparent";
    context.fillStyle = value;
    context.fillRect(0, 0, 1, 1);
    const [r, g, b, alpha] = context.getImageData(0, 0, 1, 1).data;
    return { rgb: [r! / 255, g! / 255, b! / 255], alpha: alpha! / 255 };
  });
}
