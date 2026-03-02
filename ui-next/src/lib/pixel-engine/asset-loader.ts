/**
 * Inline sprite data for wall and floor tiles.
 *
 * Defines 16 wall tile variants (4-bit neighbor bitmask: N=1, E=2, S=4, W=8)
 * and 7 floor tile patterns (grayscale, colorized per-zone at render time).
 *
 * Call initializeAssets() once before creating WorldState to populate the
 * wall-tiles and floor-tiles modules with sprite data.
 */

import { setFloorSprites } from "./floor-tiles.js";
import type { SpriteData } from "./types.js";
import { setWallSprites } from "./wall-tiles.js";

// -- Color palette for walls --------------------------------------------------

const W0 = "#222244"; // deepest shadow
const W1 = "#2A2A4C"; // shadow
const W2 = "#333355"; // edge detail
const W3 = "#3A3A5C"; // base wall color
const W4 = "#3E3E60"; // surface variation
const W5 = "#4A4A6C"; // highlight
const W6 = "#52527A"; // bright highlight (top edge)
const W7 = "#2E2E50"; // mid shadow

// -- Color palette for floors (grayscale, colorized at render) ----------------

const F0 = "#767676"; // dark
const F1 = "#7C7C7C"; // mid-dark
const F2 = "#808080"; // base
const F3 = "#858585"; // mid-light
const F4 = "#8A8A8A"; // light
// -- Helper: fill a 16x16 grid with a single color ---------------------------

function fill16(color: string): SpriteData {
  return Array.from({ length: 16 }, () => Array(16).fill(color) as string[]);
}

// -- Wall sprite generation ---------------------------------------------------

/**
 * Generate a wall sprite for the given neighbor bitmask.
 *
 * Bitmask bits: N=1, E=2, S=4, W=8
 *
 * Design approach:
 * - Fill with base wall color
 * - Add top highlight when no north neighbor (bright edge on row 0-1)
 * - Add bottom shadow when no south neighbor (dark edge on row 14-15)
 * - Add left edge when no west neighbor (shadow column 0-1)
 * - Add right edge when no east neighbor (shadow column 14-15)
 * - Add corner details where two edges meet
 * - Add subtle surface texture (brick-like horizontal lines)
 */
function generateWallSprite(mask: number): SpriteData {
  const N = (mask & 1) !== 0;
  const E = (mask & 2) !== 0;
  const S = (mask & 4) !== 0;
  const W = (mask & 8) !== 0;

  const s = fill16(W3);

  // --- Surface texture: subtle horizontal mortar lines every 4 rows ---
  // Offset alternate brick rows for a staggered look
  for (let r = 0; r < 16; r++) {
    for (let c = 0; c < 16; c++) {
      // Mortar lines at rows 3, 7, 11, 15
      if (r % 4 === 3) {
        s[r][c] = W2;
      }
      // Slight surface variation on alternating pixels for texture
      if (r % 4 !== 3 && (r + c) % 7 === 0) {
        s[r][c] = W4;
      }
    }
  }

  // Vertical mortar lines (staggered between rows)
  for (let r = 0; r < 16; r++) {
    if (r % 4 === 3) {
      continue;
    } // skip horizontal mortar rows
    const brickRow = Math.floor(r / 4);
    const offset = brickRow % 2 === 0 ? 0 : 8;
    const mortarCol = (offset + 8) % 16;
    if (mortarCol >= 0 && mortarCol < 16) {
      s[r][mortarCol] = W2;
    }
  }

  // --- Top edge: highlight when no north neighbor ---
  if (!N) {
    for (let c = 0; c < 16; c++) {
      s[0][c] = W6; // brightest highlight row
      s[1][c] = W5; // secondary highlight
    }
    // Corner rounding on top-left if no west neighbor
    if (!W) {
      s[0][0] = W2;
      s[0][1] = W5;
      s[1][0] = W5;
    }
    // Corner rounding on top-right if no east neighbor
    if (!E) {
      s[0][15] = W2;
      s[0][14] = W5;
      s[1][15] = W5;
    }
  }

  // --- Bottom edge: shadow when no south neighbor ---
  if (!S) {
    for (let c = 0; c < 16; c++) {
      s[15][c] = W0; // deepest shadow
      s[14][c] = W1; // secondary shadow
    }
    // Corner detail on bottom-left
    if (!W) {
      s[15][0] = W0;
      s[14][0] = W0;
      s[15][1] = W0;
    }
    // Corner detail on bottom-right
    if (!E) {
      s[15][15] = W0;
      s[14][15] = W0;
      s[15][14] = W0;
    }
  }

  // --- Left edge: shadow when no west neighbor ---
  if (!W) {
    for (let r = 0; r < 16; r++) {
      s[r][0] = W1;
      s[r][1] = W7;
    }
    // Overwrite corners already set above
    if (!N) {
      s[0][0] = W2;
      s[1][0] = W5;
    }
    if (!S) {
      s[14][0] = W0;
      s[15][0] = W0;
    }
  }

  // --- Right edge: shadow when no east neighbor ---
  if (!E) {
    for (let r = 0; r < 16; r++) {
      s[r][15] = W1;
      s[r][14] = W7;
    }
    // Overwrite corners already set above
    if (!N) {
      s[0][15] = W2;
      s[1][15] = W5;
    }
    if (!S) {
      s[14][15] = W0;
      s[15][15] = W0;
    }
  }

  // --- Inner edge lines for connected sides ---
  // When a neighbor exists, the edge should blend seamlessly.
  // Add a subtle inner highlight/shadow line 2px in from the open edge.

  // Inner top shadow line when top IS open (enhances the ledge feel)
  if (!N) {
    for (let c = !W ? 2 : 0; c < (!E ? 14 : 16); c++) {
      s[2][c] = W4;
    }
  }

  // Inner bottom highlight line when bottom IS open
  if (!S) {
    for (let c = !W ? 2 : 0; c < (!E ? 14 : 16); c++) {
      s[13][c] = W2;
    }
  }

  return s;
}

