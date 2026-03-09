import { create } from "zustand";
import { persist } from "zustand/middleware";

export type DocType = "proposal" | "sla" | "brief" | "report" | "template" | "contract";

export interface Doc {
  id: string;
  title: string;
  description: string;
  type: DocType;
  agentAuthor: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

const SEED: Doc[] = [
  {
    id: "1",
    title: "YETOMO Series A Proposal",
    description: "Investment proposal for Vertex Capital",
    type: "proposal",
    agentAuthor: "vance",
    tags: ["investment", "yetomo"],
    createdAt: "2026-02-20",
    updatedAt: "2026-03-06",
  },
  {
    id: "2",
    title: "ITSON FSM SLA Template",
    description: "Standard service level agreement for enterprise clients",
    type: "sla",
    agentAuthor: "aria",
    tags: ["legal", "itson"],
    createdAt: "2026-02-15",
    updatedAt: "2026-03-01",
  },
  {
    id: "3",
    title: "Q1 Performance Report",
    description: "Quarterly metrics across all projects",
    type: "report",
    agentAuthor: "sage",
    tags: ["quarterly", "metrics"],
    createdAt: "2026-03-02",
    updatedAt: "2026-03-07",
  },
  {
    id: "4",
    title: "ECHO//ONE Campaign Brief",
    description: "Launch campaign strategy and deliverables",
    type: "brief",
    agentAuthor: "flux",
    tags: ["marketing", "echo-one"],
    createdAt: "2026-03-04",
    updatedAt: "2026-03-07",
  },
  {
    id: "5",
    title: "Contractor Agreement Template",
    description: "Standard contractor agreement for YETOMO workers",
    type: "contract",
    agentAuthor: "aria",
    tags: ["legal", "hr"],
    createdAt: "2026-01-20",
    updatedAt: "2026-02-28",
  },
  {
    id: "6",
    title: "BION Research Methodology",
    description: "Data collection and analysis framework",
    type: "template",
    agentAuthor: "sage",
    tags: ["research", "bion"],
    createdAt: "2026-02-10",
    updatedAt: "2026-03-05",
  },
];

interface DocStore {
  docs: Doc[];
  addDoc: (d: Omit<Doc, "id" | "createdAt" | "updatedAt">) => void;
  deleteDoc: (id: string) => void;
}

export const useDocStore = create<DocStore>()(
  persist(
    (set) => ({
      docs: SEED,
      addDoc: (d) =>
        set((s) => ({
          docs: [
            {
              ...d,
              id: crypto.randomUUID(),
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
            ...s.docs,
          ],
        })),
      deleteDoc: (id) => set((s) => ({ docs: s.docs.filter((d) => d.id !== id) })),
    }),
    { name: "mavis-docs" },
  ),
);
