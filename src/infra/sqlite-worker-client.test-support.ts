import type { Actor } from "./sqlite-worker-broker.types.js";
import { SqliteWorkerSlotCustody } from "./sqlite-worker-request-custody.js";

export function createSqliteWorkerClientActor(): Actor {
  const custody = new SqliteWorkerSlotCustody().createRequest();
  custody.activate();
  custody.accept();
  custody.post();
  return {
    nativeStopped: Promise.resolve(),
    markNativeStopped() {},
    id: 1,
    key: "client-fixture",
    databasePath: "/fixture/state.sqlite",
    stateAccess: {
      canonicalPath: "/fixture/state.sqlite",
      async prepareAccess() {
        return () => {};
      },
      assertReadAllowed() {},
    },
    pathReferences: new Map([["/fixture/state.sqlite", 1]]),
    moduleUrl: "file:///fixture/sqlite-backend.js",
    inputHash: "client-fixture",
    get slot(): never {
      throw new Error("Client scope must not access the broker's native Worker slot");
    },
    references: 1,
    opened: Promise.resolve(),
    openDispatch: { custody },
    initialized: true,
    backendClosed: false,
  };
}
