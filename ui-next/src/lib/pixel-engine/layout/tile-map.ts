/**
 * Tile map utilities: walkability checks and BFS pathfinding.
 */

import type { TileType as TileTypeVal } from "../types.js";
import { TileType } from "../types.js";

/** Check if a tile is walkable (floor type, not blocked by furniture) */
export function isWalkable(
  col: number,
  row: number,
  tileMap: TileTypeVal[][],
  blockedTiles: Set<string>,
): boolean {
  const rows = tileMap.length;
  const cols = rows > 0 ? tileMap[0].length : 0;
  if (row < 0 || row >= rows || col < 0 || col >= cols) {
    return false;
  }
  const t = tileMap[row][col];
  if (t === TileType.WALL || t === TileType.VOID) {
    return false;
  }
  if (blockedTiles.has(`${col},${row}`)) {
    return false;
  }
  return true;
}

/** Get walkable tile positions (grid coords) for wandering */
export function getWalkableTiles(
  tileMap: TileTypeVal[][],
  blockedTiles: Set<string>,
): Array<{ col: number; row: number }> {
  const rows = tileMap.length;
  const cols = rows > 0 ? tileMap[0].length : 0;
  const tiles: Array<{ col: number; row: number }> = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (isWalkable(c, r, tileMap, blockedTiles)) {
        tiles.push({ col: c, row: r });
      }
    }
  }
  return tiles;
}

/** BFS pathfinding on 4-connected grid (no diagonals). Returns path excluding start, including end. */
export function findPath(
  startCol: number,
  startRow: number,
  endCol: number,
  endRow: number,
  tileMap: TileTypeVal[][],
  blockedTiles: Set<string>,
): Array<{ col: number; row: number }> {
  if (startCol === endCol && startRow === endRow) {
    return [];
  }

  const key = (c: number, r: number) => `${c},${r}`;
  const startKey = key(startCol, startRow);
  const endKey = key(endCol, endRow);

  const endWalkable = isWalkable(endCol, endRow, tileMap, blockedTiles);
  if (!endWalkable) {
    return [];
  }

  const visited = new Set<string>();
  visited.add(startKey);

  const parent = new Map<string, string>();
  const queue: Array<{ col: number; row: number }> = [{ col: startCol, row: startRow }];

  const dirs = [
    { dc: 0, dr: -1 },
    { dc: 0, dr: 1 },
    { dc: -1, dr: 0 },
    { dc: 1, dr: 0 },
  ];

  while (queue.length > 0) {
    const curr = queue.shift()!;
    const currKey = key(curr.col, curr.row);

    if (currKey === endKey) {
      const path: Array<{ col: number; row: number }> = [];
      let k = endKey;
      while (k !== startKey) {
        const [c, r] = k.split(",").map(Number);
        path.unshift({ col: c, row: r });
        k = parent.get(k)!;
      }
      return path;
    }

    for (const d of dirs) {
      const nc = curr.col + d.dc;
      const nr = curr.row + d.dr;
      const nk = key(nc, nr);

      if (visited.has(nk)) {
        continue;
      }
      if (!isWalkable(nc, nr, tileMap, blockedTiles)) {
        continue;
      }

      visited.add(nk);
      parent.set(nk, currKey);
      queue.push({ col: nc, row: nr });
    }
  }

  return [];
}
