/**
 * Sprite caching and outline generation.
 *
 * Provides zoom-level-aware canvas caching for sprite rendering
 * and outline sprite generation for selection/hover effects.
 */

import type { SpriteData } from "../types.js";

const zoomCaches = new Map<number, WeakMap<SpriteData, HTMLCanvasElement>>();

// -- Outline sprite generation ------------------------------------------------

const outlineCache = new WeakMap<SpriteData, SpriteData>();

/** Generate a 1px white outline SpriteData (2px larger in each dimension) */
export function getOutlineSprite(sprite: SpriteData): SpriteData {
  const cached = outlineCache.get(sprite);
  if (cached) {
    return cached;
  }

  const rows = sprite.length;
  const cols = sprite[0].length;
  // Expanded grid: +2 in each dimension for 1px border
  const outline: string[][] = [];
  for (let r = 0; r < rows + 2; r++) {
    outline.push(Array.from({ length: cols + 2 }, () => ""));
  }

  // For each opaque pixel, mark its 4 cardinal neighbors as white
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (sprite[r][c] === "") {
        continue;
      }
      const er = r + 1;
      const ec = c + 1;
      if (outline[er - 1][ec] === "") {
        outline[er - 1][ec] = "#FFFFFF";
      }
      if (outline[er + 1][ec] === "") {
        outline[er + 1][ec] = "#FFFFFF";
      }
      if (outline[er][ec - 1] === "") {
        outline[er][ec - 1] = "#FFFFFF";
      }
      if (outline[er][ec + 1] === "") {
        outline[er][ec + 1] = "#FFFFFF";
      }
    }
  }

  // Clear pixels that overlap with original opaque pixels
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (sprite[r][c] !== "") {
        outline[r + 1][c + 1] = "";
      }
    }
  }

  outlineCache.set(sprite, outline);
  return outline;
}

/**
 * Get a cached canvas for a sprite at a specific zoom level.
 * Creates and caches a new canvas if one doesn't exist.
 */
export function getCachedSprite(sprite: SpriteData, zoom: number): HTMLCanvasElement {
  let cache = zoomCaches.get(zoom);
  if (!cache) {
    cache = new WeakMap();
    zoomCaches.set(zoom, cache);
  }

  const cached = cache.get(sprite);
  if (cached) {
    return cached;
  }

  const rows = sprite.length;
  const cols = sprite[0].length;
  const canvas = document.createElement("canvas");
  canvas.width = cols * zoom;
  canvas.height = rows * zoom;
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingEnabled = false;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const color = sprite[r][c];
      if (color === "") {
        continue;
      }
      ctx.fillStyle = color;
      ctx.fillRect(c * zoom, r * zoom, zoom, zoom);
    }
  }

  cache.set(sprite, canvas);
  return canvas;
}
