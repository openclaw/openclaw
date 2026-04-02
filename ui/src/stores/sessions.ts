import { create } from "zustand";

export interface Session {
  key: string;
  label?: string;
  agentId?: string;
  createdAt?: string;
  lastMessageAt?: string;
  messageCount?: number;
}

interface SessionsState {
  sessions: Session[];
  activeSessionKey: string | null;

  setSessions: (sessions: Session[]) => void;
  setActiveSessionKey: (key: string | null) => void;
  updateSession: (key: string, updates: Partial<Session>) => void;
  removeSession: (key: string) => void;
}

export const useSessionsStore = create<SessionsState>((set) => ({
  sessions: [],
  activeSessionKey: null,

  setSessions: (sessions) => set({ sessions }),
  setActiveSessionKey: (key) => set({ activeSessionKey: key }),
  updateSession: (key, updates) =>
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.key === key ? { ...s, ...updates } : s,
      ),
    })),
  removeSession: (key) =>
    set((state) => ({
      sessions: state.sessions.filter((s) => s.key !== key),
      activeSessionKey:
        state.activeSessionKey === key ? null : state.activeSessionKey,
    })),
}));
