import type { GatewayBrowserClient } from "../gateway.ts";

export type SwarmWorker = {
  id: string;
  name: string;
  status: "pending" | "running" | "done" | "failed" | "cancelled";
  branch?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  taskSpec?: string | null;
  swarmId: string;
  backend?: string | null;
};

export type SwarmGroup = {
  id: string;
  repo: string;
  baseBranch: string;
  createdAt: string;
  status: "active" | "completed" | "failed" | "cancelled";
  workers: SwarmWorker[];
};

export type SwarmSnapshot = {
  swarms: SwarmGroup[];
  fetchedAt: number;
  hasActiveSwarm: boolean;
  totalWorkers: number;
  activeWorkers: number;
};

export type SwarmAgentNode = {
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

export type SwarmHierarchy = {
  root: SwarmAgentNode;
  fetchedAt: number;
};

export type SwarmState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  swarmLoading: boolean;
  swarmSnapshot: SwarmSnapshot | null;
  swarmHierarchy: SwarmHierarchy | null;
  swarmError: string | null;
};

export async function loadSwarmData(state: SwarmState) {
  if (!state.client || !state.connected) {
    return;
  }
  if (state.swarmLoading) {
    return;
  }

  state.swarmLoading = true;
  state.swarmError = null;

  try {
    const [snapshot, hierarchy] = await Promise.all([
      state.client.request("swarm.list", {}),
      state.client.request("swarm.hierarchy", {}),
    ]);
    state.swarmSnapshot = snapshot as SwarmSnapshot;
    state.swarmHierarchy = hierarchy as SwarmHierarchy;
  } catch (err) {
    state.swarmError = String(err);
  } finally {
    state.swarmLoading = false;
  }
}
