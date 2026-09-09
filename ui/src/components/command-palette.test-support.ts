import { vi } from "vitest";
import type { SessionsListResult } from "../api/types.ts";
import type { RouteId } from "../app-route-paths.ts";
import { createAgentSelectionCapability } from "../app/agent-selection.ts";
import type {
  ApplicationContext,
  ApplicationGateway,
  ApplicationGatewaySnapshot,
} from "../app/context.ts";
import { createApplicationContextProvider } from "../test-helpers/application-context.ts";
import {
  createTestGatewayClient,
  type GatewayRequestHandler,
} from "../test-helpers/gateway-client.ts";
import type { CommandPalette } from "./command-palette.ts";

type GatewayHarness = {
  gateway: ApplicationGateway;
  setConnected: (connected: boolean) => void;
  emit: (event: string) => void;
};

export function createGateway(
  connected: boolean,
  options: { methods?: string[]; request?: GatewayRequestHandler } = {},
): GatewayHarness {
  const client = createTestGatewayClient(options.request ?? (() => ({ models: [] })));
  let snapshot: ApplicationGatewaySnapshot = {
    client,
    phase: connected ? "connected" : "reconnecting",
    offlineStable: false,
    canvasPluginSurfaceUrl: null,
    hello: options.methods ? ({ features: { methods: options.methods } } as never) : null,
    assistantAgentId: "main",
    sessionKey: "main",
    lastError: null,
    lastErrorCode: null,
  };
  const listeners = new Set<(next: ApplicationGatewaySnapshot) => void>();
  const events = new Set<Parameters<ApplicationGateway["subscribeEvents"]>[0]>();
  const gateway = {
    get snapshot() {
      return snapshot;
    },
    connection: { gatewayUrl: "ws://localhost", token: "", bootstrapToken: "", password: "" },
    connectionRevision: 0,
    eventLog: [],
    eventLogRevision: 0,
    connect: () => undefined,
    setSessionKey: () => undefined,
    start: () => undefined,
    stop: () => undefined,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    subscribeEventLog: () => () => undefined,
    subscribeEvents(listener) {
      events.add(listener);
      return () => events.delete(listener);
    },
  } satisfies ApplicationGateway;
  return {
    gateway,
    emit(event) {
      for (const listener of events) {
        listener({ type: "event", event, payload: {} });
      }
    },
    setConnected(nextConnected) {
      snapshot = {
        ...snapshot,
        phase: nextConnected ? "connected" : "reconnecting",
      };
      for (const listener of listeners) {
        listener(snapshot);
      }
    },
  };
}

export function createContext(
  gateway: ApplicationGateway,
  list: ApplicationContext<RouteId>["sessions"]["list"],
): ApplicationContext<RouteId> {
  return {
    gateway,
    agentSelection: createAgentSelectionCapability(gateway, {
      state: { agentsList: null },
      subscribe: () => () => undefined,
    }),
    agents: {
      ensureList: async () => null,
    },
    sessions: {
      list,
      state: { result: null },
    },
  } as unknown as ApplicationContext<RouteId>;
}

export function createSessionResult(key: string, displayName: string): SessionsListResult {
  return {
    ts: 1,
    path: "",
    count: 1,
    defaults: {},
    sessions: [{ key, kind: "direct", displayName, updatedAt: 1 }],
  } as SessionsListResult;
}

export async function mountPalette(context: ApplicationContext<RouteId>) {
  const provider = createApplicationContextProvider(context);
  const palette = document.createElement("openclaw-command-palette") as CommandPalette;
  palette.onNavigate = vi.fn();
  palette.onSelectSession = vi.fn();
  provider.append(palette);
  document.body.append(provider);
  await palette.updateComplete;
  return { palette, provider };
}

export async function enterQuery(palette: CommandPalette, query: string) {
  palette.openPalette();
  await palette.updateComplete;
  const input = palette.querySelector<HTMLInputElement>(".cmd-palette__input");
  if (!input) {
    throw new Error("Expected command palette input");
  }
  input.value = query;
  input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  await palette.updateComplete;
}

export function findPaletteOption(palette: CommandPalette, label: string, exact = false) {
  return [...palette.querySelectorAll<HTMLElement>('[role="option"]')].find((item) => {
    const text = item.textContent?.replace(/\s+/g, " ").trim();
    return exact ? text === label : text?.includes(label);
  });
}