/** Pre-built array of 16 wall sprites indexed by neighbor bitmask */
const WALL_SPRITES: SpriteData[] = Array.from({ length: 16 }, (_, mask) =>
  generateWallSprite(mask),
);

// -- Floor pattern generation -------------------------------------------------

/**
 * Pattern 1: Plain subtle texture.
 * Very slight pixel variation — almost flat but not perfectly uniform.
 */
function generateFloorPattern1(): SpriteData {
  const s = fill16(F2);
  for (let r = 0; r < 16; r++) {
    for (let c = 0; c < 16; c++) {
      // Subtle noise-like variation using deterministic pattern
      if ((r * 7 + c * 13) % 17 === 0) {
        s[r][c] = F3;
      }
      if ((r * 11 + c * 3) % 19 === 0) {
        s[r][c] = F1;
      }
    }
  }
  return s;
}

/**
 * Pattern 2: Checkered — alternating light/dark 2x2 blocks.
 */
function generateFloorPattern2(): SpriteData {
  const s = fill16(F2);
  for (let r = 0; r < 16; r++) {
    for (let c = 0; c < 16; c++) {
      const blockR = Math.floor(r / 2) % 2;
      const blockC = Math.floor(c / 2) % 2;
      s[r][c] = (blockR + blockC) % 2 === 0 ? F3 : F1;
    }
  }
  return s;
}

/**
 * Pattern 3: Small diamond pattern.
 * 4x4 repeating diamond motif.
 */
function generateFloorPattern3(): SpriteData {
  const s = fill16(F2);
  // Diamond template 4x4: center is lighter
  const diamond = [
    [0, 0, 1, 0],
    [0, 1, 1, 1],
    [1, 1, 1, 1],
    [0, 1, 1, 0],
  ];
  for (let r = 0; r < 16; r++) {
    for (let c = 0; c < 16; c++) {
      const dr = r % 4;
      const dc = c % 4;
      s[r][c] = diamond[dr][dc] ? F4 : F1;
    }
  }
  return s;
}

/**
 * Pattern 4: Horizontal lines.
 * Alternating rows of light and dark.
 */
function generateFloorPattern4(): SpriteData {
  const s = fill16(F2);
  for (let r = 0; r < 16; r++) {
    const color = r % 4 < 2 ? F3 : F1;
    for (let c = 0; c < 16; c++) {
      s[r][c] = color;
    }
  }
  return s;
}

/**
 * Pattern 5: Cross-hatch.
 * Grid lines every 4 pixels.
 */
function generateFloorPattern5(): SpriteData {
  const s = fill16(F2);
  for (let r = 0; r < 16; r++) {
    for (let c = 0; c < 16; c++) {
      if (r % 4 === 0 || c % 4 === 0) {
        s[r][c] = F1;
      }
      // Intersection points slightly darker
      if (r % 4 === 0 && c % 4 === 0) {
        s[r][c] = F0;
      }
    }
  }
  return s;
}

/**
 * Pattern 6: Brick-like pattern.
 * Horizontal mortar every 4 rows, vertical mortar staggered every 8 cols.
 */
function generateFloorPattern6(): SpriteData {
  const s = fill16(F2);
  for (let r = 0; r < 16; r++) {
    for (let c = 0; c < 16; c++) {
      // Horizontal mortar lines
      if (r % 4 === 0) {
        s[r][c] = F0;
        continue;
      }
      // Vertical mortar lines, staggered
      const brickRow = Math.floor(r / 4);
      const offset = brickRow % 2 === 0 ? 0 : 4;
      if ((c + offset) % 8 === 0) {
        s[r][c] = F0;
      }
      // Slight variation within bricks
      if ((r * 5 + c * 3) % 11 === 0) {
        s[r][c] = F3;
      }
    }
  }
  return s;
}

/**
 * Pattern 7: Diagonal stripes.
 * 4px-wide stripes at 45 degrees.
 */
function generateFloorPattern7(): SpriteData {
  const s = fill16(F2);
  for (let r = 0; r < 16; r++) {
    for (let c = 0; c < 16; c++) {
      const diag = (r + c) % 8;
      s[r][c] = diag < 4 ? F3 : F1;
    }
  }
  return s;
}

/** Pre-built array of 7 floor patterns (indices 0-6, mapped to pattern 1-7) */
const FLOOR_SPRITES: SpriteData[] = [
  generateFloorPattern1(),
  generateFloorPattern2(),
  generateFloorPattern3(),
  generateFloorPattern4(),
  generateFloorPattern5(),
  generateFloorPattern6(),
  generateFloorPattern7(),
];

// -- Initialization -----------------------------------------------------------

let initialized = false;

/**
 * Load wall and floor sprites into the tile rendering modules.
 * Safe to call multiple times; subsequent calls are no-ops.
 */
export function initializeAssets(): void {
  if (initialized) {
    return;
  }
  setWallSprites(WALL_SPRITES);
  setFloorSprites(FLOOR_SPRITES);
  initialized = true;
}

/** Check whether assets have been initialized */
export function areAssetsLoaded(): boolean {
  return initialized;
}
