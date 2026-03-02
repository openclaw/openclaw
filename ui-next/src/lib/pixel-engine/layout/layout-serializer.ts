/**
 * Layout serialization, tile map conversion, furniture instancing, and seat management.
 */

import { getColorizedSprite } from "../colorize.js";
import { DEFAULT_COLS, DEFAULT_ROWS, TILE_SIZE } from "../constants.js";
import { TileType, FurnitureType, Direction } from "../types.js";
import type {
  TileType as TileTypeVal,
  OfficeLayout,
  PlacedFurniture,
  Seat,
  FurnitureInstance,
  FloorColor,
} from "../types.js";
import { getCatalogEntry } from "./furniture-catalog.js";

// -- Default room colors ------------------------------------------------------

const DEFAULT_LEFT_ROOM_COLOR: FloorColor = { h: 35, s: 30, b: 15, c: 0 };
const DEFAULT_RIGHT_ROOM_COLOR: FloorColor = { h: 25, s: 45, b: 5, c: 10 };
const DEFAULT_CARPET_COLOR: FloorColor = { h: 280, s: 40, b: -5, c: 0 };
const DEFAULT_DOORWAY_COLOR: FloorColor = { h: 35, s: 25, b: 10, c: 0 };

// -- Tile map conversion ------------------------------------------------------

/** Convert flat layout tile array into a 2D grid */
export function layoutToTileMap(layout: OfficeLayout): TileTypeVal[][] {
  const map: TileTypeVal[][] = [];
  for (let r = 0; r < layout.rows; r++) {
    const row: TileTypeVal[] = [];
    for (let c = 0; c < layout.cols; c++) {
      row.push(layout.tiles[r * layout.cols + c]);
    }
    map.push(row);
  }
  return map;
}

// -- Furniture instances ------------------------------------------------------

/** Convert placed furniture into renderable FurnitureInstance[] */
export function layoutToFurnitureInstances(furniture: PlacedFurniture[]): FurnitureInstance[] {
  // Pre-compute desk z-values for surface items
  const deskZByTile = new Map<string, number>();
  for (const item of furniture) {
    const entry = getCatalogEntry(item.type);
    if (!entry || !entry.isDesk) {
      continue;
    }
    const deskZY = item.row * TILE_SIZE + entry.sprite.length;
    for (let dr = 0; dr < entry.footprintH; dr++) {
      for (let dc = 0; dc < entry.footprintW; dc++) {
        const key = `${item.col + dc},${item.row + dr}`;
        const prev = deskZByTile.get(key);
        if (prev === undefined || deskZY > prev) {
          deskZByTile.set(key, deskZY);
        }
      }
    }
  }

  const instances: FurnitureInstance[] = [];
  for (const item of furniture) {
    const entry = getCatalogEntry(item.type);
    if (!entry) {
      continue;
    }
    const x = item.col * TILE_SIZE;
    const y = item.row * TILE_SIZE;
    const spriteH = entry.sprite.length;
    let zY = y + spriteH;

    // Chair z-sorting: ensure characters sitting on chairs render correctly
    if (entry.category === "chairs") {
      if (entry.orientation === "back") {
        zY = (item.row + 1) * TILE_SIZE + 1;
      } else {
        zY = (item.row + 1) * TILE_SIZE;
      }
    }

    // Surface items sit on top of desks
    if (entry.canPlaceOnSurfaces) {
      for (let dr = 0; dr < entry.footprintH; dr++) {
        for (let dc = 0; dc < entry.footprintW; dc++) {
          const deskZ = deskZByTile.get(`${item.col + dc},${item.row + dr}`);
          if (deskZ !== undefined && deskZ + 0.5 > zY) {
            zY = deskZ + 0.5;
          }
        }
      }
    }

    let sprite = entry.sprite;
    if (item.color) {
      const { h, s, b: bv, c: cv } = item.color;
      sprite = getColorizedSprite(
        `furn-${item.type}-${h}-${s}-${bv}-${cv}-${item.color.colorize ? 1 : 0}`,
        entry.sprite,
        item.color,
      );
    }

    instances.push({ sprite, x, y, zY });
  }
  return instances;
}

// -- Blocked tiles ------------------------------------------------------------

