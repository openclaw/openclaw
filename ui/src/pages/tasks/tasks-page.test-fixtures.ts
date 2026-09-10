import { vi } from "vitest";
import type { GatewayBrowserClient, GatewayEventFrame } from "../../api/gateway.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import type { TaskSummary } from "../../lib/tasks/task-summary.ts";

export type TasksPageTestElement = HTMLElement & {
  context: ApplicationContext;
  tasks: TaskSummary[];
  error: string | null;
  copyResultError: string | null;
  cancellingTaskIds: Set<string>;
  cancelTask: (taskId: string) => Promise<void>;
  copyTaskResult: (taskId: string) => Promise<void>;
  recoverTask: (taskId: string, action: "retry" | "dismiss") => Promise<void>;
  refreshTasks: () => Promise<void>;
};

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

export function createGateway(
  client: GatewayBrowserClient,
  hello: ApplicationGatewaySnapshot["hello"] = null,
) {
  const snapshot: ApplicationGatewaySnapshot = {
    client,
    phase: "connected",
    offlineStable: false,
    canvasPluginSurfaceUrl: null,
    hello,
    assistantAgentId: null,
    sessionKey: "main",
    lastError: null,
    lastErrorCode: null,
  };
  let snapshotListener: ((snapshot: ApplicationGatewaySnapshot) => void) | undefined;
  const eventListeners = new Set<(event: GatewayEventFrame) => void>();
  const gateway = {
    snapshot,
    subscribe(listener: (snapshot: ApplicationGatewaySnapshot) => void) {
      snapshotListener = listener;
      return () => {
        if (snapshotListener === listener) {
          snapshotListener = undefined;
        }
      };
    },
    subscribeEvents(listener: (event: GatewayEventFrame) => void) {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
  } as unknown as ApplicationContext["gateway"];
  return {
    emitConnected(connected: boolean) {
      snapshot.phase = connected ? "connected" : "stopped";
      snapshotListener?.(snapshot);
    },
    emitTask(payload: unknown) {
      const event: GatewayEventFrame = { event: "task", payload, type: "event" };
      for (const listener of eventListeners) {
        listener(event);
      }
    },
    gateway,
  };
}

export function createContext(
  gateway: ApplicationContext["gateway"],
  scopeId: string | null = "main",
): ApplicationContext {
  const subscribe = () => () => undefined;
  return {
    basePath: "",
    gateway,
    agents: {
      state: {
        agentsList: {
          defaultId: scopeId ?? "main",
          mainKey: "main",
          agents: [{ id: "main" }, { id: "research" }, { id: "writer" }],
        },
      },
      ensureList: vi.fn(async () => undefined),
      subscribe,
    },
    agentSelection: {
      state: { selectedId: scopeId, scopeId },
      set: () => undefined,
      setScope: () => undefined,
      subscribe,
    },
    // Session rows carry the durable boardFace that generic navigation reads.
    sessions: {
      state: { result: null, loading: false },
      subscribe,
    },
    navigate: vi.fn(),
    preload: vi.fn(async () => undefined),
  } as unknown as ApplicationContext;
}
