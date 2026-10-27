import { beforeEach } from "vitest";
import {
  openOpenClawStateDatabase,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { useStateDatabaseTempDirs } from "../../test-utils/state-database-temp-dirs.js";
import type { WorkerSessionTurnClaim } from "./placement-record.js";
import {
  createWorkerSessionPlacementStore,
  type WorkerSessionPlacementStore,
} from "./placement-store.js";

function stateDirectories() {
  const directories = useStateDatabaseTempDirs();
  return () => directories.make("openclaw-placement-");
}

export function usePlacementStoreFixture(
  makeRoot = stateDirectories(),
  setup: (initialize: () => void) => unknown = beforeEach,
  now?: () => number,
) {
  let root: string;
  let database: OpenClawStateDatabase;
  let store: WorkerSessionPlacementStore;
  let nowMs = 1_000;
  function open() {
    database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    store = createWorkerSessionPlacementStore({ database, now: now ?? (() => nowMs) });
  }
  setup(() => {
    root = makeRoot();
    nowMs = 1_000;
    open();
  });
  return {
    open,
    toolTurn(
      source: WorkerSessionTurnClaim,
      toolName: "sessions_send" | "sessions_spawn" = "sessions_send",
    ) {
      const current = store;
      const call = { toolCallId: "call", requestDigest: "digest" };
      const request = { claim: source, toolName, ...call };
      const operation = {
        sourceSessionId: source.sessionId,
        sourceClaimId: source.claimId,
        ...call,
      };
      return {
        source,
        request,
        authorize: (names: string[] = [toolName]) =>
          current.authorizeWorkerTurnTools(source, names),
        begin: (assertCurrent?: () => void) =>
          current.beginWorkerSessionToolOperation(request, assertCurrent),
        authorized: (tool = toolName) => current.isWorkerTurnToolAuthorized(source, tool),
        complete: (resultJson = "{}") =>
          current.completeWorkerSessionToolOperation({ ...operation, resultJson }),
        close: () => current.closeWorkerTurnToolState(source),
        release: () => current.releaseTurn(source),
        abandon: async () => {
          await current.abandonWorkerSessionToolOperation(operation);
          await current.closeWorkerTurnToolState(source);
          await current.releaseTurn(source);
        },
      };
    },
    get root() {
      return root;
    },
    get database() {
      return database;
    },
    get store() {
      return store;
    },
    get nowMs() {
      return nowMs;
    },
    set nowMs(value: number) {
      nowMs = value;
    },
  };
}
