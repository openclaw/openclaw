/**
 * Matrix-themed zone layouts for the Visualize page.
 *
 * Defines a multi-zone world with themed areas connected by corridors.
 * Each zone houses a group of agents with zone-specific floor coloring.
 */

import { TileType, FurnitureType } from "../types.js";
import type {
  TileType as TileTypeVal,
  OfficeLayout,
  PlacedFurniture,
  FloorColor,
} from "../types.js";

// -- Zone Definitions ---------------------------------------------------------

export interface ZoneDefinition {
  id: string;
  name: string;
  description: string;
  /** Hue for floor tint (0-360) */
  hue: number;
  /** Grid position (top-left corner of zone) */
  col: number;
  row: number;
  /** Zone dimensions in tiles */
  width: number;
  height: number;
  /** CSS color for UI labels */
  color: string;
}

export const ZONE_DEFINITIONS: ZoneDefinition[] = [
  {
    id: "construct",
    name: "The Construct",
    description: "Central loading program",
    hue: 0,
    col: 12,
    row: 3,
    width: 8,
    height: 7,
    color: "#ffffff",
  },
  {
    id: "machine-city",
    name: "Machine City",
    description: "Heart of the machines",
    hue: 120,
    col: 22,
    row: 2,
    width: 9,
    height: 8,
    color: "#00ff41",
  },
  {
    id: "zion",
    name: "Zion",
    description: "Last human city",
    hue: 220,
    col: 1,
    row: 2,
    width: 9,
    height: 8,
    color: "#4488ff",
  },
  {
    id: "broadcast",
    name: "The Broadcast",
    description: "Signal transmission hub",
    hue: 280,
    col: 8,
    row: 13,
    width: 16,
    height: 6,
    color: "#cc66ff",
  },
];

// -- Zone-Agent Mapping -------------------------------------------------------

export interface ZoneAgentEntry {
  agentName: string;
  zone: string;
  /** Deterministic palette index */
  palette: number;
  /** Hue shift for zone coloring */
  hueShift: number;
}

/**
 * Map of agent names to their zone assignments.
 * Keys are agent display names; values are zone metadata.
 */
export const ZONE_AGENT_MAP: Record<string, ZoneAgentEntry> = {
  Operator1: { agentName: "Operator1", zone: "construct", palette: 0, hueShift: 0 },
  Neo: { agentName: "Neo", zone: "machine-city", palette: 1, hueShift: 45 },
  Tank: { agentName: "Tank", zone: "machine-city", palette: 2, hueShift: 45 },
  Dozer: { agentName: "Dozer", zone: "machine-city", palette: 3, hueShift: 45 },
  Mouse: { agentName: "Mouse", zone: "machine-city", palette: 4, hueShift: 45 },
  Trinity: { agentName: "Trinity", zone: "zion", palette: 0, hueShift: 90 },
  Oracle: { agentName: "Oracle", zone: "zion", palette: 1, hueShift: 90 },
  Seraph: { agentName: "Seraph", zone: "zion", palette: 2, hueShift: 90 },
  Zee: { agentName: "Zee", zone: "zion", palette: 3, hueShift: 90 },
  Morpheus: { agentName: "Morpheus", zone: "broadcast", palette: 0, hueShift: 135 },
  Niobe: { agentName: "Niobe", zone: "broadcast", palette: 1, hueShift: 135 },
  Switch: { agentName: "Switch", zone: "broadcast", palette: 2, hueShift: 135 },
  Rex: { agentName: "Rex", zone: "broadcast", palette: 3, hueShift: 135 },
};

/** Get zone assignment for an agent name, or default to construct */
export function getAgentZone(agentName: string): ZoneAgentEntry {
  return (
    ZONE_AGENT_MAP[agentName] ?? {
      agentName,
      zone: "construct",
      palette: hashString(agentName) % 6,
      hueShift: 0,
    }
  );
}