/** Get tiles blocked by furniture (for pathfinding) */
export function getBlockedTiles(
  furniture: PlacedFurniture[],
  excludeTiles?: Set<string>,
): Set<string> {
  const tiles = new Set<string>();
  for (const item of furniture) {
    const entry = getCatalogEntry(item.type);
    if (!entry) {
      continue;
    }
    const bgRows = entry.backgroundTiles || 0;
    for (let dr = 0; dr < entry.footprintH; dr++) {
      if (dr < bgRows) {
        continue;
      }
      for (let dc = 0; dc < entry.footprintW; dc++) {
        const key = `${item.col + dc},${item.row + dr}`;
        if (excludeTiles && excludeTiles.has(key)) {
          continue;
        }
        tiles.add(key);
      }
    }
  }
  return tiles;
}

/** Get tiles blocked for placement purposes (excludes a specific furniture item) */
export function getPlacementBlockedTiles(
  furniture: PlacedFurniture[],
  excludeUid?: string,
): Set<string> {
  const tiles = new Set<string>();
  for (const item of furniture) {
    if (item.uid === excludeUid) {
      continue;
    }
    const entry = getCatalogEntry(item.type);
    if (!entry) {
      continue;
    }
    const bgRows = entry.backgroundTiles || 0;
    for (let dr = 0; dr < entry.footprintH; dr++) {
      if (dr < bgRows) {
        continue;
      }
      for (let dc = 0; dc < entry.footprintW; dc++) {
        tiles.add(`${item.col + dc},${item.row + dr}`);
      }
    }
  }
  return tiles;
}

// -- Seats --------------------------------------------------------------------

function orientationToFacing(orientation: string): Direction {
  switch (orientation) {
    case "front":
      return Direction.DOWN;
    case "back":
      return Direction.UP;
    case "left":
      return Direction.LEFT;
    case "right":
      return Direction.RIGHT;
    default:
      return Direction.DOWN;
  }
}

/** Extract seat positions from chair furniture */
export function layoutToSeats(furniture: PlacedFurniture[]): Map<string, Seat> {
  const seats = new Map<string, Seat>();

  // Build desk tile lookup for auto-facing
  const deskTiles = new Set<string>();
  for (const item of furniture) {
    const entry = getCatalogEntry(item.type);
    if (!entry || !entry.isDesk) {
      continue;
    }
    for (let dr = 0; dr < entry.footprintH; dr++) {
      for (let dc = 0; dc < entry.footprintW; dc++) {
        deskTiles.add(`${item.col + dc},${item.row + dr}`);
      }
    }
  }

  const dirs: Array<{ dc: number; dr: number; facing: Direction }> = [
    { dc: 0, dr: -1, facing: Direction.UP },
    { dc: 0, dr: 1, facing: Direction.DOWN },
    { dc: -1, dr: 0, facing: Direction.LEFT },
    { dc: 1, dr: 0, facing: Direction.RIGHT },
  ];

  for (const item of furniture) {
    const entry = getCatalogEntry(item.type);
    if (!entry || entry.category !== "chairs") {
      continue;
    }

    let seatCount = 0;
    for (let dr = 0; dr < entry.footprintH; dr++) {
      for (let dc = 0; dc < entry.footprintW; dc++) {
        const tileCol = item.col + dc;
        const tileRow = item.row + dr;

        let facingDir: Direction = Direction.DOWN;
        if (entry.orientation) {
          facingDir = orientationToFacing(entry.orientation);
        } else {
          for (const d of dirs) {
            if (deskTiles.has(`${tileCol + d.dc},${tileRow + d.dr}`)) {
              facingDir = d.facing;
              break;
            }
          }
        }

        const seatUid = seatCount === 0 ? item.uid : `${item.uid}:${seatCount}`;
        seats.set(seatUid, {
          uid: seatUid,
          seatCol: tileCol,
          seatRow: tileRow,
          facingDir,
          assigned: false,
        });
        seatCount++;
      }
    }
  }

  return seats;
}

/** Get the set of tile keys occupied by seats */
export function getSeatTiles(seats: Map<string, Seat>): Set<string> {
  const tiles = new Set<string>();
  for (const seat of seats.values()) {
    tiles.add(`${seat.seatCol},${seat.seatRow}`);
  }
  return tiles;
}

// -- Default layout -----------------------------------------------------------

