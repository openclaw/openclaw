/**
 * WorldState: manages the game world simulation.
 *
 * Renamed from OfficeState in pixel-agents. All vscode.postMessage() calls
 * and editor-specific logic have been removed.
 */

import {
  TILE_SIZE,
  PALETTE_COUNT,
  HUE_SHIFT_MIN_DEG,
  HUE_SHIFT_RANGE_DEG,
  WAITING_BUBBLE_DURATION_SEC,
  DISMISS_BUBBLE_FAST_FADE_SEC,
  AUTO_ON_FACING_DEPTH,
  AUTO_ON_SIDE_DEPTH,
  CHARACTER_SITTING_OFFSET_PX,
  CHARACTER_HIT_HALF_WIDTH,
  CHARACTER_HIT_HEIGHT,
  MATRIX_EFFECT_DURATION_SEC,
} from "../constants.js";
import { getCatalogEntry, getOnStateType } from "../layout/furniture-catalog.js";
import {
  createDefaultLayout,
  layoutToTileMap,
  layoutToFurnitureInstances,
  layoutToSeats,
  getBlockedTiles,
} from "../layout/layout-serializer.js";
import { getWalkableTiles } from "../layout/tile-map.js";
import { ZONE_DEFINITIONS } from "../layout/zone-layouts.js";
import { CharacterState, Direction } from "../types.js";
import type {
  Character,
  Seat,
  FurnitureInstance,
  TileType as TileTypeVal,
  OfficeLayout,
  PlacedFurniture,
} from "../types.js";
import { createCharacter, updateCharacter } from "./characters.js";
import { matrixEffectSeeds } from "./matrix-effect.js";

export class WorldState {
  layout: OfficeLayout;
  tileMap: TileTypeVal[][];
  seats: Map<string, Seat>;
  blockedTiles: Set<string>;
  furniture: FurnitureInstance[];
  walkableTiles: Array<{ col: number; row: number }>;
  characters: Map<number, Character> = new Map();
  selectedAgentId: number | null = null;
  cameraFollowId: number | null = null;
  hoveredAgentId: number | null = null;

  /** Callback fired when a character is clicked */
  onCharacterClick?: (characterId: number) => void;

  /** Maps "parentId:toolId" -> sub-agent character ID (negative) */
  subagentIdMap: Map<string, number> = new Map();
  /** Reverse lookup: sub-agent character ID -> parent info */
  subagentMeta: Map<number, { parentAgentId: number; parentToolId: string }> = new Map();
  private nextSubagentId = -1;

  constructor(layout?: OfficeLayout) {
    this.layout = layout || createDefaultLayout();
    this.tileMap = layoutToTileMap(this.layout);
    this.seats = layoutToSeats(this.layout.furniture);
    this.blockedTiles = getBlockedTiles(this.layout.furniture);
    this.furniture = layoutToFurnitureInstances(this.layout.furniture);
    this.walkableTiles = getWalkableTiles(this.tileMap, this.blockedTiles);
  }

