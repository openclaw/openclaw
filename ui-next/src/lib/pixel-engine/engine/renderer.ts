/**
 * Canvas renderer for the game world.
 *
 * Editor-specific rendering (grid overlay, ghost preview, selection highlight,
 * delete/rotate buttons) has been removed. This renderer handles:
 * - Floor/wall tile rendering
 * - Z-sorted furniture + character rendering
 * - Matrix spawn/despawn effects
 * - Speech bubbles
 */

import {
  TILE_SIZE,
  CHARACTER_SITTING_OFFSET_PX,
  CHARACTER_Z_SORT_OFFSET,
  OUTLINE_Z_SORT_OFFSET,
  SELECTED_OUTLINE_ALPHA,
  HOVERED_OUTLINE_ALPHA,
  BUBBLE_FADE_DURATION_SEC,
  BUBBLE_SITTING_OFFSET_PX,
  BUBBLE_VERTICAL_OFFSET_PX,
  FALLBACK_FLOOR_COLOR,
} from "../constants.js";
import { getColorizedFloorSprite, hasFloorSprites, getWallColor } from "../floor-tiles.js";
import { getCachedSprite, getOutlineSprite } from "../sprites/sprite-cache.js";
import {
  getCharacterSprites,
  BUBBLE_PERMISSION_SPRITE,
  BUBBLE_WAITING_SPRITE,
} from "../sprites/sprite-data.js";
import { TileType, CharacterState } from "../types.js";
import type {
  TileType as TileTypeVal,
  FurnitureInstance,
  Character,
  FloorColor,
} from "../types.js";
import { getWallInstances, wallColorToHex } from "../wall-tiles.js";
import { getCharacterSprite } from "./characters.js";
import { renderMatrixEffect } from "./matrix-effect.js";

// -- Internal types -----------------------------------------------------------

interface ZDrawable {
  zY: number;
  draw: (ctx: CanvasRenderingContext2D) => void;
}

// -- Tile rendering -----------------------------------------------------------

export function renderTileGrid(
  ctx: CanvasRenderingContext2D,
  tileMap: TileTypeVal[][],
  offsetX: number,
  offsetY: number,
  zoom: number,
  tileColors?: Array<FloorColor | null>,
  cols?: number,
): void {
  const s = TILE_SIZE * zoom;
  const useSpriteFloors = hasFloorSprites();
  const tmRows = tileMap.length;
  const tmCols = tmRows > 0 ? tileMap[0].length : 0;
  const layoutCols = cols ?? tmCols;

  for (let r = 0; r < tmRows; r++) {
    for (let c = 0; c < tmCols; c++) {
      const tile = tileMap[r][c];

      if (tile === TileType.VOID) {
        continue;
      }

      if (tile === TileType.WALL || !useSpriteFloors) {
        if (tile === TileType.WALL) {
          const colorIdx = r * layoutCols + c;
          const wallColor = tileColors?.[colorIdx];
          ctx.fillStyle = wallColor ? wallColorToHex(wallColor) : getWallColor();
        } else {
          ctx.fillStyle = FALLBACK_FLOOR_COLOR;
        }
        ctx.fillRect(offsetX + c * s, offsetY + r * s, s, s);
        continue;
      }

      const colorIdx = r * layoutCols + c;
      const color = tileColors?.[colorIdx] ?? { h: 0, s: 0, b: 0, c: 0 };
      const sprite = getColorizedFloorSprite(tile, color);
      const cached = getCachedSprite(sprite, zoom);
      ctx.drawImage(cached, offsetX + c * s, offsetY + r * s);
    }
  }
}

// -- Scene rendering (z-sorted) -----------------------------------------------

