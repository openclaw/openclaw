import { create } from "zustand";
import { getAgentZone } from "@/lib/pixel-engine/layout/zone-layouts";
import type { AgentRow } from "@/types/agents";

// --- Types ---

export type AgentActivity = "idle" | "typing" | "walking" | "thinking";

export type TeamRunEntry = {
  id: string;
  name: string;
  leader: string;
  memberAgentIds: string[];
  state: string;
};

export type AgentCharacter = {
  agentId: string;
  name: string;
  zone: string;
  seatIndex: number;
  hueShift: number;
  characterId: number;
};

// --- Store ---

export type VisualizeState = {
  isActive: boolean;
  agents: AgentCharacter[];
  agentActivity: Record<string, AgentActivity>;
  activeTeams: TeamRunEntry[];
  selectedAgentId: string | null;
  zoom: number;
  totalActiveCount: number;
  totalTokens: number;

  // Actions
  syncAgents: (agentList: AgentRow[]) => void;
  updateActivity: (agentId: string, state: AgentActivity) => void;
  setActiveTeams: (teams: TeamRunEntry[]) => void;
  handleAgentEvent: (payload: unknown) => void;
  handlePresenceEvent: (payload: unknown) => void;
  handleChatEvent: (payload: unknown) => void;
  setActive: (isActive: boolean) => void;
  setSelectedAgentId: (id: string | null) => void;
  setZoom: (zoom: number) => void;
  reset: () => void;
};

const ZOOM_STORAGE_KEY = "visualize-zoom";

function loadPersistedZoom(): number {
  try {
    const raw = localStorage.getItem(ZOOM_STORAGE_KEY);
    if (raw) {
      const parsed = Number(raw);
      if (Number.isFinite(parsed) && parsed > 0) {
        return parsed;
      }
    }
  } catch {
    // ignore storage errors
  }
  return 1;
}

const initialState = {
  isActive: false,
  agents: [] as AgentCharacter[],
  agentActivity: {} as Record<string, AgentActivity>,
  activeTeams: [] as TeamRunEntry[],
  selectedAgentId: null as string | null,
  zoom: loadPersistedZoom(),
  totalActiveCount: 0,
  totalTokens: 0,
};

/** Track per-zone seat indices for deterministic character placement */
function mapAgentsToCharacters(agentList: AgentRow[]): AgentCharacter[] {
  const zoneSeatCounters: Record<string, number> = {};

  return agentList.map((agent, idx) => {
    const name = agent.name ?? agent.id;
    const zoneEntry = getAgentZone(name);
    const zone = zoneEntry.zone;

    const seatIndex = zoneSeatCounters[zone] ?? 0;
    zoneSeatCounters[zone] = seatIndex + 1;

    return {
      agentId: agent.id,
      name,
      zone,
      seatIndex,
      hueShift: zoneEntry.hueShift,
      characterId: idx,
    };
  });
}

export const useVisualizeStore = create<VisualizeState>((set) => ({
  ...initialState,

  syncAgents: (agentList) =>
    set(() => {
      const agents = mapAgentsToCharacters(agentList);
      return {
        agents,
        totalActiveCount: agents.length,
      };
    }),

  updateActivity: (agentId, state) =>
    set((prev) => ({
      agentActivity: { ...prev.agentActivity, [agentId]: state },
    })),

  setActiveTeams: (teams) => set({ activeTeams: teams }),

  handleAgentEvent: (payload) => {
    const evt = payload as
      | {
          type?: string;
          agentId?: string;
          agents?: AgentRow[];
        }
      | undefined;
    if (!evt) {
      return;
    }

    // Full agent list refresh
    if (evt.agents && Array.isArray(evt.agents)) {
      set(() => {
        const agents = mapAgentsToCharacters(evt.agents!);
        return { agents, totalActiveCount: agents.length };
      });
      return;
    }

    // Single agent lifecycle events
    if (evt.type === "stopped" && evt.agentId) {
      set((prev) => {
        const agents = prev.agents.filter((a) => a.agentId !== evt.agentId);
        const { [evt.agentId!]: _, ...activity } = prev.agentActivity;
        return {
          agents,
          agentActivity: activity,
          totalActiveCount: agents.length,
          selectedAgentId: prev.selectedAgentId === evt.agentId ? null : prev.selectedAgentId,
        };
      });
    }
  },

  handlePresenceEvent: (payload) => {
    const evt = payload as
      | {
          presence?: Array<{ clientId?: string; mode?: string }>;
        }
      | undefined;
    if (!evt?.presence || !Array.isArray(evt.presence)) {
      return;
    }

    set((prev) => ({
      totalActiveCount: Math.max(prev.agents.length, evt.presence!.length),
    }));
  },

  handleChatEvent: (payload) => {
    const evt = payload as
      | {
          agentId?: string;
          state?: string;
          runId?: string;
          sessionKey?: string;
        }
      | undefined;
    if (!evt?.agentId) {
      return;
    }

    const agentId = evt.agentId;

    if (evt.state === "started" || evt.state === "delta") {
      set((prev) => ({
        agentActivity: { ...prev.agentActivity, [agentId]: "typing" },
      }));
    } else if (evt.state === "final" || evt.state === "error") {
      set((prev) => ({
        agentActivity: { ...prev.agentActivity, [agentId]: "idle" },
      }));
    }
  },

  setActive: (isActive) => set({ isActive }),

  setSelectedAgentId: (id) => set({ selectedAgentId: id }),

  setZoom: (zoom) => {
    try {
      localStorage.setItem(ZOOM_STORAGE_KEY, String(zoom));
    } catch {
      // ignore storage errors
    }
    set({ zoom });
  },

  reset: () => set(initialState),
}));