  /** Rebuild all derived state from a new layout. Reassigns existing characters. */
  rebuildFromLayout(layout: OfficeLayout, shift?: { col: number; row: number }): void {
    this.layout = layout;
    this.tileMap = layoutToTileMap(layout);
    this.seats = layoutToSeats(layout.furniture);
    this.blockedTiles = getBlockedTiles(layout.furniture);
    this.rebuildFurnitureInstances();
    this.walkableTiles = getWalkableTiles(this.tileMap, this.blockedTiles);

    if (shift && (shift.col !== 0 || shift.row !== 0)) {
      for (const ch of this.characters.values()) {
        ch.tileCol += shift.col;
        ch.tileRow += shift.row;
        ch.x += shift.col * TILE_SIZE;
        ch.y += shift.row * TILE_SIZE;
        ch.path = [];
        ch.moveProgress = 0;
      }
    }

    // Reassign characters to new seats
    for (const seat of this.seats.values()) {
      seat.assigned = false;
    }

    // First pass: keep existing seat assignments
    for (const ch of this.characters.values()) {
      if (ch.seatId && this.seats.has(ch.seatId)) {
        const seat = this.seats.get(ch.seatId)!;
        if (!seat.assigned) {
          seat.assigned = true;
          ch.tileCol = seat.seatCol;
          ch.tileRow = seat.seatRow;
          ch.x = seat.seatCol * TILE_SIZE + TILE_SIZE / 2;
          ch.y = seat.seatRow * TILE_SIZE + TILE_SIZE / 2;
          ch.dir = seat.facingDir;
          continue;
        }
      }
      ch.seatId = null;
    }

    // Second pass: assign remaining characters to free seats
    for (const ch of this.characters.values()) {
      if (ch.seatId) {
        continue;
      }
      const seatId = this.findFreeSeat();
      if (seatId) {
        this.seats.get(seatId)!.assigned = true;
        ch.seatId = seatId;
        const seat = this.seats.get(seatId)!;
        ch.tileCol = seat.seatCol;
        ch.tileRow = seat.seatRow;
        ch.x = seat.seatCol * TILE_SIZE + TILE_SIZE / 2;
        ch.y = seat.seatRow * TILE_SIZE + TILE_SIZE / 2;
        ch.dir = seat.facingDir;
      }
    }

    // Relocate out-of-bounds characters
    for (const ch of this.characters.values()) {
      if (ch.seatId) {
        continue;
      }
      if (
        ch.tileCol < 0 ||
        ch.tileCol >= layout.cols ||
        ch.tileRow < 0 ||
        ch.tileRow >= layout.rows
      ) {
        this.relocateCharacterToWalkable(ch);
      }
    }
  }

  private relocateCharacterToWalkable(ch: Character): void {
    if (this.walkableTiles.length === 0) {
      return;
    }
    const spawn = this.walkableTiles[Math.floor(Math.random() * this.walkableTiles.length)];
    ch.tileCol = spawn.col;
    ch.tileRow = spawn.row;
    ch.x = spawn.col * TILE_SIZE + TILE_SIZE / 2;
    ch.y = spawn.row * TILE_SIZE + TILE_SIZE / 2;
    ch.path = [];
    ch.moveProgress = 0;
  }

  getLayout(): OfficeLayout {
    return this.layout;
  }

  private ownSeatKey(ch: Character): string | null {
    if (!ch.seatId) {
      return null;
    }
    const seat = this.seats.get(ch.seatId);
    if (!seat) {
      return null;
    }
    return `${seat.seatCol},${seat.seatRow}`;
  }

  private withOwnSeatUnblocked<T>(ch: Character, fn: () => T): T {
    const key = this.ownSeatKey(ch);
    if (key) {
      this.blockedTiles.delete(key);
    }
    const result = fn();
    if (key) {
      this.blockedTiles.add(key);
    }
    return result;
  }

  private findFreeSeat(zone?: string): string | null {
    // If zone specified, try to find a seat within that zone's bounding box first
    if (zone) {
      const zd = ZONE_DEFINITIONS.find((z) => z.id === zone);
      if (zd) {
        for (const [uid, seat] of this.seats) {
          if (
            !seat.assigned &&
            seat.seatCol >= zd.col &&
            seat.seatCol < zd.col + zd.width &&
            seat.seatRow >= zd.row &&
            seat.seatRow < zd.row + zd.height
          ) {
            return uid;
          }
        }
      }
    }
    // Fallback: any free seat
    for (const [uid, seat] of this.seats) {
      if (!seat.assigned) {
        return uid;
      }
    }
    return null;
  }

