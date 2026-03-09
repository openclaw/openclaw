import { create } from "zustand";
import { persist } from "zustand/middleware";

export type EventType = "meeting" | "deadline" | "personal" | "workflow";

export interface CalendarEvent {
  id: string;
  title: string;
  date: string;
  time: string;
  type: EventType;
  agents: string[];
  description?: string;
}

const SEED: CalendarEvent[] = [
  {
    id: "1",
    title: "Daily Standup",
    date: "2026-03-08",
    time: "09:00",
    type: "meeting",
    agents: ["aria"],
    description: "All agents brief status",
  },
  {
    id: "2",
    title: "Investor Call - Vertex",
    date: "2026-03-09",
    time: "14:00",
    type: "meeting",
    agents: ["aria", "vance"],
    description: "Series A discussion with Marcus Chen",
  },
  {
    id: "3",
    title: "BION API Release",
    date: "2026-03-12",
    time: "10:00",
    type: "deadline",
    agents: ["dev", "sage"],
    description: "Ship BION public API",
  },
  {
    id: "4",
    title: "Gym - Leg Day",
    date: "2026-03-08",
    time: "06:00",
    type: "personal",
    agents: ["nova"],
  },
  {
    id: "5",
    title: "Content Review Session",
    date: "2026-03-09",
    time: "11:00",
    type: "meeting",
    agents: ["echo", "flux"],
  },
  {
    id: "6",
    title: "ITSON FSM Sprint Review",
    date: "2026-03-10",
    time: "15:00",
    type: "meeting",
    agents: ["dev", "vance"],
  },
  {
    id: "7",
    title: "ECHO//ONE Campaign Launch",
    date: "2026-03-11",
    time: "09:00",
    type: "workflow",
    agents: ["echo", "flux"],
  },
  {
    id: "8",
    title: "Family Dinner",
    date: "2026-03-08",
    time: "19:00",
    type: "personal",
    agents: ["ember"],
  },
  {
    id: "9",
    title: "Weekly Council Meeting",
    date: "2026-03-10",
    time: "10:00",
    type: "meeting",
    agents: ["aria", "vance", "dev", "echo", "flux", "nova", "sage", "ember"],
  },
  {
    id: "10",
    title: "YETOMO Public Release",
    date: "2026-03-20",
    time: "12:00",
    type: "deadline",
    agents: ["aria", "dev"],
  },
];

interface CalendarStore {
  events: CalendarEvent[];
  addEvent: (e: Omit<CalendarEvent, "id">) => void;
  deleteEvent: (id: string) => void;
}

export const useCalendarStore = create<CalendarStore>()(
  persist(
    (set) => ({
      events: SEED,
      addEvent: (e) => set((s) => ({ events: [...s.events, { ...e, id: crypto.randomUUID() }] })),
      deleteEvent: (id) => set((s) => ({ events: s.events.filter((e) => e.id !== id) })),
    }),
    { name: "mavis-calendar" },
  ),
);
