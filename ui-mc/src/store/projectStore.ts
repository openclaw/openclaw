import { create } from "zustand";
import { persist } from "zustand/middleware";

export type ProjectHealth = "on_track" | "at_risk" | "blocked";

export interface Milestone {
  id: string;
  title: string;
  done: boolean;
  dueDate: string;
}

export interface Project {
  id: string;
  name: string;
  description: string;
  color: string;
  progress: number;
  health: ProjectHealth;
  agents: string[];
  milestones: Milestone[];
  deadline: string;
  createdAt: string;
}

const SEED: Project[] = [
  {
    id: "1",
    name: "YETOMO",
    description: "Staffing platform for temporary workforce management",
    color: "#00C8FF",
    progress: 72,
    health: "on_track",
    agents: ["aria", "vance", "dev"],
    milestones: [
      { id: "m1", title: "MVP Launch", done: true, dueDate: "2026-02-15" },
      { id: "m2", title: "Beta Testing", done: true, dueDate: "2026-03-01" },
      { id: "m3", title: "Public Release", done: false, dueDate: "2026-03-20" },
    ],
    deadline: "2026-03-20",
    createdAt: "2026-01-10",
  },
  {
    id: "2",
    name: "ITSON FSM",
    description: "Field service management SaaS platform",
    color: "#FFD60A",
    progress: 45,
    health: "at_risk",
    agents: ["dev", "vance"],
    milestones: [
      { id: "m4", title: "Core Engine", done: true, dueDate: "2026-02-20" },
      { id: "m5", title: "Mobile App", done: false, dueDate: "2026-03-15" },
    ],
    deadline: "2026-04-01",
    createdAt: "2026-01-20",
  },
  {
    id: "3",
    name: "BION",
    description: "Biotech research data aggregation tool",
    color: "#30D158",
    progress: 88,
    health: "on_track",
    agents: ["sage", "dev"],
    milestones: [
      { id: "m6", title: "Data Pipeline", done: true, dueDate: "2026-02-10" },
      { id: "m7", title: "Dashboard", done: true, dueDate: "2026-03-01" },
      { id: "m8", title: "API Release", done: false, dueDate: "2026-03-12" },
    ],
    deadline: "2026-03-12",
    createdAt: "2026-01-05",
  },
  {
    id: "4",
    name: "ECHO//ONE",
    description: "AI-powered content creation and distribution engine",
    color: "#BF5AF2",
    progress: 35,
    health: "on_track",
    agents: ["echo", "flux"],
    milestones: [
      { id: "m9", title: "Content AI", done: true, dueDate: "2026-02-25" },
      { id: "m10", title: "Multi-platform", done: false, dueDate: "2026-03-20" },
    ],
    deadline: "2026-04-10",
    createdAt: "2026-02-01",
  },
  {
    id: "5",
    name: "Leegra Holdings",
    description: "Investment portfolio management and reporting",
    color: "#FF2D55",
    progress: 15,
    health: "blocked",
    agents: ["vance", "aria"],
    milestones: [
      { id: "m11", title: "Structure Setup", done: true, dueDate: "2026-03-01" },
      { id: "m12", title: "Legal Review", done: false, dueDate: "2026-03-18" },
    ],
    deadline: "2026-04-15",
    createdAt: "2026-02-15",
  },
];

interface ProjectStore {
  projects: Project[];
  addProject: (p: Omit<Project, "id" | "createdAt">) => void;
  updateHealth: (id: string, health: ProjectHealth) => void;
  toggleMilestone: (projectId: string, milestoneId: string) => void;
}

export const useProjectStore = create<ProjectStore>()(
  persist(
    (set) => ({
      projects: SEED,
      addProject: (p) =>
        set((s) => ({
          projects: [
            ...s.projects,
            { ...p, id: crypto.randomUUID(), createdAt: new Date().toISOString() },
          ],
        })),
      updateHealth: (id, health) =>
        set((s) => ({ projects: s.projects.map((p) => (p.id === id ? { ...p, health } : p)) })),
      toggleMilestone: (projectId, milestoneId) =>
        set((s) => ({
          projects: s.projects.map((p) =>
            p.id === projectId
              ? {
                  ...p,
                  milestones: p.milestones.map((m) =>
                    m.id === milestoneId ? { ...m, done: !m.done } : m,
                  ),
                }
              : p,
          ),
        })),
    }),
    { name: "mavis-projects" },
  ),
);
