import { create } from "zustand";
import { persist } from "zustand/middleware";

export type ApprovalStatus = "pending" | "approved" | "rejected";
export type ApprovalType = "content" | "document" | "task" | "expense" | "access";

export interface Approval {
  id: string;
  title: string;
  type: ApprovalType;
  submittedBy: string;
  status: ApprovalStatus;
  preview: string;
  createdAt: string;
  resolvedAt?: string;
}

const SEED: Approval[] = [
  {
    id: "1",
    title: "LinkedIn post: AI in Business",
    type: "content",
    submittedBy: "echo",
    status: "pending",
    preview: "How AI agents are transforming business operations...",
    createdAt: "2026-03-07T10:30:00",
  },
  {
    id: "2",
    title: "YETOMO Series A Proposal",
    type: "document",
    submittedBy: "vance",
    status: "pending",
    preview: "Investment proposal for Vertex Capital review",
    createdAt: "2026-03-07T09:00:00",
  },
  {
    id: "3",
    title: "Marketing budget increase",
    type: "expense",
    submittedBy: "flux",
    status: "pending",
    preview: "Request $5K additional budget for ECHO//ONE launch campaign",
    createdAt: "2026-03-06T16:00:00",
  },
  {
    id: "4",
    title: "API v2.3 deployment",
    type: "task",
    submittedBy: "dev",
    status: "approved",
    preview: "Deploy new endpoints to production",
    createdAt: "2026-03-06T11:00:00",
    resolvedAt: "2026-03-06T14:00:00",
  },
  {
    id: "5",
    title: "New team member access",
    type: "access",
    submittedBy: "aria",
    status: "approved",
    preview: "Grant Morgan Blake access to all project repos",
    createdAt: "2026-03-05T09:00:00",
    resolvedAt: "2026-03-05T10:30:00",
  },
];

interface ApprovalStore {
  approvals: Approval[];
  approve: (id: string) => void;
  reject: (id: string) => void;
}

export const useApprovalStore = create<ApprovalStore>()(
  persist(
    (set) => ({
      approvals: SEED,
      approve: (id) =>
        set((s) => ({
          approvals: s.approvals.map((a) =>
            a.id === id
              ? { ...a, status: "approved" as const, resolvedAt: new Date().toISOString() }
              : a,
          ),
        })),
      reject: (id) =>
        set((s) => ({
          approvals: s.approvals.map((a) =>
            a.id === id
              ? { ...a, status: "rejected" as const, resolvedAt: new Date().toISOString() }
              : a,
          ),
        })),
    }),
    { name: "mavis-approvals" },
  ),
);
