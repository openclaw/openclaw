"use client";

import { useRef, useEffect, useCallback, useImperativeHandle, forwardRef } from "react";
import { initializeAssets } from "@/lib/pixel-engine/asset-loader";
import { TILE_SIZE, ZOOM_MIN, ZOOM_MAX, ZOOM_SCROLL_THRESHOLD } from "@/lib/pixel-engine/constants";
import { startGameLoop } from "@/lib/pixel-engine/engine/game-loop";
import { renderFrame } from "@/lib/pixel-engine/engine/renderer";
import { WorldState } from "@/lib/pixel-engine/engine/world-state";
import { MATRIX_WORLD_LAYOUT, getAgentZone } from "@/lib/pixel-engine/layout/zone-layouts";

export interface AgentCharacter {
  id: number;
  name: string;
  isActive: boolean;
  currentTool?: string | null;
}

export interface MatrixCanvasHandle {
  startDemo: () => void;
  stopDemo: () => void;
  isDemoRunning: () => boolean;
}

export interface MatrixCanvasProps {
  /** List of agents to visualize */
  agents: AgentCharacter[];
  /** Current zoom level */
  zoom: number;
  /** Zoom change handler */
  onZoomChange: (zoom: number) => void;
  /** Fired when a character sprite is clicked */
  onCharacterClick?: (agentId: number) => void;
  /** Additional CSS class */
  className?: string;
}

