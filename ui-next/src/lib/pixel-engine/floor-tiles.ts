/**
 * Floor tile pattern storage and colorization.
 *
 * Manages grayscale floor sprites loaded from an external image,
 * with fallback to a default solid gray tile when the image isn't loaded.
 */

import { getColorizedSprite, clearColorizeCache } from "./colorize.js";
import { TILE_SIZE, FALLBACK_FLOOR_COLOR } from "./constants.js";
import type { SpriteData, FloorColor } from "./types.js";

const WALL_COLOR = "#3A3A5C";

/** Module-level array of floor sprites, populated via setFloorSprites */
let floorSprites: SpriteData[] = [];

/** Default solid gray 16x16 tile used when the PNG isn't loaded */
function makeDefaultTile(): SpriteData {
  const tile: SpriteData = [];
  for (let r = 0; r < TILE_SIZE; r++) {
    const row: string[] = [];
    for (let c = 0; c < TILE_SIZE; c++) {
      row.push(FALLBACK_FLOOR_COLOR);
    }
    tile.push(row);
  }
  return tile;
}

/** Initialize floor sprites from loaded image data and clear colorize cache */
export function setFloorSprites(sprites: SpriteData[]): void {
  floorSprites = sprites;
  clearColorizeCache();
}

/** Get the number of loaded floor patterns */
export function getFloorPatternCount(): number {
  return floorSprites.length;
}

/** Check whether floor sprites have been loaded */
export function hasFloorSprites(): boolean {
  return floorSprites.length > 0;
}

/**
 * Retrieve raw grayscale sprite by pattern index (1-7).
 * Returns a default solid gray tile if the PNG isn't loaded.
 */
export function getFloorSprite(patternIndex: number): SpriteData {
  const idx = patternIndex - 1;
  if (idx < 0 || idx >= floorSprites.length) {
    return makeDefaultTile();
  }
  return floorSprites[idx];
}

/**
 * Get a colorized floor sprite, using cache for performance.
 * Applies Photoshop-style colorize effect via the shared colorize module.
 */
export function getColorizedFloorSprite(patternIndex: number, color: FloorColor): SpriteData {
  const sprite = getFloorSprite(patternIndex);
  const cacheKey = `floor:${patternIndex}:${color.h}:${color.s}:${color.b}:${color.c}:${color.colorize ? 1 : 0}`;
  return getColorizedSprite(cacheKey, sprite, { ...color, colorize: true });
}

/** Get the wall color hex string */
export function getWallColor(): string {
  return WALL_COLOR;
}
