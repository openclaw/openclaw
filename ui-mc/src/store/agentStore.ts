import { create } from "zustand";
import { persist } from "zustand/middleware";
import { Agent, AGENT_DEFINITIONS } from "@/lib/agents";

interface AgentStore {
  agents: Agent[];
  updateAgentStatus: (id: string, status: Agent["status"]) => void;
  updateAgentProgress: (id: string, progress: number) => void;
  updateAgentTask: (id: string, task: string) => void;
  incrementCompleted: (id: string) => void;
  resetAgents: () => void;
}

export const useAgentStore = create<AgentStore>()(
  persist(
    (set) => ({
      agents: AGENT_DEFINITIONS,
      updateAgentStatus: (id, status) =>
        set((state) => ({
          agents: state.agents.map((a) => (a.id === id ? { ...a, status } : a)),
        })),
      updateAgentProgress: (id, progress) =>
        set((state) => ({
          agents: state.agents.map((a) => (a.id === id ? { ...a, progress } : a)),
        })),
      updateAgentTask: (id, task) =>
        set((state) => ({
          agents: state.agents.map((a) => (a.id === id ? { ...a, currentTask: task } : a)),
        })),
      incrementCompleted: (id) =>
        set((state) => ({
          agents: state.agents.map((a) =>
            a.id === id ? { ...a, tasksCompleted: a.tasksCompleted + 1 } : a,
          ),
        })),
      resetAgents: () => set({ agents: AGENT_DEFINITIONS }),
    }),
    {
      name: "mavis-agents",
      // Bump version whenever AGENT_DEFINITIONS schema changes to clear stale persisted data
      version: 2,
      migrate: () => ({ agents: AGENT_DEFINITIONS }),
    },
  ),
);