  private pickDiversePalette(): { palette: number; hueShift: number } {
    const counts = Array.from({ length: PALETTE_COUNT }, () => 0);
    for (const ch of this.characters.values()) {
      if (ch.isSubagent) {
        continue;
      }
      counts[ch.palette]++;
    }
    const minCount = Math.min(...counts);
    const available: number[] = [];
    for (let i = 0; i < PALETTE_COUNT; i++) {
      if (counts[i] === minCount) {
        available.push(i);
      }
    }
    const palette = available[Math.floor(Math.random() * available.length)];
    let hueShift = 0;
    if (minCount > 0) {
      hueShift = HUE_SHIFT_MIN_DEG + Math.floor(Math.random() * HUE_SHIFT_RANGE_DEG);
    }
    return { palette, hueShift };
  }

  addAgent(
    id: number,
    opts?: {
      palette?: number;
      hueShift?: number;
      seatId?: string;
      skipSpawnEffect?: boolean;
      name?: string;
      zone?: string;
    },
  ): void {
    if (this.characters.has(id)) {
      return;
    }

    let palette: number;
    let hueShift: number;
    if (opts?.palette !== undefined) {
      palette = opts.palette;
      hueShift = opts.hueShift ?? 0;
    } else {
      const pick = this.pickDiversePalette();
      palette = pick.palette;
      hueShift = pick.hueShift;
    }

    let seatId: string | null = null;
    if (opts?.seatId && this.seats.has(opts.seatId)) {
      const seat = this.seats.get(opts.seatId)!;
      if (!seat.assigned) {
        seatId = opts.seatId;
      }
    }
    if (!seatId) {
      seatId = this.findFreeSeat(opts?.zone);
    }

    let ch: Character;
    if (seatId) {
      const seat = this.seats.get(seatId)!;
      seat.assigned = true;
      ch = createCharacter(id, palette, seatId, seat, hueShift);
    } else {
      const spawn =
        this.walkableTiles.length > 0
          ? this.walkableTiles[Math.floor(Math.random() * this.walkableTiles.length)]
          : { col: 1, row: 1 };
      ch = createCharacter(id, palette, null, null, hueShift);
      ch.x = spawn.col * TILE_SIZE + TILE_SIZE / 2;
      ch.y = spawn.row * TILE_SIZE + TILE_SIZE / 2;
      ch.tileCol = spawn.col;
      ch.tileRow = spawn.row;
    }

    if (opts?.name) {
      ch.name = opts.name;
    }
    if (opts?.zone) {
      ch.zone = opts.zone;
    }

    if (!opts?.skipSpawnEffect) {
      ch.matrixEffect = "spawn";
      ch.matrixEffectTimer = 0;
      ch.matrixEffectSeeds = matrixEffectSeeds();
    }
    this.characters.set(id, ch);
  }

  removeAgent(id: number): void {
    const ch = this.characters.get(id);
    if (!ch) {
      return;
    }
    if (ch.matrixEffect === "despawn") {
      return;
    }
    if (ch.seatId) {
      const seat = this.seats.get(ch.seatId);
      if (seat) {
        seat.assigned = false;
      }
    }
    if (this.selectedAgentId === id) {
      this.selectedAgentId = null;
    }
    if (this.cameraFollowId === id) {
      this.cameraFollowId = null;
    }
    ch.matrixEffect = "despawn";
    ch.matrixEffectTimer = 0;
    ch.matrixEffectSeeds = matrixEffectSeeds();
    ch.bubbleType = null;
  }

  setAgentActive(id: number, active: boolean): void {
    const ch = this.characters.get(id);
    if (ch) {
      ch.isActive = active;
      if (!active) {
        ch.seatTimer = -1;
        ch.path = [];
        ch.moveProgress = 0;
      }
      this.rebuildFurnitureInstances();
    }
  }

