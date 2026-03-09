import { create } from "zustand";
import { persist } from "zustand/middleware";

export type Availability = "available" | "busy" | "away" | "offline";

export interface TeamMember {
  id: string;
  name: string;
  role: string;
  avatar: string;
  availability: Availability;
  activeTasks: number;
  workload: number; // 0-100
  recentActivity: string;
}

const SEED: TeamMember[] = [
  {
    id: "1",
    name: "Alex Rivera",
    role: "Product Manager",
    avatar: "AR",
    availability: "available",
    activeTasks: 5,
    workload: 72,
    recentActivity: "Updated YETOMO roadmap",
  },
  {
    id: "2",
    name: "Jordan Lee",
    role: "Full Stack Developer",
    avatar: "JL",
    availability: "busy",
    activeTasks: 8,
    workload: 90,
    recentActivity: "Deployed API v2.3",
  },
  {
    id: "3",
    name: "Sam Torres",
    role: "Designer",
    avatar: "ST",
    availability: "available",
    activeTasks: 3,
    workload: 45,
    recentActivity: "Completed UI mockups",
  },
  {
    id: "4",
    name: "Casey Nguyen",
    role: "Marketing Lead",
    avatar: "CN",
    availability: "away",
    activeTasks: 4,
    workload: 60,
    recentActivity: "Launched email campaign",
  },
  {
    id: "5",
    name: "Morgan Blake",
    role: "Operations",
    avatar: "MB",
    availability: "available",
    activeTasks: 6,
    workload: 55,
    recentActivity: "Processed vendor invoices",
  },
];

interface TeamStore {
  members: TeamMember[];
  addMember: (m: Omit<TeamMember, "id">) => void;
  updateMember: (id: string, updates: Partial<TeamMember>) => void;
  removeMember: (id: string) => void;
}

export const useTeamStore = create<TeamStore>()(
  persist(
    (set) => ({
      members: SEED,
      addMember: (m) =>
        set((s) => ({ members: [...s.members, { ...m, id: crypto.randomUUID() }] })),
      updateMember: (id, updates) =>
        set((s) => ({ members: s.members.map((m) => (m.id === id ? { ...m, ...updates } : m)) })),
      removeMember: (id) => set((s) => ({ members: s.members.filter((m) => m.id !== id) })),
    }),
    { name: "mavis-team" },
  ),
);