export function renderScene(
  ctx: CanvasRenderingContext2D,
  furniture: FurnitureInstance[],
  characters: Character[],
  offsetX: number,
  offsetY: number,
  zoom: number,
  selectedAgentId: number | null,
  hoveredAgentId: number | null,
): void {
  const drawables: ZDrawable[] = [];

  // Furniture
  for (const f of furniture) {
    const cached = getCachedSprite(f.sprite, zoom);
    const fx = offsetX + f.x * zoom;
    const fy = offsetY + f.y * zoom;
    drawables.push({
      zY: f.zY,
      draw: (c) => {
        c.drawImage(cached, fx, fy);
      },
    });
  }

  // Characters
  for (const ch of characters) {
    const sprites = getCharacterSprites(ch.palette, ch.hueShift);
    const spriteData = getCharacterSprite(ch, sprites);
    const cached = getCachedSprite(spriteData, zoom);
    const sittingOffset = ch.state === CharacterState.TYPE ? CHARACTER_SITTING_OFFSET_PX : 0;
    const drawX = Math.round(offsetX + ch.x * zoom - cached.width / 2);
    const drawY = Math.round(offsetY + (ch.y + sittingOffset) * zoom - cached.height);
    const charZY = ch.y + TILE_SIZE / 2 + CHARACTER_Z_SORT_OFFSET;

    // Matrix effect: per-pixel rendering
    if (ch.matrixEffect) {
      const mDrawX = drawX;
      const mDrawY = drawY;
      const mSpriteData = spriteData;
      const mCh = ch;
      drawables.push({
        zY: charZY,
        draw: (c) => {
          renderMatrixEffect(c, mCh, mSpriteData, mDrawX, mDrawY, zoom);
        },
      });
      continue;
    }

    // Selection/hover outline
    const isSelected = selectedAgentId !== null && ch.id === selectedAgentId;
    const isHovered = hoveredAgentId !== null && ch.id === hoveredAgentId;
    if (isSelected || isHovered) {
      const outlineAlpha = isSelected ? SELECTED_OUTLINE_ALPHA : HOVERED_OUTLINE_ALPHA;
      const outlineData = getOutlineSprite(spriteData);
      const outlineCached = getCachedSprite(outlineData, zoom);
      const olDrawX = drawX - zoom;
      const olDrawY = drawY - zoom;
      drawables.push({
        zY: charZY - OUTLINE_Z_SORT_OFFSET,
        draw: (c) => {
          c.save();
          c.globalAlpha = outlineAlpha;
          c.drawImage(outlineCached, olDrawX, olDrawY);
          c.restore();
        },
      });
    }

    drawables.push({
      zY: charZY,
      draw: (c) => {
        c.drawImage(cached, drawX, drawY);
      },
    });
  }

  drawables.sort((a, b) => a.zY - b.zY);

  for (const d of drawables) {
    d.draw(ctx);
  }
}

// -- Speech bubbles -----------------------------------------------------------

export function renderBubbles(
  ctx: CanvasRenderingContext2D,
  characters: Character[],
  offsetX: number,
  offsetY: number,
  zoom: number,
): void {
  for (const ch of characters) {
    if (!ch.bubbleType) {
      continue;
    }

    const sprite =
      ch.bubbleType === "permission" ? BUBBLE_PERMISSION_SPRITE : BUBBLE_WAITING_SPRITE;

    let alpha = 1.0;
    if (ch.bubbleType === "waiting" && ch.bubbleTimer < BUBBLE_FADE_DURATION_SEC) {
      alpha = ch.bubbleTimer / BUBBLE_FADE_DURATION_SEC;
    }

    const cached = getCachedSprite(sprite, zoom);
    const sittingOff = ch.state === CharacterState.TYPE ? BUBBLE_SITTING_OFFSET_PX : 0;
    const bubbleX = Math.round(offsetX + ch.x * zoom - cached.width / 2);
    const bubbleY = Math.round(
      offsetY + (ch.y + sittingOff - BUBBLE_VERTICAL_OFFSET_PX) * zoom - cached.height - 1 * zoom,
    );

    ctx.save();
    if (alpha < 1.0) {
      ctx.globalAlpha = alpha;
    }
    ctx.drawImage(cached, bubbleX, bubbleY);
    ctx.restore();
  }
}

// -- Frame orchestration ------------------------------------------------------

/**
 * Render a complete frame: tiles, furniture, characters, bubbles.
 * Returns viewport offsets for hit testing.
 */
export function renderFrame(
  ctx: CanvasRenderingContext2D,
  canvasWidth: number,
  canvasHeight: number,
  tileMap: TileTypeVal[][],
  furniture: FurnitureInstance[],
  characters: Character[],
  zoom: number,
  panX: number,
  panY: number,
  selectedAgentId: number | null,
  hoveredAgentId: number | null,
  tileColors?: Array<FloorColor | null>,
  layoutCols?: number,
  layoutRows?: number,
): { offsetX: number; offsetY: number } {
  ctx.clearRect(0, 0, canvasWidth, canvasHeight);

  const cols = layoutCols ?? (tileMap.length > 0 ? tileMap[0].length : 0);
  const rows = layoutRows ?? tileMap.length;

  // Center map in viewport + pan offset
  const mapW = cols * TILE_SIZE * zoom;
  const mapH = rows * TILE_SIZE * zoom;
  const offsetX = Math.floor((canvasWidth - mapW) / 2) + Math.round(panX);
  const offsetY = Math.floor((canvasHeight - mapH) / 2) + Math.round(panY);

  // Floor + wall base
  renderTileGrid(ctx, tileMap, offsetX, offsetY, zoom, tileColors, layoutCols);

  // Wall sprites + furniture + characters (z-sorted)
  const wallInstances = getWallInstances(
    // Flatten tileMap for wall instance generation
    tileMap.flat(),
    cols,
    rows,
  );
  const allFurniture = wallInstances.length > 0 ? [...wallInstances, ...furniture] : furniture;

  renderScene(
    ctx,
    allFurniture,
    characters,
    offsetX,
    offsetY,
    zoom,
    selectedAgentId,
    hoveredAgentId,
  );

  // Speech bubbles (always on top)
  renderBubbles(ctx, characters, offsetX, offsetY, zoom);

  return { offsetX, offsetY };
}
