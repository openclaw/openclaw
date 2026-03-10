import { create } from "zustand";

interface CreateAgentParams {
  cloneId?: string;
  parentId?: string;
  department?: string;
}

interface CreateAgentStore {
  open: boolean;
  params: CreateAgentParams;
  openCreateAgent: (params?: CreateAgentParams) => void;
  closeCreateAgent: () => void;
}

export const useCreateAgentStore = create<CreateAgentStore>((set) => ({
  open: false,
  params: {},
  openCreateAgent: (params) => set({ open: true, params: params ?? {} }),
  closeCreateAgent: () => set({ open: false, params: {} }),
}));