export const MatrixCanvas = forwardRef<MatrixCanvasHandle, MatrixCanvasProps>(function MatrixCanvas(
  { agents, zoom, onZoomChange, onCharacterClick, className },
  ref,
) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<WorldState | null>(null);
  const panRef = useRef({ x: 0, y: 0 });
  const isPanningRef = useRef(false);
  const panStartRef = useRef({ x: 0, y: 0, panX: 0, panY: 0 });
  const agentsRef = useRef(agents);
  const zoomRef = useRef(zoom);

  // Keep refs in sync
  agentsRef.current = agents;
  zoomRef.current = zoom;

  // Expose demo controls via ref
  useImperativeHandle(ref, () => ({
    startDemo: () => worldRef.current?.startDemo(),
    stopDemo: () => worldRef.current?.stopDemo(),
    isDemoRunning: () => worldRef.current?.isDemoRunning ?? false,
  }));

  // Initialize world state once
  useEffect(() => {
    // Load wall + floor sprite data before creating the world
    initializeAssets();

    const world = new WorldState(MATRIX_WORLD_LAYOUT);
    worldRef.current = world;
    return () => {
      worldRef.current = null;
    };
  }, []);

  // Sync agents with world state
  useEffect(() => {
    const world = worldRef.current;
    if (!world) {
      return;
    }

    const currentIds = new Set(agents.map((a) => a.id));
    const worldIds = new Set(world.characters.keys());

    // Add new agents
    for (const agent of agents) {
      if (!worldIds.has(agent.id)) {
        const zoneInfo = getAgentZone(agent.name);
        world.addAgent(agent.id, {
          palette: zoneInfo.palette,
          hueShift: zoneInfo.hueShift,
          name: agent.name,
          zone: zoneInfo.zone,
        });
      }

      // Update active state and tool
      world.setAgentActive(agent.id, agent.isActive);
      world.setAgentTool(agent.id, agent.currentTool ?? null);
    }

    // Remove agents no longer present
    for (const id of worldIds) {
      if (!currentIds.has(id)) {
        world.removeAgent(id);
      }
    }
  }, [agents]);

  // Canvas sizing with DPR awareness
  const resizeCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) {
      return;
    }

    const dpr = window.devicePixelRatio || 1;
    const rect = container.getBoundingClientRect();
    const w = Math.floor(rect.width);
    const h = Math.floor(rect.height);

    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;

    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.scale(dpr, dpr);
      ctx.imageSmoothingEnabled = false;
    }
  }, []);

  // Game loop + resize observer
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    resizeCanvas();

    const stop = startGameLoop(canvas, {
      update(dt) {
        worldRef.current?.update(dt);
      },
      render(ctx) {
        const world = worldRef.current;
        if (!world) {
          return;
        }

        const dpr = window.devicePixelRatio || 1;
        const displayW = canvas.width / dpr;
        const displayH = canvas.height / dpr;

        ctx.save();
        renderFrame(
          ctx,
          displayW,
          displayH,
          world.tileMap,
          world.furniture,
          world.getCharacters(),
          zoomRef.current,
          panRef.current.x,
          panRef.current.y,
          world.selectedAgentId,
          world.hoveredAgentId,
          world.layout.tileColors,
          world.layout.cols,
          world.layout.rows,
        );
        ctx.restore();
      },
    });

    // Resize observer
    const container = containerRef.current;
    let observer: ResizeObserver | null = null;
    if (container) {
      observer = new ResizeObserver(() => resizeCanvas());
      observer.observe(container);
    }

    return () => {
      stop();
      observer?.disconnect();
    };
  }, [resizeCanvas]);

  // Mouse click -> character hit test
  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const world = worldRef.current;
      const canvas = canvasRef.current;
      if (!world || !canvas) {
        return;
      }

      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      const displayW = canvas.width / dpr;
      const displayH = canvas.height / dpr;

      // Convert to canvas-local coordinates
      const canvasX = e.clientX - rect.left;
      const canvasY = e.clientY - rect.top;

      // Convert to world coordinates
      const cols = world.layout.cols;
      const rows = world.layout.rows;
      const mapW = cols * TILE_SIZE * zoomRef.current;
      const mapH = rows * TILE_SIZE * zoomRef.current;
      const offsetX = Math.floor((displayW - mapW) / 2) + Math.round(panRef.current.x);
      const offsetY = Math.floor((displayH - mapH) / 2) + Math.round(panRef.current.y);

      const worldX = (canvasX - offsetX) / zoomRef.current;
      const worldY = (canvasY - offsetY) / zoomRef.current;

      const charId = world.getCharacterAt(worldX, worldY);
      if (charId !== null) {
        world.selectedAgentId = charId;
        onCharacterClick?.(charId);
      } else {
        world.selectedAgentId = null;
      }
    },
    [onCharacterClick],
  );

  // Mouse move -> hover detection
  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (isPanningRef.current) {
      // Pan the viewport
      const dx = e.clientX - panStartRef.current.x;
      const dy = e.clientY - panStartRef.current.y;
      panRef.current = {
        x: panStartRef.current.panX + dx,
        y: panStartRef.current.panY + dy,
      };
      return;
    }

    const world = worldRef.current;
    const canvas = canvasRef.current;
    if (!world || !canvas) {
      return;
    }

    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const displayW = canvas.width / dpr;
    const displayH = canvas.height / dpr;

    const canvasX = e.clientX - rect.left;
    const canvasY = e.clientY - rect.top;

    const cols = world.layout.cols;
    const rows = world.layout.rows;
    const mapW = cols * TILE_SIZE * zoomRef.current;
    const mapH = rows * TILE_SIZE * zoomRef.current;
    const offsetX = Math.floor((displayW - mapW) / 2) + Math.round(panRef.current.x);
    const offsetY = Math.floor((displayH - mapH) / 2) + Math.round(panRef.current.y);

    const worldX = (canvasX - offsetX) / zoomRef.current;
    const worldY = (canvasY - offsetY) / zoomRef.current;

    world.hoveredAgentId = world.getCharacterAt(worldX, worldY);
  }, []);

  // Pan: middle-click or shift+click
  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (e.button === 1 || (e.button === 0 && e.shiftKey)) {
      isPanningRef.current = true;
      panStartRef.current = {
        x: e.clientX,
        y: e.clientY,
        panX: panRef.current.x,
        panY: panRef.current.y,
      };
      e.preventDefault();
    }
  }, []);

  const handleMouseUp = useCallback(() => {
    isPanningRef.current = false;
  }, []);

  // Wheel zoom
  const handleWheel = useCallback(
    (e: React.WheelEvent<HTMLCanvasElement>) => {
      e.preventDefault();
      const delta = -e.deltaY;
      const step =
        delta > ZOOM_SCROLL_THRESHOLD ? 0.5 : delta < -ZOOM_SCROLL_THRESHOLD ? -0.5 : delta * 0.005;
      const newZoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zoomRef.current + step));
      if (newZoom !== zoomRef.current) {
        onZoomChange(newZoom);
      }
    },
    [onZoomChange],
  );

  return (
    <div
      ref={containerRef}
      className={`relative w-full h-full overflow-hidden bg-black ${className ?? ""}`}
    >
      <canvas
        ref={canvasRef}
        onClick={handleClick}
        onMouseMove={handleMouseMove}
        onMouseDown={handleMouseDown}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onWheel={handleWheel}
        style={{ cursor: isPanningRef.current ? "grabbing" : "default" }}
      />
    </div>
  );
});