  private rebuildFurnitureInstances(): void {
    const autoOnTiles = new Set<string>();
    for (const ch of this.characters.values()) {
      if (!ch.isActive || !ch.seatId) {
        continue;
      }
      const seat = this.seats.get(ch.seatId);
      if (!seat) {
        continue;
      }
      const dCol =
        seat.facingDir === Direction.RIGHT ? 1 : seat.facingDir === Direction.LEFT ? -1 : 0;
      const dRow = seat.facingDir === Direction.DOWN ? 1 : seat.facingDir === Direction.UP ? -1 : 0;
      for (let d = 1; d <= AUTO_ON_FACING_DEPTH; d++) {
        autoOnTiles.add(`${seat.seatCol + dCol * d},${seat.seatRow + dRow * d}`);
      }
      for (let d = 1; d <= AUTO_ON_SIDE_DEPTH; d++) {
        const baseCol = seat.seatCol + dCol * d;
        const baseRow = seat.seatRow + dRow * d;
        if (dCol !== 0) {
          autoOnTiles.add(`${baseCol},${baseRow - 1}`);
          autoOnTiles.add(`${baseCol},${baseRow + 1}`);
        } else {
          autoOnTiles.add(`${baseCol - 1},${baseRow}`);
          autoOnTiles.add(`${baseCol + 1},${baseRow}`);
        }
      }
    }

    if (autoOnTiles.size === 0) {
      this.furniture = layoutToFurnitureInstances(this.layout.furniture);
      return;
    }

    const modifiedFurniture: PlacedFurniture[] = this.layout.furniture.map((item) => {
      const entry = getCatalogEntry(item.type);
      if (!entry) {
        return item;
      }
      for (let dr = 0; dr < entry.footprintH; dr++) {
        for (let dc = 0; dc < entry.footprintW; dc++) {
          if (autoOnTiles.has(`${item.col + dc},${item.row + dr}`)) {
            const onType = getOnStateType(item.type);
            if (onType !== item.type) {
              return { ...item, type: onType };
            }
            return item;
          }
        }
      }
      return item;
    });

    this.furniture = layoutToFurnitureInstances(modifiedFurniture);
  }

  setAgentTool(id: number, tool: string | null): void {
    const ch = this.characters.get(id);
    if (ch) {
      ch.currentTool = tool;
    }
  }

  showPermissionBubble(id: number): void {
    const ch = this.characters.get(id);
    if (ch) {
      ch.bubbleType = "permission";
      ch.bubbleTimer = 0;
    }
  }

  clearPermissionBubble(id: number): void {
    const ch = this.characters.get(id);
    if (ch && ch.bubbleType === "permission") {
      ch.bubbleType = null;
      ch.bubbleTimer = 0;
    }
  }

  showWaitingBubble(id: number): void {
    const ch = this.characters.get(id);
    if (ch) {
      ch.bubbleType = "waiting";
      ch.bubbleTimer = WAITING_BUBBLE_DURATION_SEC;
    }
  }

  dismissBubble(id: number): void {
    const ch = this.characters.get(id);
    if (!ch || !ch.bubbleType) {
      return;
    }
    if (ch.bubbleType === "permission") {
      ch.bubbleType = null;
      ch.bubbleTimer = 0;
    } else if (ch.bubbleType === "waiting") {
      ch.bubbleTimer = Math.min(ch.bubbleTimer, DISMISS_BUBBLE_FAST_FADE_SEC);
    }
  }

  update(dt: number): void {
    // Advance demo state machine if running
    this.updateDemo(dt);

    const toDelete: number[] = [];
    for (const ch of this.characters.values()) {
      if (ch.matrixEffect) {
        ch.matrixEffectTimer += dt;
        if (ch.matrixEffectTimer >= MATRIX_EFFECT_DURATION_SEC) {
          if (ch.matrixEffect === "spawn") {
            ch.matrixEffect = null;
            ch.matrixEffectTimer = 0;
            ch.matrixEffectSeeds = [];
          } else {
            toDelete.push(ch.id);
          }
        }
        continue;
      }

      this.withOwnSeatUnblocked(ch, () =>
        updateCharacter(ch, dt, this.walkableTiles, this.seats, this.tileMap, this.blockedTiles),
      );

      if (ch.bubbleType === "waiting") {
        ch.bubbleTimer -= dt;
        if (ch.bubbleTimer <= 0) {
          ch.bubbleType = null;
          ch.bubbleTimer = 0;
        }
      }
    }
    for (const id of toDelete) {
      this.characters.delete(id);
    }
  }