/** Create the default two-room office layout */
export function createDefaultLayout(): OfficeLayout {
  const W = TileType.WALL;
  const F1 = TileType.FLOOR_1;
  const F2 = TileType.FLOOR_2;
  const F3 = TileType.FLOOR_3;
  const F4 = TileType.FLOOR_4;

  const tiles: TileTypeVal[] = [];
  const tileColors: Array<FloorColor | null> = [];

  for (let r = 0; r < DEFAULT_ROWS; r++) {
    for (let c = 0; c < DEFAULT_COLS; c++) {
      if (r === 0 || r === DEFAULT_ROWS - 1) {
        tiles.push(W);
        tileColors.push(null);
        continue;
      }
      if (c === 0 || c === DEFAULT_COLS - 1) {
        tiles.push(W);
        tileColors.push(null);
        continue;
      }
      if (c === 10) {
        if (r >= 4 && r <= 6) {
          tiles.push(F4);
          tileColors.push(DEFAULT_DOORWAY_COLOR);
        } else {
          tiles.push(W);
          tileColors.push(null);
        }
        continue;
      }
      if (c >= 15 && c <= 18 && r >= 7 && r <= 9) {
        tiles.push(F3);
        tileColors.push(DEFAULT_CARPET_COLOR);
        continue;
      }
      if (c < 10) {
        tiles.push(F1);
        tileColors.push(DEFAULT_LEFT_ROOM_COLOR);
      } else {
        tiles.push(F2);
        tileColors.push(DEFAULT_RIGHT_ROOM_COLOR);
      }
    }
  }

  const furniture: PlacedFurniture[] = [
    { uid: "desk-left", type: FurnitureType.DESK, col: 4, row: 3 },
    { uid: "desk-right", type: FurnitureType.DESK, col: 13, row: 3 },
    { uid: "bookshelf-1", type: FurnitureType.BOOKSHELF, col: 1, row: 5 },
    { uid: "plant-left", type: FurnitureType.PLANT, col: 1, row: 1 },
    { uid: "cooler-1", type: FurnitureType.COOLER, col: 17, row: 7 },
    { uid: "plant-right", type: FurnitureType.PLANT, col: 18, row: 1 },
    { uid: "whiteboard-1", type: FurnitureType.WHITEBOARD, col: 15, row: 0 },
    { uid: "chair-l-top", type: FurnitureType.CHAIR, col: 4, row: 2 },
    { uid: "chair-l-bottom", type: FurnitureType.CHAIR, col: 5, row: 5 },
    { uid: "chair-l-left", type: FurnitureType.CHAIR, col: 3, row: 4 },
    { uid: "chair-l-right", type: FurnitureType.CHAIR, col: 6, row: 3 },
    { uid: "chair-r-top", type: FurnitureType.CHAIR, col: 13, row: 2 },
    { uid: "chair-r-bottom", type: FurnitureType.CHAIR, col: 14, row: 5 },
    { uid: "chair-r-left", type: FurnitureType.CHAIR, col: 12, row: 4 },
    { uid: "chair-r-right", type: FurnitureType.CHAIR, col: 15, row: 3 },
  ];

  return { version: 1, cols: DEFAULT_COLS, rows: DEFAULT_ROWS, tiles, tileColors, furniture };
}

// -- Serialization ------------------------------------------------------------

/** Serialize a layout to JSON string */
export function serializeLayout(layout: OfficeLayout): string {
  return JSON.stringify(layout);
}

/** Deserialize a layout from JSON string, with color migration */
export function deserializeLayout(json: string): OfficeLayout | null {
  try {
    const obj = JSON.parse(json);
    if (obj && obj.version === 1 && Array.isArray(obj.tiles) && Array.isArray(obj.furniture)) {
      return migrateLayout(obj as OfficeLayout);
    }
  } catch {
    /* ignore parse errors */
  }
  return null;
}

/** Migrate layout colors if tileColors array is missing */
export function migrateLayoutColors(layout: OfficeLayout): OfficeLayout {
  return migrateLayout(layout);
}

function migrateLayout(layout: OfficeLayout): OfficeLayout {
  if (layout.tileColors && layout.tileColors.length === layout.tiles.length) {
    return layout;
  }

  const tileColors: Array<FloorColor | null> = [];
  for (const tile of layout.tiles) {
    switch (tile) {
      case 0:
        tileColors.push(null);
        break;
      case 1:
        tileColors.push(DEFAULT_LEFT_ROOM_COLOR);
        break;
      case 2:
        tileColors.push(DEFAULT_RIGHT_ROOM_COLOR);
        break;
      case 3:
        tileColors.push(DEFAULT_CARPET_COLOR);
        break;
      case 4:
        tileColors.push(DEFAULT_DOORWAY_COLOR);
        break;
      default:
        tileColors.push(tile > 0 ? { h: 0, s: 0, b: 0, c: 0 } : null);
    }
  }

  return { ...layout, tileColors };
}
