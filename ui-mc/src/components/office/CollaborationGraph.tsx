import { format } from "date-fns";
import { motion, AnimatePresence } from "framer-motion";
import {
  Network,
  X,
  Maximize2,
  Minimize2,
  Filter,
  Clock,
  Play,
  Pause,
  RotateCcw,
  Repeat,
  Download,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GlassCard } from "@/components/ui/GlassCard";
import type { Agent } from "@/lib/agents";
import { avatarMap } from "@/lib/avatars";
import { useAgentStore } from "@/store/agentStore";
import { useTaskStore } from "@/store/taskStore";

interface GraphNode {
  id: string;
  agent: Agent;
  x: number;
  y: number;
  vx: number;
  vy: number;
  tx: number;
  ty: number;
}

interface GraphEdge {
  source: string;
  target: string;
  projects: string[];
}

export function CollaborationGraph() {
  const tasks = useTaskStore((s) => s.tasks);
  const agents = useAgentStore((s) => s.agents);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const nodesRef = useRef<GraphNode[]>([]);
  const animRef = useRef<number>(0);
  const [hoveredNode, setHoveredNode] = useState<GraphNode | null>(null);
  const [hoveredEdge, setHoveredEdge] = useState<GraphEdge | null>(null);
  const [dragNode, setDragNode] = useState<string | null>(null);
  const [focusedNode, setFocusedNode] = useState<string | null>(null);
  const [selectedProject, setSelectedProject] = useState<string | null>(null);
  const [filterOpen, setFilterOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [timelineValue, setTimelineValue] = useState(100); // 0-100 percentage
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackSpeed, setPlaybackSpeed] = useState(1); // 0.5, 1, 2
  const [loopMode, setLoopMode] = useState(false);
  const playIntervalRef = useRef<number>(0);
  const imagesRef = useRef<Record<string, HTMLImageElement>>({});
  const imagesLoadedRef = useRef(false);

  // Playback: auto-advance timeline
  useEffect(() => {
    if (!isPlaying) {
      if (playIntervalRef.current) {
        clearInterval(playIntervalRef.current);
      }
      return;
    }
    // Reset to start if at end
    if (timelineValue >= 100) {
      setTimelineValue(0);
    }
    playIntervalRef.current = window.setInterval(() => {
      setTimelineValue((prev) => {
        if (prev >= 100) {
          if (loopMode) {
            return 0;
          }
          setIsPlaying(false);
          return 100;
        }
        return Math.min(prev + 0.5 * playbackSpeed, 100);
      });
    }, 50);
    return () => {
      if (playIntervalRef.current) {
        clearInterval(playIntervalRef.current);
      }
    };
  }, [isPlaying, playbackSpeed, loopMode]);

  // All projects for the filter dropdown
  const allProjects = useMemo(() => {
    const projects = new Set<string>();
    tasks.forEach((t) => {
      if (t.project) {
        projects.add(t.project);
      }
    });
    return Array.from(projects).toSorted();
  }, [tasks]);

  // Timeline date range
  const { minDate, maxDate, timelineDate, timelineDateStr } = useMemo(() => {
    const dates = tasks.filter((t) => t.project).map((t) => new Date(t.createdAt).getTime());
    if (dates.length === 0) {
      return { minDate: 0, maxDate: 0, timelineDate: Infinity, timelineDateStr: "" };
    }
    const min = Math.min(...dates);
    const max = Math.max(...dates);
    const current = min + (max - min) * (timelineValue / 100);
    return {
      minDate: min,
      maxDate: max,
      timelineDate: current,
      timelineDateStr: format(new Date(current), "MMM d, yyyy"),
    };
  }, [tasks, timelineValue]);

  const edges = useMemo(() => {
    const projectAgents: Record<string, Set<string>> = {};
    tasks.forEach((t) => {
      if (t.project) {
        if (selectedProject && t.project !== selectedProject) {
          return;
        }
        // Timeline filter: only include tasks created on or before the timeline date
        if (new Date(t.createdAt).getTime() > timelineDate) {
          return;
        }
        if (!projectAgents[t.project]) {
          projectAgents[t.project] = new Set();
        }
        projectAgents[t.project].add(t.assignedAgent);
      }
    });

    const edgeMap: Record<string, GraphEdge> = {};
    Object.entries(projectAgents).forEach(([project, agentSet]) => {
      const ids = Array.from(agentSet);
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          const key = [ids[i], ids[j]].toSorted().join("-");
          if (!edgeMap[key]) {
            edgeMap[key] = { source: ids[i], target: ids[j], projects: [] };
          }
          edgeMap[key].projects.push(project);
        }
      }
    });
    return Object.values(edgeMap);
  }, [tasks, selectedProject, timelineDate]);

  // Load avatar images
  useEffect(() => {
    let loaded = 0;
    const total = agents.length;
    agents.forEach((agent) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        imagesRef.current[agent.id] = img;
        loaded++;
        if (loaded === total) {
          imagesLoadedRef.current = true;
        }
      };
      img.src = avatarMap[agent.id];
    });
  }, [agents]);

  // Initialize nodes in a circle
  useEffect(() => {
    const cx = 200;
    const cy = 150;
    const radius = 100;
    if (nodesRef.current.length === 0) {
      nodesRef.current = agents.map((agent, i) => {
        const angle = (i / agents.length) * Math.PI * 2 - Math.PI / 2;
        const x = cx + Math.cos(angle) * radius;
        const y = cy + Math.sin(angle) * radius;
        return { id: agent.id, agent, x, y, vx: 0, vy: 0, tx: x, ty: y };
      });
    }
  }, [agents]);

  // Compute which agents are connected in current filter
  const connectedIds = useMemo(() => {
    const ids = new Set<string>();
    edges.forEach((e) => {
      ids.add(e.source);
      ids.add(e.target);
    });
    return ids;
  }, [edges]);

  // When filter changes, give a velocity boost to rearrange
  const prevFilterRef = useRef<string | null>(null);
  useEffect(() => {
    if (prevFilterRef.current !== selectedProject) {
      prevFilterRef.current = selectedProject;
      // Nudge all nodes so force simulation rearranges them smoothly
      nodesRef.current.forEach((node) => {
        node.vx += (Math.random() - 0.5) * 8;
        node.vy += (Math.random() - 0.5) * 8;
      });
    }
  }, [selectedProject]);

  const getNodeById = useCallback((id: string) => nodesRef.current.find((n) => n.id === id), []);

  // Force simulation
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return;
    }

    const tick = () => {
      const w = canvas.width;
      const h = canvas.height;
      const cx = w / 2;
      const cy = h / 2;
      const nodes = nodesRef.current;

      // Apply forces
      nodes.forEach((node) => {
        if (node.id === dragNode) {
          return;
        }

        const isConnected = connectedIds.has(node.id);
        const hasFilter = !!selectedProject;

        // Connected nodes cluster toward center; unconnected drift to periphery
        if (hasFilter && !isConnected) {
          // Push unconnected nodes outward gently
          const dx = node.x - cx;
          const dy = node.y - cy;
          const dist = Math.sqrt(dx * dx + dy * dy) || 1;
          const targetDist = Math.min(w, h) * 0.4;
          if (dist < targetDist) {
            node.vx += (dx / dist) * 0.5;
            node.vy += (dy / dist) * 0.5;
          }
        } else {
          // Center gravity (stronger when filtered)
          const gravity = hasFilter ? 0.003 : 0.001;
          node.vx += (cx - node.x) * gravity;
          node.vy += (cy - node.y) * gravity;
        }

        // Repulsion from other nodes
        nodes.forEach((other) => {
          if (other.id === node.id) {
            return;
          }
          const dx = node.x - other.x;
          const dy = node.y - other.y;
          const dist = Math.sqrt(dx * dx + dy * dy) || 1;
          const force = 800 / (dist * dist);
          node.vx += (dx / dist) * force;
          node.vy += (dy / dist) * force;
        });

        // Edge attraction
        edges.forEach((edge) => {
          if (edge.source !== node.id && edge.target !== node.id) {
            return;
          }
          const otherId = edge.source === node.id ? edge.target : edge.source;
          const other = getNodeById(otherId);
          if (!other) {
            return;
          }
          const dx = other.x - node.x;
          const dy = other.y - node.y;
          const strength = (hasFilter ? 0.01 : 0.005) * edge.projects.length;
          node.vx += dx * strength;
          node.vy += dy * strength;
        });

        // Damping
        node.vx *= 0.85;
        node.vy *= 0.85;
        node.x += node.vx;
        node.y += node.vy;

        // Bounds
        const pad = 30;
        node.x = Math.max(pad, Math.min(w - pad, node.x));
        node.y = Math.max(pad, Math.min(h - pad, node.y));
      });

      // Draw
      ctx.clearRect(0, 0, w, h);

      // Compute focus-related sets
      const focusConnected = new Set<string>();
      if (focusedNode) {
        focusConnected.add(focusedNode);
        edges.forEach((e) => {
          if (e.source === focusedNode) {
            focusConnected.add(e.target);
          }
          if (e.target === focusedNode) {
            focusConnected.add(e.source);
          }
        });
      }

      // Draw edges
      edges.forEach((edge) => {
        const source = getNodeById(edge.source);
        const target = getNodeById(edge.target);
        if (!source || !target) {
          return;
        }

        const isFocusEdge = focusedNode
          ? edge.source === focusedNode || edge.target === focusedNode
          : false;
        const isDimmed = focusedNode && !isFocusEdge;

        const isHovered =
          hoveredEdge === edge ||
          hoveredNode?.id === edge.source ||
          hoveredNode?.id === edge.target;

        const thickness = Math.min(edge.projects.length * 1.5, 4);

        ctx.beginPath();
        ctx.moveTo(source.x, source.y);
        ctx.lineTo(target.x, target.y);
        ctx.strokeStyle = isDimmed
          ? "rgba(255,255,255,0.03)"
          : isFocusEdge
            ? `${source.agent.color}CC`
            : isHovered
              ? `${source.agent.color}AA`
              : "rgba(255,255,255,0.08)";
        ctx.lineWidth = isFocusEdge ? thickness + 2 : isHovered ? thickness + 1 : thickness;
        ctx.stroke();

        // Animated particle along edge
        if (
          (source.agent.status === "WORKING" || source.agent.status === "THINKING") &&
          (target.agent.status === "WORKING" || target.agent.status === "THINKING")
        ) {
          const t = (Date.now() % 3000) / 3000;
          const px = source.x + (target.x - source.x) * t;
          const py = source.y + (target.y - source.y) * t;
          ctx.beginPath();
          ctx.arc(px, py, 2, 0, Math.PI * 2);
          ctx.fillStyle = `${source.agent.color}80`;
          ctx.fill();
        }

        // Project label on hover or focus
        if (isHovered || isFocusEdge) {
          const mx = (source.x + target.x) / 2;
          const my = (source.y + target.y) / 2;
          ctx.font = "9px monospace";
          ctx.fillStyle = isFocusEdge ? "rgba(255,255,255,0.9)" : "rgba(255,255,255,0.7)";
          ctx.textAlign = "center";
          ctx.fillText(edge.projects.join(", "), mx, my - 8);
        }
      });

      // Draw nodes
      nodes.forEach((node) => {
        const isHovered = hoveredNode?.id === node.id;
        const isFocused = focusedNode === node.id;
        const isFilterDimmed = selectedProject && !connectedIds.has(node.id);
        const isDimmed = (focusedNode ? !focusConnected.has(node.id) : false) || isFilterDimmed;
        const r = isFocused ? 24 : isHovered ? 22 : isFilterDimmed ? 15 : 18;
        const isActive = node.agent.status === "WORKING" || node.agent.status === "THINKING";
        const nodeAlpha = isDimmed ? 0.2 : 1;
        ctx.globalAlpha = nodeAlpha;

        // Glow
        if (isActive) {
          const gradient = ctx.createRadialGradient(node.x, node.y, r, node.x, node.y, r * 2.5);
          gradient.addColorStop(0, `${node.agent.color}20`);
          gradient.addColorStop(1, "transparent");
          ctx.beginPath();
          ctx.arc(node.x, node.y, r * 2.5, 0, Math.PI * 2);
          ctx.fillStyle = gradient;
          ctx.fill();
        }

        // Circle bg
        ctx.beginPath();
        ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
        ctx.fillStyle = isFocused
          ? "rgba(30,30,40,1)"
          : isHovered
            ? "rgba(30,30,40,0.95)"
            : "rgba(20,20,30,0.9)";
        ctx.fill();
        ctx.strokeStyle = isFocused
          ? node.agent.color
          : isHovered
            ? node.agent.color
            : `${node.agent.color}60`;
        ctx.lineWidth = isFocused ? 3 : isHovered ? 2 : 1.5;
        ctx.stroke();

        // Focus ring
        if (isFocused) {
          ctx.beginPath();
          ctx.arc(node.x, node.y, r + 4, 0, Math.PI * 2);
          ctx.strokeStyle = `${node.agent.color}40`;
          ctx.lineWidth = 2;
          ctx.stroke();
        }

        // Avatar image
        const img = imagesRef.current[node.id];
        if (img) {
          ctx.save();
          ctx.beginPath();
          ctx.arc(node.x, node.y, r - 2, 0, Math.PI * 2);
          ctx.clip();
          ctx.drawImage(img, node.x - r + 2, node.y - r + 2, (r - 2) * 2, (r - 2) * 2);
          ctx.restore();
        }

        // Status dot
        ctx.beginPath();
        ctx.arc(node.x + r * 0.65, node.y + r * 0.65, 4, 0, Math.PI * 2);
        ctx.fillStyle =
          node.agent.status === "WORKING"
            ? "#30D158"
            : node.agent.status === "THINKING"
              ? "#FFD60A"
              : node.agent.status === "DONE"
                ? "#00C8FF"
                : node.agent.status === "ERROR"
                  ? "#FF2D55"
                  : "#636366";
        ctx.fill();
        ctx.strokeStyle = "rgba(20,20,30,0.9)";
        ctx.lineWidth = 2;
        ctx.stroke();

        // Name label
        ctx.font = `bold 9px monospace`;
        ctx.fillStyle = isFocused
          ? node.agent.color
          : isHovered
            ? node.agent.color
            : "rgba(255,255,255,0.7)";
        ctx.textAlign = "center";
        ctx.fillText(node.agent.name, node.x, node.y + r + 14);
        ctx.globalAlpha = 1;
      });

      animRef.current = requestAnimationFrame(tick);
    };

    tick();
    return () => cancelAnimationFrame(animRef.current);
  }, [
    edges,
    hoveredNode,
    hoveredEdge,
    dragNode,
    focusedNode,
    selectedProject,
    connectedIds,
    getNodeById,
  ]);

  // Resize canvas
  useEffect(() => {
    const resize = () => {
      const canvas = canvasRef.current;
      const container = containerRef.current;
      if (!canvas || !container) {
        return;
      }
      const dpr = window.devicePixelRatio || 1;
      const rect = container.getBoundingClientRect();
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.scale(dpr, dpr);
      }
    };
    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, [expanded]);

  const getMouseNode = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return null;
    }
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    return (
      nodesRef.current.find((n) => {
        const dx = n.x - mx;
        const dy = n.y - my;
        return dx * dx + dy * dy < 22 * 22;
      }) || null
    );
  }, []);

  const getMouseEdge = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas) {
        return null;
      }
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;

      for (const edge of edges) {
        const s = getNodeById(edge.source);
        const t = getNodeById(edge.target);
        if (!s || !t) {
          continue;
        }
        const dx = t.x - s.x;
        const dy = t.y - s.y;
        const len = Math.sqrt(dx * dx + dy * dy) || 1;
        const proj = ((mx - s.x) * dx + (my - s.y) * dy) / (len * len);
        if (proj < 0 || proj > 1) {
          continue;
        }
        const px = s.x + dx * proj;
        const py = s.y + dy * proj;
        const dist = Math.sqrt((mx - px) ** 2 + (my - py) ** 2);
        if (dist < 8) {
          return edge;
        }
      }
      return null;
    },
    [edges, getNodeById],
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (dragNode) {
        const canvas = canvasRef.current;
        if (!canvas) {
          return;
        }
        const rect = canvas.getBoundingClientRect();
        const node = getNodeById(dragNode);
        if (node) {
          node.x = e.clientX - rect.left;
          node.y = e.clientY - rect.top;
          node.vx = 0;
          node.vy = 0;
        }
        return;
      }
      const node = getMouseNode(e);
      setHoveredNode(node);
      if (!node) {
        setHoveredEdge(getMouseEdge(e));
      } else {
        setHoveredEdge(null);
      }
    },
    [dragNode, getMouseNode, getMouseEdge, getNodeById],
  );

  const dragStartPos = useRef<{ x: number; y: number } | null>(null);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const node = getMouseNode(e);
      dragStartPos.current = { x: e.clientX, y: e.clientY };
      if (node) {
        setDragNode(node.id);
      }
    },
    [getMouseNode],
  );

  const handleMouseUp = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const start = dragStartPos.current;
      const wasDrag =
        start && (Math.abs(e.clientX - start.x) > 5 || Math.abs(e.clientY - start.y) > 5);

      if (!wasDrag) {
        const node = getMouseNode(e);
        if (node) {
          setFocusedNode((prev) => (prev === node.id ? null : node.id));
        } else {
          setFocusedNode(null);
        }
      }
      setDragNode(null);
      dragStartPos.current = null;
    },
    [getMouseNode],
  );

  const connectedAgents = edges.length;
  const totalProjects = new Set(edges.flatMap((e) => e.projects)).size;
  const focusedAgent = focusedNode ? agents.find((a) => a.id === focusedNode) : null;

  return (
    <GlassCard className="p-0 overflow-hidden" hover={false}>
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <div className="flex items-center gap-2">
          <Network className="w-4 h-4 text-primary" />
          <span className="text-xs font-mono font-bold text-foreground tracking-wider">
            COLLABORATION NETWORK
          </span>
          {focusedAgent && (
            <button
              onClick={() => setFocusedNode(null)}
              className="flex items-center gap-1.5 ml-2 px-2 py-0.5 rounded-md border border-border text-[10px] font-mono hover:bg-secondary transition-colors"
              style={{ color: focusedAgent.color, borderColor: `${focusedAgent.color}40` }}
            >
              <span>Focused: {focusedAgent.name}</span>
              <X className="w-3 h-3" />
            </button>
          )}
        </div>
        <div className="flex items-center gap-3">
          {/* Project filter */}
          <div className="relative">
            <button
              onClick={() => setFilterOpen(!filterOpen)}
              className={`flex items-center gap-1.5 px-2 py-1 rounded-md border text-[10px] font-mono transition-colors ${
                selectedProject
                  ? "border-primary/40 text-primary bg-primary/5"
                  : "border-border text-muted-foreground hover:text-foreground"
              }`}
            >
              <Filter className="w-3 h-3" />
              {selectedProject || "All Projects"}
              {selectedProject && (
                <span
                  className="ml-1 hover:text-foreground"
                  onClick={(e) => {
                    e.stopPropagation();
                    setSelectedProject(null);
                    setFilterOpen(false);
                  }}
                >
                  <X className="w-3 h-3" />
                </span>
              )}
            </button>
            <AnimatePresence>
              {filterOpen && (
                <motion.div
                  className="absolute right-0 top-full mt-1 z-50 glass-panel rounded-lg border border-border overflow-hidden min-w-[160px]"
                  initial={{ opacity: 0, y: -4, scale: 0.95 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: -4, scale: 0.95 }}
                  transition={{ duration: 0.15 }}
                >
                  <button
                    onClick={() => {
                      setSelectedProject(null);
                      setFilterOpen(false);
                    }}
                    className={`w-full text-left px-3 py-2 text-[10px] font-mono transition-colors ${
                      !selectedProject
                        ? "text-primary bg-primary/10"
                        : "text-muted-foreground hover:text-foreground hover:bg-secondary"
                    }`}
                  >
                    All Projects
                  </button>
                  {allProjects.map((project) => (
                    <button
                      key={project}
                      onClick={() => {
                        setSelectedProject(project);
                        setFilterOpen(false);
                      }}
                      className={`w-full text-left px-3 py-2 text-[10px] font-mono transition-colors ${
                        selectedProject === project
                          ? "text-primary bg-primary/10"
                          : "text-muted-foreground hover:text-foreground hover:bg-secondary"
                      }`}
                    >
                      {project}
                    </button>
                  ))}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
          <span className="text-[10px] font-mono text-muted-foreground hidden sm:inline">
            {connectedAgents} links · {totalProjects} projects
          </span>
          <button
            onClick={() => {
              const canvas = canvasRef.current;
              if (!canvas) {
                return;
              }
              const link = document.createElement("a");
              link.download = "collaboration-graph.png";
              link.href = canvas.toDataURL("image/png");
              link.click();
            }}
            className="text-muted-foreground hover:text-primary transition-colors"
            title="Export as PNG"
          >
            <Download className="w-4 h-4" />
          </button>
          <button
            onClick={() => setExpanded(!expanded)}
            className="text-muted-foreground hover:text-foreground transition-colors"
          >
            {expanded ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
          </button>
        </div>
      </div>

      <div
        ref={containerRef}
        className={`relative transition-all duration-300 ${expanded ? "h-[500px]" : "h-[300px]"}`}
      >
        <canvas
          ref={canvasRef}
          className="w-full h-full cursor-grab active:cursor-grabbing"
          onMouseMove={handleMouseMove}
          onMouseDown={handleMouseDown}
          onMouseUp={handleMouseUp}
          onMouseLeave={() => {
            setHoveredNode(null);
            setHoveredEdge(null);
            setDragNode(null);
            dragStartPos.current = null;
          }}
        />

        {/* Tooltip */}
        <AnimatePresence>
          {hoveredNode && !dragNode && (
            <motion.div
              className="absolute pointer-events-none glass-panel px-3 py-2 rounded-lg"
              style={{ left: hoveredNode.x + 25, top: hoveredNode.y - 20 }}
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.9 }}
              transition={{ duration: 0.15 }}
            >
              <div className="text-[11px] font-bold text-foreground">{hoveredNode.agent.name}</div>
              <div className="text-[9px] font-mono text-muted-foreground">
                {hoveredNode.agent.role}
              </div>
              <div className="text-[9px] font-mono mt-1" style={{ color: hoveredNode.agent.color }}>
                {hoveredNode.agent.currentTask}
              </div>
              <div className="text-[8px] font-mono text-muted-foreground mt-1">
                {
                  edges.filter((e) => e.source === hoveredNode.id || e.target === hoveredNode.id)
                    .length
                }{" "}
                connections
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Legend */}
        <div className="absolute bottom-12 left-3 flex items-center gap-3">
          {[
            { color: "#30D158", label: "Working" },
            { color: "#FFD60A", label: "Thinking" },
            { color: "#00C8FF", label: "Done" },
            { color: "#636366", label: "Idle" },
          ].map((item) => (
            <div key={item.label} className="flex items-center gap-1">
              <span className="w-2 h-2 rounded-full" style={{ backgroundColor: item.color }} />
              <span className="text-[8px] font-mono text-muted-foreground">{item.label}</span>
            </div>
          ))}
        </div>

        {/* Timeline slider */}
        <div className="absolute bottom-0 left-0 right-0 px-4 py-2 border-t border-border bg-card/80 backdrop-blur-sm">
          <div className="flex items-center gap-2">
            {/* Playback controls */}
            <button
              onClick={() => setIsPlaying(!isPlaying)}
              className="flex items-center justify-center w-6 h-6 rounded-md border border-border text-muted-foreground hover:text-primary hover:border-primary/40 transition-colors flex-shrink-0"
              title={isPlaying ? "Pause" : "Play timeline"}
            >
              {isPlaying ? <Pause className="w-3 h-3" /> : <Play className="w-3 h-3" />}
            </button>
            <button
              onClick={() => {
                setIsPlaying(false);
                setTimelineValue(0);
              }}
              className="flex items-center justify-center w-6 h-6 rounded-md border border-border text-muted-foreground hover:text-primary hover:border-primary/40 transition-colors flex-shrink-0"
              title="Reset to start"
            >
              <RotateCcw className="w-3 h-3" />
            </button>
            <button
              onClick={() => setPlaybackSpeed((s) => (s === 0.5 ? 1 : s === 1 ? 2 : 0.5))}
              className="flex items-center justify-center h-6 px-1.5 rounded-md border border-border text-muted-foreground hover:text-primary hover:border-primary/40 transition-colors flex-shrink-0 text-[9px] font-mono font-bold min-w-[32px]"
              title="Playback speed"
            >
              {playbackSpeed}x
            </button>
            <button
              onClick={() => setLoopMode(!loopMode)}
              className={`flex items-center justify-center w-6 h-6 rounded-md border transition-colors flex-shrink-0 ${
                loopMode
                  ? "border-primary/40 text-primary bg-primary/10"
                  : "border-border text-muted-foreground hover:text-primary hover:border-primary/40"
              }`}
              title={loopMode ? "Loop on" : "Loop off"}
            >
              <Repeat className="w-3 h-3" />
            </button>
            <Clock className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
            <span className="text-[9px] font-mono text-muted-foreground flex-shrink-0 w-[70px]">
              {minDate === maxDate ? "All time" : format(new Date(minDate), "MMM d")}
            </span>
            <div className="flex-1 relative group">
              <input
                type="range"
                min={0}
                max={100}
                value={timelineValue}
                onChange={(e) => {
                  setIsPlaying(false);
                  setTimelineValue(Number(e.target.value));
                }}
                className="w-full h-1 appearance-none bg-secondary rounded-full cursor-pointer
                  [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3
                  [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-primary [&::-webkit-slider-thumb]:shadow-[0_0_8px_hsl(var(--primary)/0.5)]
                  [&::-webkit-slider-thumb]:transition-transform [&::-webkit-slider-thumb]:hover:scale-125
                  [&::-moz-range-thumb]:w-3 [&::-moz-range-thumb]:h-3 [&::-moz-range-thumb]:rounded-full
                  [&::-moz-range-thumb]:bg-primary [&::-moz-range-thumb]:border-0"
              />
              {/* Active track overlay */}
              <div
                className="absolute top-1/2 left-0 h-1 rounded-full -translate-y-1/2 pointer-events-none bg-primary/40"
                style={{ width: `${timelineValue}%` }}
              />
            </div>
            <span className="text-[9px] font-mono text-muted-foreground flex-shrink-0 w-[70px] text-right">
              {minDate === maxDate ? "" : format(new Date(maxDate), "MMM d")}
            </span>
            <span className="text-[10px] font-mono text-primary flex-shrink-0 min-w-[85px] text-right">
              {timelineValue >= 100 ? "Present" : timelineDateStr}
            </span>
          </div>
        </div>
      </div>
    </GlassCard>
  );
}
