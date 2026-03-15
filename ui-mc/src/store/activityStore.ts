import { create } from "zustand";

export interface ActivityEvent {
  id: string;
  agentId: string;
  agentName: string;
  agentColor: string;
  action: string;
  timestamp: Date;
}

interface ActivityStore {
  events: ActivityEvent[];
  addEvent: (event: Omit<ActivityEvent, "id" | "timestamp">) => void;
  clearEvents: () => void;
}

export const useActivityStore = create<ActivityStore>()((set) => ({
  events: [],
  addEvent: (event) =>
    set((state) => ({
      events: [
        { ...event, id: crypto.randomUUID(), timestamp: new Date() },
        ...state.events.slice(0, 99),
      ],
    })),
  clearEvents: () => set({ events: [] }),
}));
