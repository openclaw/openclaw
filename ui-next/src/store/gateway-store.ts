import { create } from "zustand";
import type { GatewayHelloOk } from "@/lib/gateway-client";

export type ConnectionStatus = "disconnected" | "connecting" | "connected" | "error";

export type PresenceEntry = {
  clientId?: string;
  mode?: string;
  instanceId?: string;
  platform?: string;
  version?: string;
  connectedAtMs?: number;
  lastSeenMs?: number;
  [key: string]: unknown;
};

export type GatewayState = {
  // Connection
  connectionStatus: ConnectionStatus;
  lastError: string | null;
  hello: GatewayHelloOk | null;

  // Snapshot data
  presenceEntries: PresenceEntry[];
  healthSnapshot: unknown | null;

  // Session
  sessionKey: string;

  // Event log (for debug page)
  eventLog: Array<{ ts: number; event: string; payload?: unknown }>;

  // Actions
  setConnectionStatus: (status: ConnectionStatus) => void;
  setLastError: (error: string | null) => void;
  setHello: (hello: GatewayHelloOk) => void;
  applySnapshot: (hello: GatewayHelloOk) => void;
  setPresenceEntries: (entries: PresenceEntry[]) => void;
  setSessionKey: (key: string) => void;
  pushEvent: (event: string, payload?: unknown) => void;
  clearEventLog: () => void;
  reset: () => void;
};

const initialState = {
  connectionStatus: "disconnected" as ConnectionStatus,
  lastError: null as string | null,
  hello: null as GatewayHelloOk | null,
  presenceEntries: [] as PresenceEntry[],
  healthSnapshot: null as unknown | null,
  sessionKey: "main",
  eventLog: [] as Array<{ ts: number; event: string; payload?: unknown }>,
};

export const useGatewayStore = create<GatewayState>((set) => ({
  ...initialState,

  setConnectionStatus: (status) => set({ connectionStatus: status }),

  setLastError: (error) => set({ lastError: error }),

  setHello: (hello) => set({ hello }),

  applySnapshot: (hello) => {
    const snapshot = hello.snapshot as { presence?: PresenceEntry[]; health?: unknown } | undefined;

    set((state) => ({
      hello,
      connectionStatus: "connected",
      lastError: null,
      presenceEntries: Array.isArray(snapshot?.presence)
        ? snapshot.presence
        : state.presenceEntries,
      healthSnapshot: snapshot?.health ?? state.healthSnapshot,
    }));
  },

  setPresenceEntries: (entries) => set({ presenceEntries: entries }),

  setSessionKey: (key) => set({ sessionKey: key }),

  pushEvent: (event, payload) =>
    set((state) => ({
      eventLog: [{ ts: Date.now(), event, payload }, ...state.eventLog].slice(0, 250),
    })),

  clearEventLog: () => set({ eventLog: [] }),

  reset: () => set(initialState),
}));
