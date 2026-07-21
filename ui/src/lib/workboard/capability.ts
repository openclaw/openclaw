import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { normalizeBoardsPayload } from "./normalization.ts";
import {
  getWorkboardState,
  stopWorkboardLifecycleRefresh,
  stopWorkboardLiveRefresh,
} from "./runtime.ts";
import type { WorkboardUiState } from "./types.ts";

export type WorkboardCapability = {
  readonly state: WorkboardUiState;
  readonly boardsReady: boolean;
  notify: () => void;
  ensureBoards: (client: GatewayBrowserClient, force?: boolean) => Promise<boolean>;
  clearBoards: () => void;
  subscribe: (listener: () => void) => () => void;
  dispose: () => void;
};

export function createWorkboardCapability(): WorkboardCapability {
  const listeners = new Set<() => void>();
  let disposed = false;
  let boardsClient: GatewayBrowserClient | null = null;
  let boardsLoaded = false;
  let boardsLoad: { client: GatewayBrowserClient; promise: Promise<boolean> } | null = null;
  let boardsGeneration = 0;
  const capability: WorkboardCapability = {
    get state() {
      return getWorkboardState(capability);
    },
    get boardsReady() {
      return boardsLoaded;
    },
    notify() {
      if (disposed) {
        return;
      }
      for (const listener of listeners) {
        listener();
      }
    },
    async ensureBoards(client, force = false) {
      if (disposed) {
        return false;
      }
      if (boardsClient !== client) {
        boardsClient = client;
        boardsLoaded = false;
        boardsGeneration += 1;
        // A replacement client owns a new generation immediately. The old
        // request may finish, but its generation check prevents stale apply.
        boardsLoad = null;
        if (capability.state.boards.length > 0) {
          capability.state.boards = [];
          capability.notify();
        }
      }
      if (!force && boardsLoaded) {
        return false;
      }
      const currentLoad = boardsLoad;
      if (currentLoad?.client === client) {
        const loaded = await currentLoad.promise;
        if (disposed || boardsClient !== client) {
          return false;
        }
        if (!force) {
          return loaded;
        }
        if (boardsLoad && boardsLoad !== currentLoad) {
          return await boardsLoad.promise;
        }
        if (boardsLoad === currentLoad) {
          boardsLoad = null;
        }
        return await capability.ensureBoards(client, true);
      }
      const generation = ++boardsGeneration;
      const pending = (async () => {
        try {
          const boards = normalizeBoardsPayload(await client.request("workboard.boards.list", {}));
          if (!boards || disposed || boardsClient !== client || generation !== boardsGeneration) {
            return false;
          }
          capability.state.boards = boards;
          boardsLoaded = true;
          capability.notify();
          return true;
        } catch {
          return false;
        }
      })();
      const load = { client, promise: pending };
      boardsLoad = load;
      try {
        return await pending;
      } finally {
        if (boardsLoad === load) {
          boardsLoad = null;
        }
      }
    },
    clearBoards() {
      boardsClient = null;
      boardsLoaded = false;
      boardsGeneration += 1;
      boardsLoad = null;
      if (capability.state.boards.length > 0) {
        capability.state.boards = [];
        capability.notify();
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      disposed = true;
      boardsGeneration += 1;
      stopWorkboardLiveRefresh(capability);
      stopWorkboardLifecycleRefresh(capability);
      listeners.clear();
    },
  };
  return capability;
}