/** Get zone definition by id */
export function getZoneById(zoneId: string): ZoneDefinition | undefined {
  return ZONE_DEFINITIONS.find((z) => z.id === zoneId);
}

// -- Layout Builder -----------------------------------------------------------

const COLS = 32;
const ROWS = 20;

/** Zone floor color configs */
const ZONE_COLORS: Record<string, FloorColor> = {
  construct: { h: 0, s: 0, b: 30, c: 10, colorize: true },
  "machine-city": { h: 120, s: 40, b: 10, c: 5, colorize: true },
  zion: { h: 220, s: 35, b: 5, c: 5, colorize: true },
  broadcast: { h: 280, s: 35, b: 5, c: 5, colorize: true },
  corridor: { h: 0, s: 0, b: -10, c: 0 },
};

function hashString(s: string): number {
  let hash = 0;
  for (let i = 0; i < s.length; i++) {
    hash = (hash * 31 + s.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

/**
 * Build the Matrix world layout.
 *
 * Grid is 32x20 with 4 zones connected by corridors:
 *   - Zion (left, rows 2-9)
 *   - The Construct (center, rows 3-9)
 *   - Machine City (right, rows 2-9)
 *   - The Broadcast (bottom, rows 13-18)
 *   - Corridors connect all zones
 */
function buildWorldLayout(): OfficeLayout {
  const W = TileType.WALL;
  const F1 = TileType.FLOOR_1;
  const V = TileType.VOID;

  // Initialize all tiles as void
  const tiles: TileTypeVal[] = Array.from({ length: COLS * ROWS }, () => V);
  const tileColors: Array<FloorColor | null> = Array.from({ length: COLS * ROWS }, () => null);

  // Helper to fill a rectangular zone
  function fillZone(
    zoneCol: number,
    zoneRow: number,
    w: number,
    h: number,
    zoneId: string,
    wallBorder = true,
  ) {
    const color = ZONE_COLORS[zoneId] ?? ZONE_COLORS.corridor;
    for (let r = 0; r < h; r++) {
      for (let c = 0; c < w; c++) {
        const gr = zoneRow + r;
        const gc = zoneCol + c;
        if (gr < 0 || gr >= ROWS || gc < 0 || gc >= COLS) {
          continue;
        }
        const idx = gr * COLS + gc;
        if (wallBorder && (r === 0 || r === h - 1 || c === 0 || c === w - 1)) {
          tiles[idx] = W;
          tileColors[idx] = null;
        } else {
          tiles[idx] = F1;
          tileColors[idx] = color;
        }
      }
    }
  }

  // Helper to carve a corridor (overwrite walls with floor)
  function carveFloor(col: number, row: number, w: number, h: number, zoneId: string) {
    const color = ZONE_COLORS[zoneId] ?? ZONE_COLORS.corridor;
    for (let r = 0; r < h; r++) {
      for (let c = 0; c < w; c++) {
        const gr = row + r;
        const gc = col + c;
        if (gr < 0 || gr >= ROWS || gc < 0 || gc >= COLS) {
          continue;
        }
        const idx = gr * COLS + gc;
        tiles[idx] = F1;
        tileColors[idx] = color;
      }
    }
  }

  // 1. Build zone rooms
  // Zion: col 1, row 2, 9x8
  fillZone(1, 2, 9, 8, "zion");
  // The Construct: col 12, row 3, 8x7
  fillZone(12, 3, 8, 7, "construct");
  // Machine City: col 22, row 2, 9x8
  fillZone(22, 2, 9, 8, "machine-city");
  // The Broadcast: col 8, row 13, 16x6
  fillZone(8, 13, 16, 6, "broadcast");

  // 2. Carve corridors between zones
  // Zion -> Construct (horizontal, row 5-6)
  carveFloor(10, 5, 2, 2, "corridor");
  // Construct -> Machine City (horizontal, row 5-6)
  carveFloor(20, 5, 2, 2, "corridor");
  // Construct -> Broadcast (vertical, col 15-16)
  carveFloor(15, 10, 2, 3, "corridor");
  // Zion -> Broadcast (vertical, col 5-6)
  carveFloor(5, 10, 2, 3, "corridor");
  // Machine City -> Broadcast (vertical, col 25-26)
  carveFloor(20, 10, 2, 3, "corridor");

  // 3. Place furniture in each zone
  const furniture: PlacedFurniture[] = [
    // -- The Construct (center) --
    { uid: "c-desk-1", type: FurnitureType.DESK, col: 14, row: 5 },
    { uid: "c-chair-1", type: FurnitureType.CHAIR, col: 14, row: 4 },
    { uid: "c-pc-1", type: FurnitureType.PC, col: 15, row: 5 },
    { uid: "c-plant-1", type: FurnitureType.PLANT, col: 13, row: 4 },
    { uid: "c-lamp-1", type: FurnitureType.LAMP, col: 18, row: 4 },

    // -- Machine City (right, green) --
    { uid: "mc-desk-1", type: FurnitureType.DESK, col: 24, row: 4 },
    { uid: "mc-desk-2", type: FurnitureType.DESK, col: 24, row: 7 },
    { uid: "mc-chair-1", type: FurnitureType.CHAIR, col: 24, row: 3 },
    { uid: "mc-chair-2", type: FurnitureType.CHAIR, col: 26, row: 4 },
    { uid: "mc-chair-3", type: FurnitureType.CHAIR, col: 24, row: 6 },
    { uid: "mc-chair-4", type: FurnitureType.CHAIR, col: 26, row: 7 },
    { uid: "mc-pc-1", type: FurnitureType.PC, col: 25, row: 4 },
    { uid: "mc-pc-2", type: FurnitureType.PC, col: 25, row: 7 },
    { uid: "mc-bookshelf-1", type: FurnitureType.BOOKSHELF, col: 29, row: 3 },

    // -- Zion (left, blue) --
    { uid: "z-desk-1", type: FurnitureType.DESK, col: 3, row: 4 },
    { uid: "z-desk-2", type: FurnitureType.DESK, col: 3, row: 7 },
    { uid: "z-chair-1", type: FurnitureType.CHAIR, col: 3, row: 3 },
    { uid: "z-chair-2", type: FurnitureType.CHAIR, col: 5, row: 4 },
    { uid: "z-chair-3", type: FurnitureType.CHAIR, col: 3, row: 6 },
    { uid: "z-chair-4", type: FurnitureType.CHAIR, col: 5, row: 7 },
    { uid: "z-plant-1", type: FurnitureType.PLANT, col: 2, row: 3 },
    { uid: "z-cooler-1", type: FurnitureType.COOLER, col: 8, row: 3 },

    // -- The Broadcast (bottom, purple) --
    { uid: "b-desk-1", type: FurnitureType.DESK, col: 11, row: 15 },
    { uid: "b-desk-2", type: FurnitureType.DESK, col: 18, row: 15 },
    { uid: "b-chair-1", type: FurnitureType.CHAIR, col: 11, row: 14 },
    { uid: "b-chair-2", type: FurnitureType.CHAIR, col: 13, row: 15 },
    { uid: "b-chair-3", type: FurnitureType.CHAIR, col: 18, row: 14 },
    { uid: "b-chair-4", type: FurnitureType.CHAIR, col: 20, row: 15 },
    { uid: "b-whiteboard-1", type: FurnitureType.WHITEBOARD, col: 14, row: 13 },
    { uid: "b-plant-1", type: FurnitureType.PLANT, col: 9, row: 14 },
    { uid: "b-plant-2", type: FurnitureType.PLANT, col: 22, row: 14 },
  ];

  return {
    version: 1,
    cols: COLS,
    rows: ROWS,
    tiles,
    tileColors,
    furniture,
  };
}

/** The pre-built Matrix world layout. */
export const MATRIX_WORLD_LAYOUT: OfficeLayout = buildWorldLayout();