  getCharacters(): Character[] {
    return Array.from(this.characters.values());
  }

  /** Get character at pixel position (for hit testing). Returns id or null. */
  getCharacterAt(worldX: number, worldY: number): number | null {
    const chars = this.getCharacters().toSorted((a, b) => b.y - a.y);
    for (const ch of chars) {
      if (ch.matrixEffect === "despawn") {
        continue;
      }
      const sittingOffset = ch.state === CharacterState.TYPE ? CHARACTER_SITTING_OFFSET_PX : 0;
      const anchorY = ch.y + sittingOffset;
      const left = ch.x - CHARACTER_HIT_HALF_WIDTH;
      const right = ch.x + CHARACTER_HIT_HALF_WIDTH;
      const top = anchorY - CHARACTER_HIT_HEIGHT;
      const bottom = anchorY;
      if (worldX >= left && worldX <= right && worldY >= top && worldY <= bottom) {
        return ch.id;
      }
    }
    return null;
  }

  /** Add sub-agent. Returns sub-agent character ID. */
  addSubagent(parentAgentId: number, parentToolId: string): number {
    const key = `${parentAgentId}:${parentToolId}`;
    if (this.subagentIdMap.has(key)) {
      return this.subagentIdMap.get(key)!;
    }

    const id = this.nextSubagentId--;
    const parentCh = this.characters.get(parentAgentId);
    const palette = parentCh ? parentCh.palette : 0;
    const hueShift = parentCh ? parentCh.hueShift : 0;

    const parentCol = parentCh ? parentCh.tileCol : 0;
    const parentRow = parentCh ? parentCh.tileRow : 0;
    const dist = (c: number, r: number) => Math.abs(c - parentCol) + Math.abs(r - parentRow);

    let bestSeatId: string | null = null;
    let bestDist = Infinity;
    for (const [uid, seat] of this.seats) {
      if (!seat.assigned) {
        const d = dist(seat.seatCol, seat.seatRow);
        if (d < bestDist) {
          bestDist = d;
          bestSeatId = uid;
        }
      }
    }

    let ch: Character;
    if (bestSeatId) {
      const seat = this.seats.get(bestSeatId)!;
      seat.assigned = true;
      ch = createCharacter(id, palette, bestSeatId, seat, hueShift);
    } else {
      let spawn = { col: 1, row: 1 };
      if (this.walkableTiles.length > 0) {
        let closest = this.walkableTiles[0];
        let closestDist = dist(closest.col, closest.row);
        for (let i = 1; i < this.walkableTiles.length; i++) {
          const d = dist(this.walkableTiles[i].col, this.walkableTiles[i].row);
          if (d < closestDist) {
            closest = this.walkableTiles[i];
            closestDist = d;
          }
        }
        spawn = closest;
      }
      ch = createCharacter(id, palette, null, null, hueShift);
      ch.x = spawn.col * TILE_SIZE + TILE_SIZE / 2;
      ch.y = spawn.row * TILE_SIZE + TILE_SIZE / 2;
      ch.tileCol = spawn.col;
      ch.tileRow = spawn.row;
    }
    ch.isSubagent = true;
    ch.parentAgentId = parentAgentId;
    ch.matrixEffect = "spawn";
    ch.matrixEffectTimer = 0;
    ch.matrixEffectSeeds = matrixEffectSeeds();
    this.characters.set(id, ch);

    this.subagentIdMap.set(key, id);
    this.subagentMeta.set(id, { parentAgentId, parentToolId });
    return id;
  }

