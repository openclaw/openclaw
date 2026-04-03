import { create } from "zustand";
import type {
  ConnectionStatus,
  ControlUIConfig,
  HealthSummary,
} from "@/gateway/types";

interface GatewayState {
  status: ConnectionStatus;
  config: ControlUIConfig | null;
  health: HealthSummary | null;
  error: string | null;

  setStatus: (status: ConnectionStatus) => void;
  setConfig: (config: ControlUIConfig) => void;
  setHealth: (health: HealthSummary) => void;
  setError: (error: string | null) => void;
  hydrateSnapshot: (snapshot: Record<string, unknown>) => void;
}

export const useGatewayStore = create<GatewayState>((set) => ({
  status: "disconnected",
  config: null,
  health: null,
  error: null,

  setStatus: (status) =>
    set({ status, error: status === "error" ? "Connection failed" : null }),
  setConfig: (config) => set({ config }),
  setHealth: (health) => set({ health }),
  setError: (error) => set({ error }),
  hydrateSnapshot: (snapshot) => {
    if (snapshot.health) set({ health: snapshot.health as HealthSummary });
  },
}));
