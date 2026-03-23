import { create } from "zustand";

export interface DelegationEntry {
  runId: string;
  sessionKey?: string;
  childSessionKey: string;
  agentId: string | null;
  task: string | null;
  label: string | null;
  status: "spawned" | "running" | "completed" | "failed" | "stale";
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
  resultPreview: string | null;
  elapsedMs: number;
}

interface DelegationState {
  delegations: DelegationEntry[];
  setDelegations: (delegations: DelegationEntry[]) => void;
  clearDelegations: () => void;
}

export const useDelegationStore = create<DelegationState>((set) => ({
  delegations: [],
  setDelegations: (delegations) => set({ delegations }),
  clearDelegations: () => set({ delegations: [] }),
}));
