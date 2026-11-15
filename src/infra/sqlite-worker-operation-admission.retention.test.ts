import { AsyncLocalStorage } from "node:async_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import { expect, it } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import { forceFullGc } from "../test-utils/retention.js";
import { createSqliteDatabaseAdmissionCursor } from "./sqlite-database-admission.js";
import {
  bindSqliteWorkerDatabaseAdmissionCursor,
  createSqliteDatabaseAdmissionRelay,
  createSqliteWorkerOperationAdmission as createAdmission,
} from "./sqlite-worker-operation-admission.js";

const admitImmediately: Parameters<typeof createAdmission>[0] = (_request, release) => {
  release();
};

async function collect() {
  for (let pass = 0; pass < 4; pass++) {
    await nextTurn();
    forceFullGc();
  }
}

it.each(["admit", "prepare", "relay", "context", "cursor"] as const)(
  "releases finished %s captures from a retained admission without losing receipts",
  async (kind) => {
    const context = new AsyncLocalStorage<object>();
    function finishCaptured() {
      const payload = { marker: "synthetic finished admission" };
      const reference = new WeakRef(payload);
      const assertPayload = () => {
        expect(payload.marker).toBe("synthetic finished admission");
      };
      const admission =
        kind === "admit"
          ? createAdmission((_request, release) => {
              assertPayload();
              release();
            })
          : kind === "prepare"
            ? createAdmission(admitImmediately, undefined, async () => {
                assertPayload();
              })
            : kind === "relay"
              ? createSqliteDatabaseAdmissionRelay(assertPayload)
              : kind === "context"
                ? context.run(payload, () => createAdmission(admitImmediately))
                : createAdmission(admitImmediately);
      if (kind === "cursor") {
        bindSqliteWorkerDatabaseAdmissionCursor(
          admission,
          createSqliteDatabaseAdmissionCursor(),
          () => {
            assertPayload();
            return createSqliteDatabaseAdmissionCursor();
          },
        );
      }
      admission.port.postMessage(
        {
          kind: "native-settlement",
          settlement: {
            kind: "completed",
            committed: { version: 1, sequence: 1, facts: { revision: 1 } },
          },
        },
        [],
      );
      admission.finish();
      return { admission, reference };
    }
    const finished = finishCaptured();
    try {
      const control = new WeakRef({});
      await collect();
      expect(control.deref()).toBeUndefined();
      expect(finished.reference.deref()).toBeUndefined();
      expect(finished.admission.committed).toEqual({ facts: { revision: 1 } });
      expect(finished.admission.settlement).toEqual({
        kind: "completed",
        committed: { facts: { revision: 1 } },
      });
      expect(() => finished.admission.observeRequests(() => {})).toThrow("closed");
    } finally {
      finished.admission.finish();
      context.disable();
    }
  },
);

it("lets an accepted preparation settle after closure without admitting its delayed grant", async () => {
  const started = createDeferredCore();
  const release = createDeferredCore();
  const completed = createDeferredCore();
  let admitted = 0;
  function prepareCaptured() {
    const payload = { marker: "synthetic preparing admission" };
    const reference = new WeakRef(payload);
    const admission = createAdmission(
      (_request, grant) => {
        admitted++;
        grant();
      },
      undefined,
      async () => {
        started.resolve();
        await release.promise;
        expect(payload.marker).toBe("synthetic preparing admission");
        completed.resolve();
      },
    );
    return { admission, reference };
  }
  const pending = prepareCaptured();
  const decision = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  try {
    pending.admission.port.postMessage(
      {
        stage: "prepare",
        facts: { kind: "synthetic" },
        decision: decision.buffer,
      },
      [],
    );
    pending.admission.service();
    await started.promise;
    pending.admission.finish();
    expect(Atomics.load(decision, 0)).toBe(2);
    release.resolve();
    await completed.promise;
    const control = new WeakRef({});
    await collect();
    expect(control.deref()).toBeUndefined();
    expect(pending.reference.deref()).toBeUndefined();
    expect(admitted).toBe(0);
    expect(Atomics.load(decision, 0)).toBe(2);
  } finally {
    release.resolve();
    pending.admission.finish();
  }
});
