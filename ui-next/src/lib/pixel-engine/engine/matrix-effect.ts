/**
 * Matrix-style digital rain effect for character spawn/despawn animations.
 */

import {
  MATRIX_EFFECT_DURATION_SEC,
  MATRIX_TRAIL_LENGTH,
  MATRIX_SPRITE_COLS,
  MATRIX_SPRITE_ROWS,
  MATRIX_FLICKER_FPS,
  MATRIX_FLICKER_VISIBILITY_THRESHOLD,
  MATRIX_COLUMN_STAGGER_RANGE,
  MATRIX_HEAD_COLOR,
  MATRIX_TRAIL_OVERLAY_ALPHA,
  MATRIX_TRAIL_EMPTY_ALPHA,
  MATRIX_TRAIL_MID_THRESHOLD,
  MATRIX_TRAIL_DIM_THRESHOLD,
} from "../constants.js";
import type { Character, SpriteData } from "../types.js";

/** Generate per-column random seeds for staggered rain timing */
export function generateSeeds(): number[] {
  const seeds: number[] = [];
  for (let i = 0; i < MATRIX_SPRITE_COLS; i++) {
    seeds.push(Math.random());
  }
  return seeds;
}

export { generateSeeds as matrixEffectSeeds };

/**
 * Hash-based flicker: ~70% of pixels visible at any moment for shimmer effect.
 */
function flickerVisible(col: number, row: number, time: number): boolean {
  const frame = Math.floor(time * MATRIX_FLICKER_FPS);
  // Simple hash to create pseudo-random flicker per pixel per frame
  const hash = ((col * 73856093) ^ (row * 19349663) ^ (frame * 83492791)) & 0xff;
  return hash < MATRIX_FLICKER_VISIBILITY_THRESHOLD;
}

/**
 * Render the matrix spawn/despawn effect for a character.
 */
export function renderMatrixEffect(
  ctx: CanvasRenderingContext2D,
  ch: Character,
  spriteData: SpriteData,
  drawX: number,
  drawY: number,
  zoom: number,
): void {
  const progress = ch.matrixEffectTimer / MATRIX_EFFECT_DURATION_SEC;
  const isSpawn = ch.matrixEffect === "spawn";
  const time = ch.matrixEffectTimer;
  const totalSweep = MATRIX_SPRITE_ROWS + MATRIX_TRAIL_LENGTH;

  for (let col = 0; col < MATRIX_SPRITE_COLS; col++) {
    const stagger = (ch.matrixEffectSeeds[col] ?? 0) * MATRIX_COLUMN_STAGGER_RANGE;
    const colProgress = Math.max(
      0,
      Math.min(1, (progress - stagger) / (1 - MATRIX_COLUMN_STAGGER_RANGE)),
    );
    const headRow = colProgress * totalSweep;

    for (let row = 0; row < MATRIX_SPRITE_ROWS; row++) {
      const pixel = spriteData[row]?.[col];
      const hasPixel = pixel && pixel !== "";
      const distFromHead = headRow - row;
      const px = drawX + col * zoom;
      const py = drawY + row * zoom;

      if (isSpawn) {
        if (distFromHead < 0) {
          // Above head: invisible
          continue;
        } else if (distFromHead < 1) {
          // Head position: bright green-white
          ctx.fillStyle = MATRIX_HEAD_COLOR;
          ctx.fillRect(px, py, zoom, zoom);
        } else if (distFromHead < MATRIX_TRAIL_LENGTH) {
          // Trail zone: original pixel with green overlay, or just green
          const trailPos = distFromHead / MATRIX_TRAIL_LENGTH;
          if (hasPixel) {
            ctx.fillStyle = pixel;
            ctx.fillRect(px, py, zoom, zoom);
            const greenAlpha = (1 - trailPos) * MATRIX_TRAIL_OVERLAY_ALPHA;
            if (flickerVisible(col, row, time)) {
              ctx.fillStyle = `rgba(0, 255, 65, ${greenAlpha})`;
              ctx.fillRect(px, py, zoom, zoom);
            }
          } else {
            if (flickerVisible(col, row, time)) {
              const alpha = (1 - trailPos) * MATRIX_TRAIL_EMPTY_ALPHA;
              ctx.fillStyle =
                trailPos < MATRIX_TRAIL_MID_THRESHOLD
                  ? `rgba(0, 255, 65, ${alpha})`
                  : trailPos < MATRIX_TRAIL_DIM_THRESHOLD
                    ? `rgba(0, 170, 40, ${alpha})`
                    : `rgba(0, 85, 20, ${alpha})`;
              ctx.fillRect(px, py, zoom, zoom);
            }
          }
        } else {
          // Below trail: normal pixel
          if (hasPixel) {
            ctx.fillStyle = pixel;
            ctx.fillRect(px, py, zoom, zoom);
          }
        }
      } else {
        // Despawn mode
        if (distFromHead < 0) {
          // Above head: still visible
          if (hasPixel) {
            ctx.fillStyle = pixel;
            ctx.fillRect(px, py, zoom, zoom);
          }
        } else if (distFromHead < 1) {
          // Head position: bright green-white
          ctx.fillStyle = MATRIX_HEAD_COLOR;
          ctx.fillRect(px, py, zoom, zoom);
        } else if (distFromHead < MATRIX_TRAIL_LENGTH) {
          // Trail: fading green only
          if (flickerVisible(col, row, time)) {
            const trailPos = distFromHead / MATRIX_TRAIL_LENGTH;
            const alpha = (1 - trailPos) * MATRIX_TRAIL_EMPTY_ALPHA;
            ctx.fillStyle =
              trailPos < MATRIX_TRAIL_MID_THRESHOLD
                ? `rgba(0, 255, 65, ${alpha})`
                : trailPos < MATRIX_TRAIL_DIM_THRESHOLD
                  ? `rgba(0, 170, 40, ${alpha})`
                  : `rgba(0, 85, 20, ${alpha})`;
            ctx.fillRect(px, py, zoom, zoom);
          }
        }
        // Below trail: consumed, invisible
      }
    }
  }
}