  removeSubagent(parentAgentId: number, parentToolId: string): void {
    const key = `${parentAgentId}:${parentToolId}`;
    const id = this.subagentIdMap.get(key);
    if (id === undefined) {
      return;
    }

    const ch = this.characters.get(id);
    if (ch) {
      if (ch.matrixEffect === "despawn") {
        this.subagentIdMap.delete(key);
        this.subagentMeta.delete(id);
        return;
      }
      if (ch.seatId) {
        const seat = this.seats.get(ch.seatId);
        if (seat) {
          seat.assigned = false;
        }
      }
      ch.matrixEffect = "despawn";
      ch.matrixEffectTimer = 0;
      ch.matrixEffectSeeds = matrixEffectSeeds();
      ch.bubbleType = null;
    }
    this.subagentIdMap.delete(key);
    this.subagentMeta.delete(id);
    if (this.selectedAgentId === id) {
      this.selectedAgentId = null;
    }
    if (this.cameraFollowId === id) {
      this.cameraFollowId = null;
    }
  }

  removeAllSubagents(parentAgentId: number): void {
    const toRemove: string[] = [];
    for (const [key, id] of this.subagentIdMap) {
      const meta = this.subagentMeta.get(id);
      if (meta && meta.parentAgentId === parentAgentId) {
        const ch = this.characters.get(id);
        if (ch) {
          if (ch.matrixEffect === "despawn") {
            this.subagentMeta.delete(id);
            toRemove.push(key);
            continue;
          }
          if (ch.seatId) {
            const seat = this.seats.get(ch.seatId);
            if (seat) {
              seat.assigned = false;
            }
          }
          ch.matrixEffect = "despawn";
          ch.matrixEffectTimer = 0;
          ch.matrixEffectSeeds = matrixEffectSeeds();
          ch.bubbleType = null;
        }
        this.subagentMeta.delete(id);
        if (this.selectedAgentId === id) {
          this.selectedAgentId = null;
        }
        if (this.cameraFollowId === id) {
          this.cameraFollowId = null;
        }
        toRemove.push(key);
      }
    }
    for (const key of toRemove) {
      this.subagentIdMap.delete(key);
    }
  }

  getSubagentId(parentAgentId: number, parentToolId: string): number | null {
    return this.subagentIdMap.get(`${parentAgentId}:${parentToolId}`) ?? null;
  }

  // -- Demo mode ----------------------------------------------------------------

  private demoTimer = 0;
  private demoPhase = 0;
  private demoRunning = false;
  private demoAgentIds: number[] = [];

  /** All 13 Matrix agents grouped by zone for staggered spawning */
  private static readonly DEMO_AGENTS: Array<{
    name: string;
    zone: string;
    palette: number;
    hueShift: number;
  }> = [
    // Construct
    { name: "Operator1", zone: "construct", palette: 0, hueShift: 0 },
    // Machine City
    { name: "Neo", zone: "machine-city", palette: 1, hueShift: 45 },
    { name: "Tank", zone: "machine-city", palette: 2, hueShift: 45 },
    { name: "Dozer", zone: "machine-city", palette: 3, hueShift: 45 },
    { name: "Mouse", zone: "machine-city", palette: 4, hueShift: 45 },
    // Zion
    { name: "Trinity", zone: "zion", palette: 0, hueShift: 90 },
    { name: "Oracle", zone: "zion", palette: 1, hueShift: 90 },
    { name: "Seraph", zone: "zion", palette: 2, hueShift: 90 },
    { name: "Zee", zone: "zion", palette: 3, hueShift: 90 },
    // Broadcast
    { name: "Morpheus", zone: "broadcast", palette: 0, hueShift: 135 },
    { name: "Niobe", zone: "broadcast", palette: 1, hueShift: 135 },
    { name: "Switch", zone: "broadcast", palette: 2, hueShift: 135 },
    { name: "Rex", zone: "broadcast", palette: 3, hueShift: 135 },
  ];

