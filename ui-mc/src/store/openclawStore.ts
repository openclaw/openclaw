/**
 * OpenClaw State Store
 * Manages real OpenClaw connection and state
 */

import { create } from "zustand";
import { openclawWS, AgentStatus, SystemStatus } from "@/lib/openclawWebSocket";

interface OpenClawState {
  // Connection
  connected: boolean;
  connecting: boolean;
  error: string | null;

  // System Status
  systemStatus: SystemStatus | null;
  systemLoading: boolean;

  // Agents
  agents: AgentStatus[];
  agentsLoading: boolean;

  // Actions
  connect: () => Promise<void>;
  disconnect: () => void;
  refreshSystemStatus: () => Promise<void>;
  refreshAgents: () => Promise<void>;
  sendToAgent: (agentId: string, message: string) => Promise<void>;
  spawnAgent: (agentId: string, task?: string) => Promise<void>;
  killAgent: (agentId: string) => Promise<void>;

  // Internal
  _setConnected: (connected: boolean) => void;
  _setError: (error: string | null) => void;
  _setSystemStatus: (status: SystemStatus | null) => void;
  _setAgents: (agents: AgentStatus[]) => void;
}

export const useOpenClawStore = create<OpenClawState>((set, get) => ({
  // Initial state
  connected: false,
  connecting: false,
  error: null,
  systemStatus: null,
  systemLoading: false,
  agents: [],
  agentsLoading: false,

  // Actions
  connect: async () => {
    set({ connecting: true, error: null });

    try {
      // Setup event listeners before connecting
      openclawWS.on("connected", () => {
        get()._setConnected(true);
        get().refreshSystemStatus();
        get().refreshAgents();
      });

      openclawWS.on("disconnected", () => {
        get()._setConnected(false);
      });

      openclawWS.on("error", (error) => {
        get()._setError(error?.message || "WebSocket error");
      });

      openclawWS.on("agent.update", (agent: AgentStatus) => {
        const agents = [...get().agents];
        const index = agents.findIndex((a) => a.id === agent.id);
        if (index >= 0) {
          agents[index] = agent;
        } else {
          agents.push(agent);
        }
        get()._setAgents(agents);
      });

      openclawWS.on("system.update", (status: SystemStatus) => {
        get()._setSystemStatus(status);
      });

      // Connect
      await openclawWS.connect();
      set({ connecting: false });
    } catch (error) {
      set({
        connecting: false,
        error: error instanceof Error ? error.message : "Connection failed",
      });
    }
  },

  disconnect: () => {
    openclawWS.disconnect();
    set({ connected: false });
  },

  refreshSystemStatus: async () => {
    set({ systemLoading: true });
    try {
      const status = await openclawWS.getSystemStatus();
      get()._setSystemStatus(status);
    } catch (error) {
      console.error("Failed to refresh system status:", error);
    } finally {
      set({ systemLoading: false });
    }
  },

  refreshAgents: async () => {
    set({ agentsLoading: true });
    try {
      const agents = await openclawWS.getAgents();
      get()._setAgents(agents);
    } catch (error) {
      console.error("Failed to refresh agents:", error);
    } finally {
      set({ agentsLoading: false });
    }
  },

  sendToAgent: async (agentId: string, message: string) => {
    try {
      await openclawWS.sendToAgent(agentId, message);
      // Refresh agents to get updated status
      get().refreshAgents();
    } catch (error) {
      console.error(`Failed to send message to agent ${agentId}:`, error);
      throw error;
    }
  },

  spawnAgent: async (agentId: string, task?: string) => {
    try {
      await openclawWS.spawnAgent(agentId, task);
      // Refresh agents to get updated status
      get().refreshAgents();
    } catch (error) {
      console.error(`Failed to spawn agent ${agentId}:`, error);
      throw error;
    }
  },

  killAgent: async (agentId: string) => {
    try {
      await openclawWS.killAgent(agentId);
      // Refresh agents to get updated status
      get().refreshAgents();
    } catch (error) {
      console.error(`Failed to kill agent ${agentId}:`, error);
      throw error;
    }
  },

  // Internal setters
  _setConnected: (connected) => set({ connected }),
  _setError: (error) => set({ error }),
  _setSystemStatus: (systemStatus) => set({ systemStatus }),
  _setAgents: (agents) => set({ agents }),
}));

// Auto-connect on store initialization (in development)
if (typeof window !== "undefined") {
  // Connect when page loads
  window.addEventListener("load", () => {
    setTimeout(() => {
      const store = useOpenClawStore.getState();
      if (!store.connected && !store.connecting) {
        store.connect().catch(console.error);
      }
    }, 1000);
  });

  // Auto-refresh every 30 seconds
  setInterval(() => {
    const store = useOpenClawStore.getState();
    if (store.connected) {
      store.refreshSystemStatus().catch(console.error);
      store.refreshAgents().catch(console.error);
    }
  }, 30000);
}
