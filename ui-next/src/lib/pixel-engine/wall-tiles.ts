/**
 * Wall tile auto-tiling system using bitmask-based neighbor detection.
 *
 * Builds a 4-bit neighbor mask (N=1, E=2, S=4, W=8) and selects
 * the corresponding wall sprite from a preloaded array of 16 variants.
 */

import { getColorizedSprite, clearColorizeCache } from "./colorize.js";
import { TILE_SIZE } from "./constants.js";
import type {
  SpriteData,
  FloorColor,
  TileType as TileTypeValue,
  FurnitureInstance,
} from "./types.js";
import { TileType } from "./types.js";

/** Bitmask flags for cardinal neighbors */
const NORTH = 1;
const EAST = 2;
const SOUTH = 4;
const WEST = 8;

/** Module-level array of wall sprites (16 variants by neighbor mask) */
let wallSprites: SpriteData[] = [];

/** Initialize wall sprites from loaded image data and clear cache */
export function setWallSprites(sprites: SpriteData[]): void {
  wallSprites = sprites;
  clearColorizeCache();
}

/**
 * Build a 4-bit neighbor mask for a wall tile at (col, row).
 * Out-of-bounds positions are treated as non-walls.
 */
function getNeighborMask(
  tiles: TileTypeValue[],
  cols: number,
  rows: number,
  col: number,
  row: number,
): number {
  let mask = 0;
  // North
  if (row > 0 && tiles[(row - 1) * cols + col] === TileType.WALL) {
    mask |= NORTH;
  }
  // East
  if (col < cols - 1 && tiles[row * cols + col + 1] === TileType.WALL) {
    mask |= EAST;
  }
  // South
  if (row < rows - 1 && tiles[(row + 1) * cols + col] === TileType.WALL) {
    mask |= SOUTH;
  }
  // West
  if (col > 0 && tiles[row * cols + col - 1] === TileType.WALL) {
    mask |= WEST;
  }
  return mask;
}

/**
 * Get wall sprite and Y offset for a tile based on its neighbors.
 * Sprite is anchored at the tile's bottom edge, taller sprites extend upward.
 */
export function getWallSprite(
  tiles: TileTypeValue[],
  cols: number,
  rows: number,
  col: number,
  row: number,
): { sprite: SpriteData; yOffset: number } | null {
  if (wallSprites.length === 0) {
    return null;
  }
  const mask = getNeighborMask(tiles, cols, rows, col, row);
  const sprite = wallSprites[mask];
  if (!sprite) {
    return null;
  }
  // Y offset: anchor bottom of sprite to bottom of tile
  const yOffset = TILE_SIZE - sprite.length;
  return { sprite, yOffset };
}

/**
 * Get a colorized wall sprite, using cache for performance.
 */
export function getColorizedWallSprite(
  tiles: TileTypeValue[],
  cols: number,
  rows: number,
  col: number,
  row: number,
  color: FloorColor,
): { sprite: SpriteData; yOffset: number } | null {
  if (wallSprites.length === 0) {
    return null;
  }
  const mask = getNeighborMask(tiles, cols, rows, col, row);
  const sprite = wallSprites[mask];
  if (!sprite) {
    return null;
  }

  const cacheKey = `wall:${mask}:${color.h}:${color.s}:${color.b}:${color.c}:${color.colorize ? 1 : 0}`;
  const colorized = getColorizedSprite(cacheKey, sprite, color);
  const yOffset = TILE_SIZE - colorized.length;
  return { sprite: colorized, yOffset };
}

/**
 * Convert all wall tiles into FurnitureInstance objects for z-sorting with other entities.
 */
export function getWallInstances(
  tiles: TileTypeValue[],
  cols: number,
  rows: number,
  wallColor?: FloorColor,
): FurnitureInstance[] {
  const instances: FurnitureInstance[] = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      if (tiles[row * cols + col] !== TileType.WALL) {
        continue;
      }
      const result = wallColor
        ? getColorizedWallSprite(tiles, cols, rows, col, row, wallColor)
        : getWallSprite(tiles, cols, rows, col, row);
      if (!result) {
        continue;
      }
      const x = col * TILE_SIZE;
      const y = row * TILE_SIZE + result.yOffset;
      instances.push({
        sprite: result.sprite,
        x,
        y,
        zY: (row + 1) * TILE_SIZE, // bottom edge for depth sorting
      });
    }
  }
  return instances;
}

/**
 * Convert FloorColor parameters to a hex color string.
 * Starts from 50% gray and applies HSL colorization.
 */
export function wallColorToHex(color: FloorColor): string {
  // Start from 50% gray
  const baseL = 0.5;
  const h = color.h;
  const s = color.s / 100;

  // Apply brightness
  let l = baseL + color.b / 200;

  // Apply contrast
  if (color.c !== 0) {
    const factor = (100 + color.c) / 100;
    l = 0.5 + (l - 0.5) * factor;
  }

  l = Math.max(0, Math.min(1, l));

  // HSL to hex
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r1 = 0,
    g1 = 0,
    b1 = 0;

  if (hp < 1) {
    r1 = c;
    g1 = x;
  } else if (hp < 2) {
    r1 = x;
    g1 = c;
  } else if (hp < 3) {
    g1 = c;
    b1 = x;
  } else if (hp < 4) {
    g1 = x;
    b1 = c;
  } else if (hp < 5) {
    r1 = x;
    b1 = c;
  } else {
    r1 = c;
    b1 = x;
  }

  const m = l - c / 2;
  const r = Math.round(Math.max(0, Math.min(255, (r1 + m) * 255)));
  const g = Math.round(Math.max(0, Math.min(255, (g1 + m) * 255)));
  const b = Math.round(Math.max(0, Math.min(255, (b1 + m) * 255)));

  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
}
