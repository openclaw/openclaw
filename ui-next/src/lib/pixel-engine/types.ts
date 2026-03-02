/**
 * Core game types extracted from pixel-agents.
 * Editor-specific types (EditTool, undo stack, etc.) removed.
 */

export const TileType = {
  WALL: 0,
  FLOOR_1: 1,
  FLOOR_2: 2,
  FLOOR_3: 3,
  FLOOR_4: 4,
  FLOOR_5: 5,
  FLOOR_6: 6,
  FLOOR_7: 7,
  VOID: 8,
} as const;
export type TileType = (typeof TileType)[keyof typeof TileType];

/** Per-tile color settings for floor pattern colorization */
export interface FloorColor {
  /** Hue: 0-360 in colorize mode, -180 to +180 in adjust mode */
  h: number;
  /** Saturation: 0-100 in colorize mode, -100 to +100 in adjust mode */
  s: number;
  /** Brightness -100 to 100 */
  b: number;
  /** Contrast -100 to 100 */
  c: number;
  /** When true, use Photoshop-style Colorize (grayscale -> fixed HSL). Default: adjust mode. */
  colorize?: boolean;
}

export const CharacterState = {
  IDLE: "idle",
  WALK: "walk",
  TYPE: "type",
} as const;
export type CharacterState = (typeof CharacterState)[keyof typeof CharacterState];

export const Direction = {
  DOWN: 0,
  LEFT: 1,
  RIGHT: 2,
  UP: 3,
} as const;
export type Direction = (typeof Direction)[keyof typeof Direction];

/** 2D array of hex color strings (or '' for transparent). [row][col] */
export type SpriteData = string[][];

export interface Seat {
  /** Chair furniture uid */
  uid: string;
  /** Tile col where agent sits */
  seatCol: number;
  /** Tile row where agent sits */
  seatRow: number;
  /** Direction character faces when sitting (toward adjacent desk) */
  facingDir: Direction;
  assigned: boolean;
}

export interface FurnitureInstance {
  sprite: SpriteData;
  /** Pixel x (top-left) */
  x: number;
  /** Pixel y (top-left) */
  y: number;
  /** Y value used for depth sorting (typically bottom edge) */
  zY: number;
}

export interface ToolActivity {
  toolId: string;
  status: string;
  done: boolean;
  permissionWait?: boolean;
}

export const FurnitureType = {
  DESK: "desk",
  BOOKSHELF: "bookshelf",
  PLANT: "plant",
  COOLER: "cooler",
  WHITEBOARD: "whiteboard",
  CHAIR: "chair",
  PC: "pc",
  LAMP: "lamp",
} as const;
export type FurnitureType = (typeof FurnitureType)[keyof typeof FurnitureType];

export interface FurnitureCatalogEntry {
  type: string;
  label: string;
  footprintW: number;
  footprintH: number;
  sprite: SpriteData;
  isDesk: boolean;
  category?: string;
  /** Orientation from rotation group: 'front' | 'back' | 'left' | 'right' */
  orientation?: string;
  /** Whether this item can be placed on top of desk/table surfaces */
  canPlaceOnSurfaces?: boolean;
  /** Number of tile rows from the top of the footprint that are "background" */
  backgroundTiles?: number;
  /** Whether this item can be placed on wall tiles */
  canPlaceOnWalls?: boolean;
}

export interface PlacedFurniture {
  uid: string;
  type: string;
  col: number;
  row: number;
  /** Optional color override for furniture */
  color?: FloorColor;
}

export interface OfficeLayout {
  version: 1;
  cols: number;
  rows: number;
  tiles: TileType[];
  furniture: PlacedFurniture[];
  /** Per-tile color settings, parallel to tiles array. null = wall/no color */
  tileColors?: Array<FloorColor | null>;
}

export interface Character {
  id: number;
  state: CharacterState;
  dir: Direction;
  /** Pixel position */
  x: number;
  y: number;
  /** Current tile column */
  tileCol: number;
  /** Current tile row */
  tileRow: number;
  /** Remaining path steps (tile coords) */
  path: Array<{ col: number; row: number }>;
  /** 0-1 lerp between current tile and next tile */
  moveProgress: number;
  /** Current tool name for typing vs reading animation, or null */
  currentTool: string | null;
  /** Palette index (0-5) */
  palette: number;
  /** Hue shift in degrees (0 = no shift, >=45 for repeated palettes) */
  hueShift: number;
  /** Animation frame index */
  frame: number;
  /** Time accumulator for animation */
  frameTimer: number;
  /** Timer for idle wander decisions */
  wanderTimer: number;
  /** Number of wander moves completed in current roaming cycle */
  wanderCount: number;
  /** Max wander moves before returning to seat for rest */
  wanderLimit: number;
  /** Whether the agent is actively working */
  isActive: boolean;
  /** Assigned seat uid, or null if no seat */
  seatId: string | null;
  /** Active speech bubble type, or null if none showing */
  bubbleType: "permission" | "waiting" | null;
  /** Countdown timer for bubble */
  bubbleTimer: number;
  /** Timer to stay seated while inactive after seat reassignment */
  seatTimer: number;
  /** Whether this character represents a sub-agent */
  isSubagent: boolean;
  /** Parent agent ID if this is a sub-agent, null otherwise */
  parentAgentId: number | null;
  /** Active matrix spawn/despawn effect, or null */
  matrixEffect: "spawn" | "despawn" | null;
  /** Timer counting up from 0 to MATRIX_EFFECT_DURATION */
  matrixEffectTimer: number;
  /** Per-column random seeds (16 values) for staggered rain timing */
  matrixEffectSeeds: number[];
  /** Display name for the character */
  name?: string;
  /** Zone assignment for the character */
  zone?: string;
}
