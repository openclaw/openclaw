import { create } from "zustand";

// ── Config dialog store ─────────────────────────────────────────────────────

interface AgentConfigDialogStore {
  open: boolean;
  agentId: string | null;
  openConfig: (agentId: string) => void;
  closeConfig: () => void;
}

export const useAgentConfigStore = create<AgentConfigDialogStore>((set) => ({
  open: false,
  agentId: null,
  openConfig: (agentId) => set({ open: true, agentId }),
  closeConfig: () => set({ open: false, agentId: null }),
}));

// ── Preview dialog store ────────────────────────────────────────────────────

interface AgentPreviewDialogStore {
  open: boolean;
  agentId: string | null;
  openPreview: (agentId: string) => void;
  closePreview: () => void;
}

export const useAgentPreviewStore = create<AgentPreviewDialogStore>((set) => ({
  open: false,
  agentId: null,
  openPreview: (agentId) => set({ open: true, agentId }),
  closePreview: () => set({ open: false, agentId: null }),
}));

// ── Health dialog store ─────────────────────────────────────────────────────

interface AgentHealthDialogStore {
  open: boolean;
  agentId: string | null;
  openHealth: (agentId: string) => void;
  closeHealth: () => void;
}

export const useAgentHealthStore = create<AgentHealthDialogStore>((set) => ({
  open: false,
  agentId: null,
  openHealth: (agentId) => set({ open: true, agentId }),
  closeHealth: () => set({ open: false, agentId: null }),
}));
