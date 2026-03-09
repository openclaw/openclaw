import { create } from "zustand";
import { persist } from "zustand/middleware";

export type ContentStatus = "idea" | "draft" | "review" | "scheduled" | "published";
export type Platform = "linkedin" | "x" | "youtube" | "instagram";

export interface ContentItem {
  id: string;
  title: string;
  preview: string;
  platform: Platform;
  status: ContentStatus;
  assignedAgent: string;
  scheduledDate?: string;
  engagement?: { likes: number; shares: number; views: number };
  createdAt: string;
}

const SEED: ContentItem[] = [
  {
    id: "1",
    title: "AI in Business Operations",
    preview: "How AI agents are transforming the way we work...",
    platform: "linkedin",
    status: "published",
    assignedAgent: "echo",
    scheduledDate: "2026-03-06",
    engagement: { likes: 342, shares: 56, views: 4200 },
    createdAt: "2026-03-04",
  },
  {
    id: "2",
    title: "Building Your Second Brain",
    preview: "A thread on personal knowledge management...",
    platform: "x",
    status: "scheduled",
    assignedAgent: "echo",
    scheduledDate: "2026-03-09",
    createdAt: "2026-03-07",
  },
  {
    id: "3",
    title: "Behind the Scenes: MAVIS",
    preview: "Full walkthrough of the AI command center...",
    platform: "youtube",
    status: "draft",
    assignedAgent: "echo",
    createdAt: "2026-03-07",
  },
  {
    id: "4",
    title: "Monday Motivation",
    preview: "Visual carousel on building discipline...",
    platform: "instagram",
    status: "idea",
    assignedAgent: "echo",
    createdAt: "2026-03-08",
  },
  {
    id: "5",
    title: "The Future of FSM",
    preview: "Field service management with AI agents...",
    platform: "linkedin",
    status: "review",
    assignedAgent: "echo",
    scheduledDate: "2026-03-10",
    createdAt: "2026-03-06",
  },
  {
    id: "6",
    title: "Productivity Stack 2026",
    preview: "Tools and systems I use daily...",
    platform: "x",
    status: "draft",
    assignedAgent: "echo",
    createdAt: "2026-03-08",
  },
];

interface ContentStore {
  items: ContentItem[];
  addItem: (item: Omit<ContentItem, "id" | "createdAt">) => void;
  updateStatus: (id: string, status: ContentStatus) => void;
  deleteItem: (id: string) => void;
}

export const useContentStore = create<ContentStore>()(
  persist(
    (set) => ({
      items: SEED,
      addItem: (item) =>
        set((s) => ({
          items: [
            ...s.items,
            { ...item, id: crypto.randomUUID(), createdAt: new Date().toISOString() },
          ],
        })),
      updateStatus: (id, status) =>
        set((s) => ({ items: s.items.map((i) => (i.id === id ? { ...i, status } : i)) })),
      deleteItem: (id) => set((s) => ({ items: s.items.filter((i) => i.id !== id) })),
    }),
    { name: "mavis-content" },
  ),
);
