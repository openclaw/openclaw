import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, vi } from "vitest";
import {
  captureStateDatabaseCoordinatorRuntime,
  withStateDatabaseCoordinatorRuntimeDirectory,
} from "../../infra/state-database-coordinator.js";
import { AsyncWorkScope } from "../../shared/async-work-scope.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { drainSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { disposeSessionReadContexts } from "../session-read-contexts.test-support.js";
import { deletePersistentSessionStoreRows } from "../test/persistent-session-store.test-support.js";
import { flushPendingSessionsChangedEvents } from "./session-change-event.js";

export function setupSessionMutationState() {
  let state: OpenClawTestState;
  beforeAll(async () => {
    state = await createOpenClawTestState({ scenario: "minimal" });
  });
  beforeEach(() => {
    state.applyEnv();
  });
  afterAll(async () => {
    await state?.cleanup();
  });
  afterEach(async () => {
    await flushPendingSessionsChangedEvents();
    await disposeSessionReadContexts();
    await drainSessionStateForTest({ stateDir: state.stateDir, rootPath: state.root });
    vi.restoreAllMocks();
    await deletePersistentSessionStoreRows({
      agentId: "main",
      storePath: path.join(state.sessionsDir(), "sessions.json"),
    });
    await drainSessionStateForTest({ stateDir: state.stateDir, rootPath: state.root });
  });
  return async (run: (state: OpenClawTestState) => Promise<void>) => {
    await withStateDatabaseCoordinatorRuntimeDirectory(
      { ...captureStateDatabaseCoordinatorRuntime(), keepAlive: false },
      async () => {
        const work = new AsyncWorkScope();
        try {
          await work.track(() => run(state));
        } finally {
          await work.drain();
        }
      },
    );
  };
}
