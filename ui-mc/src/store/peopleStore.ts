import { create } from "zustand";
import { persist } from "zustand/middleware";

export type RelationshipType =
  | "client"
  | "partner"
  | "investor"
  | "colleague"
  | "friend"
  | "family";

export interface Person {
  id: string;
  name: string;
  company: string;
  role: string;
  email: string;
  phone?: string;
  relationship: RelationshipType;
  lastInteraction: string;
  notes: string;
  health: number; // 1-5
}

const SEED: Person[] = [
  {
    id: "1",
    name: "Marcus Chen",
    company: "Vertex Capital",
    role: "Managing Partner",
    email: "marcus@vertex.vc",
    relationship: "investor",
    lastInteraction: "2026-03-06",
    notes: "Interested in Series A. Follow up on YETOMO metrics.",
    health: 5,
  },
  {
    id: "2",
    name: "Sarah Kim",
    company: "TechForge",
    role: "CTO",
    email: "sarah@techforge.io",
    relationship: "partner",
    lastInteraction: "2026-03-03",
    notes: "API integration partner for ITSON FSM.",
    health: 4,
  },
  {
    id: "3",
    name: "James Okafor",
    company: "Leegra Holdings",
    role: "Legal Counsel",
    email: "james@leegra.com",
    relationship: "colleague",
    lastInteraction: "2026-02-25",
    notes: "Reviewing holding company structure.",
    health: 3,
  },
  {
    id: "4",
    name: "Priya Patel",
    company: "GrowthLab",
    role: "Head of Marketing",
    email: "priya@growthlab.co",
    relationship: "partner",
    lastInteraction: "2026-03-07",
    notes: "Co-marketing campaign for ECHO//ONE launch.",
    health: 5,
  },
  {
    id: "5",
    name: "David Whitmore",
    company: "BioNex",
    role: "Research Director",
    email: "david@bionex.org",
    relationship: "client",
    lastInteraction: "2026-02-18",
    notes: "Pilot customer for BION. Needs follow-up.",
    health: 2,
  },
  {
    id: "6",
    name: "Mom",
    company: "Family",
    role: "Family",
    email: "",
    relationship: "family",
    lastInteraction: "2026-03-05",
    notes: "Sunday dinner planned.",
    health: 5,
  },
];

interface PeopleStore {
  people: Person[];
  addPerson: (p: Omit<Person, "id">) => void;
  updatePerson: (id: string, updates: Partial<Person>) => void;
  deletePerson: (id: string) => void;
}

export const usePeopleStore = create<PeopleStore>()(
  persist(
    (set) => ({
      people: SEED,
      addPerson: (p) => set((s) => ({ people: [...s.people, { ...p, id: crypto.randomUUID() }] })),
      updatePerson: (id, updates) =>
        set((s) => ({ people: s.people.map((p) => (p.id === id ? { ...p, ...updates } : p)) })),
      deletePerson: (id) => set((s) => ({ people: s.people.filter((p) => p.id !== id) })),
    }),
    { name: "mavis-people" },
  ),
);
