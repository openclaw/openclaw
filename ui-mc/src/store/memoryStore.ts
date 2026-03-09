import { create } from "zustand";
import { persist } from "zustand/middleware";

export type MemoryCategory = "business" | "personal" | "technical" | "family" | "goals";

export interface Memory {
  id: string;
  content: string;
  category: MemoryCategory;
  tags: string[];
  agentId: string;
  pinned: boolean;
  importance: number;
  createdAt: string;
}

const SEED: Memory[] = [
  {
    id: "1",
    content: "Preferred investor deck format: 12 slides max, dark theme, metrics-first approach",
    category: "business",
    tags: ["investors", "presentations"],
    agentId: "vance",
    pinned: true,
    importance: 5,
    createdAt: "2026-03-01",
  },
  {
    id: "2",
    content: "Weekly gym schedule: Mon/Wed/Fri mornings at 6am, focus on compound lifts",
    category: "personal",
    tags: ["health", "routine"],
    agentId: "nova",
    pinned: false,
    importance: 3,
    createdAt: "2026-03-02",
  },
  {
    id: "3",
    content: "YETOMO API uses REST with JWT auth. Base URL: api.yetomo.com/v2",
    category: "technical",
    tags: ["api", "yetomo"],
    agentId: "dev",
    pinned: true,
    importance: 5,
    createdAt: "2026-02-28",
  },
  {
    id: "4",
    content: "Wife birthday: April 14. She mentioned wanting a spa weekend.",
    category: "family",
    tags: ["birthday", "gifts"],
    agentId: "ember",
    pinned: true,
    importance: 5,
    createdAt: "2026-03-05",
  },
  {
    id: "5",
    content: "Q2 Goal: Launch ITSON FSM to 50 beta customers by end of April",
    category: "goals",
    tags: ["q2", "itson"],
    agentId: "aria",
    pinned: true,
    importance: 5,
    createdAt: "2026-03-01",
  },
  {
    id: "6",
    content: "Best performing LinkedIn post format: problem → insight → CTA. Aim for 150 words.",
    category: "business",
    tags: ["content", "linkedin"],
    agentId: "echo",
    pinned: false,
    importance: 4,
    createdAt: "2026-03-04",
  },
  {
    id: "7",
    content: "DeepSeek R1 performs best for research tasks. Claude 3.5 for writing.",
    category: "technical",
    tags: ["ai", "models"],
    agentId: "sage",
    pinned: false,
    importance: 4,
    createdAt: "2026-03-03",
  },
  {
    id: "8",
    content: "Kids school pickup is at 3:15pm. Emergency contact: Mom.",
    category: "family",
    tags: ["school", "routine"],
    agentId: "ember",
    pinned: false,
    importance: 3,
    createdAt: "2026-03-06",
  },
];

interface MemoryStore {
  memories: Memory[];
  addMemory: (m: Omit<Memory, "id" | "createdAt">) => void;
  togglePin: (id: string) => void;
  deleteMemory: (id: string) => void;
}

export const useMemoryStore = create<MemoryStore>()(
  persist(
    (set) => ({
      memories: SEED,
      addMemory: (m) =>
        set((s) => ({
          memories: [
            { ...m, id: crypto.randomUUID(), createdAt: new Date().toISOString() },
            ...s.memories,
          ],
        })),
      togglePin: (id) =>
        set((s) => ({
          memories: s.memories.map((m) => (m.id === id ? { ...m, pinned: !m.pinned } : m)),
        })),
      deleteMemory: (id) => set((s) => ({ memories: s.memories.filter((m) => m.id !== id) })),
    }),
    { name: "mavis-memory" },
  ),
);
