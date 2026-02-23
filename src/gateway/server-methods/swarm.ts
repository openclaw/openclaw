import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DEFAULT_AGENT_WORKSPACE_DIR } from "../../agents/workspace.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

/**
 * Swarm RPC handlers — expose swarm state to the dashboard.
 *
 * Reads from the tasks.sqlite DB and swarm state directories
 * to provide a real-time view of worker agents.
 */

const _DB_NAME = "tasks.sqlite";
const SWARM_BASE_DIR = path.join(os.tmpdir(), "swarm");

type SwarmWorker = {
  id: string;
  name: string;
  status: "pending" | "running" | "done" | "failed" | "cancelled";
  branch?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  taskSpec?: string | null;
  swarmId: string;
  backend?: string | null;
  logTail?: string | null;
};

type SwarmGroup = {
  id: string;
  repo: string;
  baseBranch: string;
  createdAt: string;
  status: "active" | "completed" | "failed" | "cancelled";
  workers: SwarmWorker[];
};

type SwarmSnapshot = {
  swarms: SwarmGroup[];
  fetchedAt: number;
  hasActiveSwarm: boolean;
  totalWorkers: number;
  activeWorkers: number;
};

type SwarmAgentNode = {
  id: string;
  name: string;
  role: string;
  level: string;
  status: "active" | "idle" | "working" | "archived";
  trustScore: number;
  currentTask?: string | null;
  children: SwarmAgentNode[];
  specialty?: string | null;
  emoji?: string | null;
};

type SwarmHierarchy = {
  root: SwarmAgentNode;
  fetchedAt: number;
};

// Read the agents directory structure for hierarchy
async function readAgentProfiles(): Promise<SwarmAgentNode> {
  const agentsDir = path.join(DEFAULT_AGENT_WORKSPACE_DIR, "agents");

  // Load Jeeves profile from performance.json if available
  let jeevesPerf: { trustScore?: number; level?: string; role?: string } = {};
  try {
    const perfRaw = await fs.readFile(path.join(agentsDir, "jeeves", "performance.json"), "utf-8");
    jeevesPerf = JSON.parse(perfRaw);
  } catch {
    // defaults below
  }

  const root: SwarmAgentNode = {
    id: "jeeves",
    name: "Jeeves",
    role: jeevesPerf.role ?? "Manager",
    level: jeevesPerf.level ?? "L3",
    status: "active",
    trustScore: jeevesPerf.trustScore ?? 0.92,
    currentTask: null,
    children: [],
    specialty: "Sprint planning · Orchestration · Code review",
    emoji: "🎩",
  };

  // Check for agent profile directories
  try {
    const entries = await fs.readdir(agentsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith("_")) {
        continue;
      }
      if (entry.name === "jeeves") {
        continue;
      } // skip root

      const profileDir = path.join(agentsDir, entry.name);
      let soul = "";
      try {
        soul = await fs.readFile(path.join(profileDir, "SOUL.md"), "utf-8");
      } catch {
        // no SOUL.md
      }

      let perf: { trustScore?: number; level?: string; role?: string } = {};
      try {
        const perfRaw = await fs.readFile(path.join(profileDir, "performance.json"), "utf-8");
        perf = JSON.parse(perfRaw);
      } catch {
        // no performance.json
      }

      root.children.push({
        id: entry.name,
        name: entry.name.charAt(0).toUpperCase() + entry.name.slice(1),
        role: perf.role ?? "IC",
        level: perf.level ?? "L1",
        status: "idle",
        trustScore: perf.trustScore ?? 0.5,
        currentTask: null,
        children: [],
        specialty:
          soul
            .split("\n")
            .find((l) => l.startsWith("##"))
            ?.replace(/^#+\s*/, "") ?? null,
        emoji: null,
      });
    }
  } catch {
    // No agents directory yet — that's fine
  }

  // Overlay active swarm workers
  try {
    const swarmDir = SWARM_BASE_DIR;
    const swarmEntries = await fs.readdir(swarmDir, { withFileTypes: true });
    for (const entry of swarmEntries) {
      if (!entry.isDirectory()) {
        continue;
      }
      try {
        const statusFile = path.join(swarmDir, entry.name, "status.json");
        const raw = await fs.readFile(statusFile, "utf-8");
        const status = JSON.parse(raw) as {
          tasks?: Array<{ name?: string; status?: string; branch?: string }>;
        };
        for (const task of status.tasks ?? []) {
          if (task.status === "running") {
            const workerId = `swarm-${entry.name}-${task.branch ?? "unknown"}`;
            root.children.push({
              id: workerId,
              name: task.name ?? task.branch ?? "Worker",
              role: "Swarm Worker",
              level: "L1",
              status: "working",
              trustScore: 0.5,
              currentTask: task.name ?? null,
              children: [],
              specialty: "Parallel task execution",
              emoji: "⚡",
            });
          }
        }
      } catch {
        // skip bad swarm dirs
      }
    }
  } catch {
    // Swarm base dir doesn't exist — no active swarms
  }

  return root;
}

