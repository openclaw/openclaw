import chalk from "chalk";
import { palette } from "../theme/theme.js";

const FULL_BLOCK = "\u2588";
const SHADE_LIGHT = "\u2591";
const SPARK_CHARS = [
  "\u2581",
  "\u2582",
  "\u2583",
  "\u2584",
  "\u2585",
  "\u2586",
  "\u2587",
  "\u2588",
];

// Category colors: distinct hex colors for each context category
const CATEGORY_COLORS: Record<string, string> = {
  "system-prompt": "#5B9BD5",
  "workspace-files": "#70AD47",
  skills: "#FFC000",
  tools: "#C27BA0",
};

function colorize(text: string, hex: string): string {
  return chalk.hex(hex)(text);
}

/**
 * Render a horizontal bar: filled portion + empty portion.
 */
export function renderHorizontalBar(
  value: number,
  maxValue: number,
  width: number,
  hex?: string,
): string {
  if (width <= 0 || maxValue <= 0) {
    return "";
  }
  const filled = Math.round((Math.min(value, maxValue) / maxValue) * width);
  const empty = width - filled;
  const filledStr = FULL_BLOCK.repeat(filled);
  const emptyStr = SHADE_LIGHT.repeat(empty);
  const color = hex ?? palette.accent;
  return `${colorize(filledStr, color)}${chalk.hex(palette.dim)(emptyStr)}`;
}

/**
 * Render a proportional stacked bar from multiple categories.
 */
export function renderProportionalBar(
  categories: Array<{ category: string; value: number }>,
  width: number,
): string {
  const total = categories.reduce((s, c) => s + c.value, 0);
  if (total <= 0 || width <= 0) {
    return SHADE_LIGHT.repeat(width);
  }

  let remaining = width;
  const parts: string[] = [];
  for (let i = 0; i < categories.length; i++) {
    const cat = categories[i];
    const isLast = i === categories.length - 1;
    const segWidth = isLast ? remaining : Math.round((cat.value / total) * width);
    const clamped = Math.max(segWidth > 0 && cat.value > 0 ? 1 : 0, Math.min(segWidth, remaining));
    if (clamped > 0) {
      const hex = CATEGORY_COLORS[cat.category] ?? palette.accent;
      parts.push(colorize(FULL_BLOCK.repeat(clamped), hex));
    }
    remaining -= clamped;
  }
  if (remaining > 0) {
    parts.push(chalk.hex(palette.dim)(SHADE_LIGHT.repeat(remaining)));
  }
  return parts.join("");
}

/**
 * Render a sparkline from an array of numeric values.
 */
export function renderSparkline(values: number[], width: number): string {
  if (values.length === 0 || width <= 0) {
    return "";
  }

  // Sample or pad values to fit width
  const sampled: number[] = [];
  if (values.length <= width) {
    sampled.push(...values);
    // Pad left with first value if fewer points than width
    while (sampled.length < width) {
      sampled.unshift(values[0]);
    }
  } else {
    // Downsample
    for (let i = 0; i < width; i++) {
      const idx = Math.round((i / (width - 1 || 1)) * (values.length - 1));
      sampled.push(values[idx]);
    }
  }

  const min = Math.min(...sampled);
  const max = Math.max(...sampled);
  const range = max - min || 1;

  const chars = sampled.map((v) => {
    const level = Math.round(((v - min) / range) * (SPARK_CHARS.length - 1));
    return SPARK_CHARS[level];
  });

  return colorize(chars.join(""), palette.accent);
}

/**
 * Render a labeled horizontal bar row for one category.
 */
export function renderCategoryBar(
  label: string,
  value: number,
  maxValue: number,
  labelWidth: number,
  barWidth: number,
  hex?: string,
): string {
  const paddedLabel = label.padEnd(labelWidth);
  const bar = renderHorizontalBar(value, maxValue, barWidth, hex);
  return `${paddedLabel} ${bar}`;
}

/**
 * Get the hex color for a context category.
 */
export function getCategoryColor(category: string): string {
  return CATEGORY_COLORS[category] ?? palette.accent;
}