  /** Spawn interval between agents during demo (seconds) */
  private static readonly DEMO_SPAWN_INTERVAL = 0.4;
  /** Pause after all spawned before despawning (seconds) */
  private static readonly DEMO_DWELL_TIME = 4.0;
  /** Despawn interval between agents (seconds) */
  private static readonly DEMO_DESPAWN_INTERVAL = 0.3;

  get isDemoRunning(): boolean {
    return this.demoRunning;
  }

  startDemo(): void {
    if (this.demoRunning) {
      return;
    }
    // Clear any existing characters from the world
    for (const id of this.characters.keys()) {
      this.characters.delete(id);
    }
    // Reset seats
    for (const seat of this.seats.values()) {
      seat.assigned = false;
    }

    this.demoRunning = true;
    this.demoPhase = 0; // 0=spawning, 1=dwelling, 2=despawning, 3=pause-before-restart
    this.demoTimer = 0;
    this.demoAgentIds = [];
  }

  stopDemo(): void {
    this.demoRunning = false;
    this.demoPhase = 0;
    this.demoTimer = 0;
    // Clean up demo characters
    for (const id of this.demoAgentIds) {
      this.characters.delete(id);
    }
    this.demoAgentIds = [];
    for (const seat of this.seats.values()) {
      seat.assigned = false;
    }
  }

  /** Called from update() to advance the demo state machine */
  private updateDemo(dt: number): void {
    if (!this.demoRunning) {
      return;
    }
    this.demoTimer += dt;

    const agents = WorldState.DEMO_AGENTS;
    const spawnInterval = WorldState.DEMO_SPAWN_INTERVAL;
    const despawnInterval = WorldState.DEMO_DESPAWN_INTERVAL;
    const dwellTime = WorldState.DEMO_DWELL_TIME;

    if (this.demoPhase === 0) {
      // Spawning phase: stagger-spawn agents one by one
      const spawnCount = Math.min(agents.length, Math.floor(this.demoTimer / spawnInterval) + 1);
      while (this.demoAgentIds.length < spawnCount) {
        const idx = this.demoAgentIds.length;
        const a = agents[idx];
        const id = 9000 + idx;
        this.addAgent(id, { palette: a.palette, hueShift: a.hueShift, name: a.name, zone: a.zone });
        this.demoAgentIds.push(id);
      }
      if (this.demoAgentIds.length >= agents.length) {
        this.demoPhase = 1;
        this.demoTimer = 0;
      }
    } else if (this.demoPhase === 1) {
      // Dwell phase: let agents wander and be visible
      if (this.demoTimer >= dwellTime) {
        this.demoPhase = 2;
        this.demoTimer = 0;
      }
    } else if (this.demoPhase === 2) {
      // Despawning phase: remove agents one by one (reverse order)
      const despawnCount = Math.min(
        agents.length,
        Math.floor(this.demoTimer / despawnInterval) + 1,
      );
      const alreadyDespawned =
        agents.length -
        this.demoAgentIds.filter((id) => {
          const ch = this.characters.get(id);
          return ch && ch.matrixEffect !== "despawn";
        }).length;
      const toDespawn = despawnCount - alreadyDespawned;
      for (let i = 0; i < toDespawn; i++) {
        // Find last non-despawning agent
        for (let j = this.demoAgentIds.length - 1; j >= 0; j--) {
          const id = this.demoAgentIds[j];
          const ch = this.characters.get(id);
          if (ch && ch.matrixEffect !== "despawn") {
            this.removeAgent(id);
            break;
          }
        }
      }
      // Check if all are despawned (deleted from map after effect ends)
      const allGone = this.demoAgentIds.every((id) => !this.characters.has(id));
      if (allGone) {
        this.demoPhase = 3;
        this.demoTimer = 0;
      }
    } else if (this.demoPhase === 3) {
      // Pause before restarting
      if (this.demoTimer >= 1.5) {
        this.demoAgentIds = [];
        for (const seat of this.seats.values()) {
          seat.assigned = false;
        }
        this.demoPhase = 0;
        this.demoTimer = 0;
      }
    }
  }
}