// Read swarm data from swarm dir and tasks.sqlite
async function readSwarmData(): Promise<SwarmSnapshot> {
  const swarms: SwarmGroup[] = [];
  let totalWorkers = 0;
  let activeWorkers = 0;

  // Check swarm directory for active swarm directories
  const swarmBase = SWARM_BASE_DIR;
  try {
    const entries = await fs.readdir(swarmBase, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const swarmDir = path.join(swarmBase, entry.name);

      try {
        const statusPath = path.join(swarmDir, "status.json");
        const raw = await fs.readFile(statusPath, "utf-8");
        const status = JSON.parse(raw) as {
          swarm_id?: string;
          repo?: string;
          base_branch?: string;
          created_at?: string;
          tasks?: Array<{
            task_id?: string;
            name?: string;
            status?: string;
            branch?: string;
            started_at?: string;
            completed_at?: string;
            spec?: string;
            backend?: string;
          }>;
        };

        const workers: SwarmWorker[] = (status.tasks ?? []).map((t) => {
          const w: SwarmWorker = {
            id: t.task_id ?? `${entry.name}-${t.branch ?? "unknown"}`,
            name: t.name ?? "Unnamed Task",
            status: (t.status as SwarmWorker["status"]) ?? "pending",
            branch: t.branch ?? null,
            startedAt: t.started_at ?? null,
            completedAt: t.completed_at ?? null,
            taskSpec: t.spec ?? null,
            swarmId: entry.name,
            backend: t.backend ?? null,
          };
          totalWorkers++;
          if (t.status === "running") {
            activeWorkers++;
          }
          return w;
        });

        const hasRunning = workers.some((w) => w.status === "running");
        const hasPending = workers.some((w) => w.status === "pending");
        const allDone = workers.every((w) => w.status === "done" || w.status === "cancelled");
        const hasFailed = workers.some((w) => w.status === "failed");

        swarms.push({
          id: status.swarm_id ?? entry.name,
          repo: status.repo ?? "unknown",
          baseBranch: status.base_branch ?? "main",
          createdAt: status.created_at ?? "",
          status: allDone
            ? "completed"
            : hasFailed
              ? "failed"
              : hasRunning || hasPending
                ? "active"
                : "completed",
          workers,
        });
      } catch {
        // Skip directories without valid status.json
      }
    }
  } catch {
    // Swarm base dir doesn't exist — no swarms
  }

  return {
    swarms,
    fetchedAt: Date.now(),
    hasActiveSwarm: activeWorkers > 0,
    totalWorkers,
    activeWorkers,
  };
}

export const swarmHandlers: GatewayRequestHandlers = {
  "swarm.list": async ({ respond }) => {
    try {
      const snapshot = await readSwarmData();
      respond(true, snapshot, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },
  "swarm.hierarchy": async ({ respond }) => {
    try {
      const root = await readAgentProfiles();
      respond(true, { root, fetchedAt: Date.now() } as SwarmHierarchy, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },
};
