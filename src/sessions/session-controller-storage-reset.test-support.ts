import { readGlobalSingleton } from "../shared/global-singleton.js";
import type * as storage from "./session-controller.storage.js";

type ControllerState = {
  controllers: typeof storage.sessionControllers;
  entriesByAlias: typeof storage.sessionControllerEntriesByAlias;
  entriesByStore: typeof storage.sessionControllerEntriesByStore;
  rpcSourcesByRunId: typeof storage.rpcSourcesByRunId;
};

/** Reset storage only; file teardown first joins its original Stop owner. */
export function resetSessionControllerStorageForTest(): void {
  const state = readGlobalSingleton(Symbol.for("openclaw.sessionControllers")) as
    | ControllerState
    | undefined;
  if (!state) {
    return;
  }
  for (const entry of state.controllers.values()) {
    entry.active?.watchdog.close();
    for (const operation of entry.lifecycle?.operations ?? []) {
      operation.watchdog.close();
    }
    for (const waiter of entry.waiters) {
      waiter.finish(false);
    }
  }
  state.controllers.clear();
  state.entriesByAlias.clear();
  state.entriesByStore.clear();
  state.rpcSourcesByRunId.clear();
}
