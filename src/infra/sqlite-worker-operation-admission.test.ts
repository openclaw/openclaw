import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MessageChannel, Worker } from "node:worker_threads";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  acquireGatewayStateOwner,
  assertStateDatabaseAccessAllowed,
} from "./gateway-state-owner.js";
import {
  deferSqlitePostCommitPublication,
  stageSqliteTransactionState,
  withSqlitePostCommitPublications,
} from "./sqlite-post-commit.js";
import { runSqliteImmediateTransactionSync } from "./sqlite-transaction.js";
import { settleSqliteWorkerJob } from "./sqlite-worker-broker-reply.js";
import type { Job } from "./sqlite-worker-broker.types.js";
import {
  createSqliteDatabaseAdmissionRelay,
  createSqliteWorkerOperationAdmission,
  exchangeSqliteDatabaseAdmissions,
  deferSqliteWorkerCommitReceipt,
  observeSqliteWorkerCommittedFacts,
  requestSqliteWorkerOperationAdmission,
  requestSqliteWorkerSchemaMaintenance,
  withSqliteWorkerOperationAdmission,
  type SqliteWorkerAdmissionRequest,
} from "./sqlite-worker-operation-admission.js";
import {
  settleSqliteWorkerOperationContext,
  type SqliteWorkerOperationContext,
} from "./sqlite-worker-operation-settlement.js";

afterEach(() => vi.restoreAllMocks());
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it.each([
  "revoke",
  "close",
  "late-close",
  "access-close",
  "self-fence",
  "request-revoke",
  "late-revoke",
] as const)("waits for the live owner's %s decision when host scheduling is delayed", (outcome) => {
  const revoked = new Error("Synthetic owner authority revoked");
  const observed: SqliteWorkerAdmissionRequest[] = [];
  let requestCurrent = outcome !== "request-revoke";
  let databaseCurrent = true;
  let inGrant = false;
  const beforeRelease = vi.fn();
  const admission = createSqliteWorkerOperationAdmission((_request, grant) => {
    if (outcome === "revoke") {
      throw revoked;
    }
    if (outcome === "self-fence") {
      requestCurrent = false;
    }
    if (outcome === "late-revoke") {
      databaseCurrent = false;
    }
    if (outcome === "late-close") {
      admission.finish();
    }
    inGrant = true;
    grant(beforeRelease);
  });
  admission.observeRequests((request) => {
    observed.push(request);
  });
  admission.bindDatabaseAuthority({
    databasePath: path.resolve("synthetic-delayed-writer.sqlite"),
    assertRequest() {
      if (!requestCurrent) {
        throw revoked;
      }
    },
    assertAccess() {
      if (outcome === "access-close" && inGrant) {
        admission.finish();
      }
      if (!databaseCurrent) {
        throw revoked;
      }
    },
    acquireSchema() {
      throw new Error("Ordinary admission must not acquire schema authority");
    },
  });
  const mutate = vi.fn();
  // Advance a delayed native wait without sleeping or blocking the test host.
  // The host has not run yet: elapsed time is not an authority decision.
  vi.spyOn(Atomics, "wait")
    .mockImplementationOnce(() => "timed-out")
    .mockImplementationOnce(() => {
      if (outcome === "close") {
        admission.finish();
      } else {
        admission.service();
      }
      return "ok";
    });
  const write = () =>
    withSqliteWorkerOperationAdmission({ port: admission.port }, () => {
      requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
      mutate();
    });
  try {
    if (outcome === "self-fence") {
      expect(write).not.toThrow();
      expect(beforeRelease).toHaveBeenCalledOnce();
      expect(mutate).toHaveBeenCalledOnce();
      expect(admission.failure).toBeUndefined();
      expect(admission.failureSource).toBeUndefined();
    } else {
      expect(write).toThrow("SQLite transaction admission was refused");
      expect(beforeRelease).not.toHaveBeenCalled();
      expect(mutate).not.toHaveBeenCalled();
      expect(admission.failure).toMatchObject({
        message: outcome.endsWith("close") ? "SQLite worker admission is closed" : revoked.message,
      });
      expect(admission.failureSource).toBe(outcome === "revoke" ? "domain" : "authority");
    }
    expect(observed).toEqual([{ stage: "transaction", facts: undefined }]);
    expect(admission.committed).toBeUndefined();
    expect(admission.settlement).toBeUndefined();
  } finally {
    admission.finish();
  }
});

it("rechecks database ownership after a worker request crosses the message port", () => {
  const root = tempDirs.make("openclaw-worker-admission-maintenance-");
  const databasePath = path.join(root, "state", "openclaw.sqlite");
  const admit = vi.fn((_request: SqliteWorkerAdmissionRequest, grant: () => boolean) => grant());
  const admission = createSqliteWorkerOperationAdmission(admit);
  let maintenance: ReturnType<typeof acquireGatewayStateOwner> | undefined;
  try {
    admission.bindDatabaseAuthority({
      databasePath,
      assertAccess: () => assertStateDatabaseAccessAllowed(databasePath),
      acquireSchema() {
        throw new Error("Ordinary admission must not acquire schema authority");
      },
    });
    const queueRequest = () => {
      const decision = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
      admission.port.postMessage({ stage: "transaction", decision: decision.buffer }, []);
      return decision;
    };
    const allowed = queueRequest();
    admission.service();
    expect(Atomics.load(allowed, 0)).toBe(1);
    expect(admit).toHaveBeenCalledOnce();
    admit.mockClear();

    const pending = queueRequest();
    maintenance = acquireGatewayStateOwner({ databasePath });
    admission.service();
    expect(Atomics.load(pending, 0)).toBe(2);
    expect(admit).not.toHaveBeenCalled();
    expect(admission.failure).toMatchObject({
      message: expect.stringContaining("undergoing offline maintenance"),
    });
    expect(admission.failureSource).toBe("authority");
  } finally {
    admission.finish();
    maintenance?.release();
  }
});

it("retains exact-target schema authority until settlement and rechecks access for later grants", () => {
  const databasePath = path.resolve("synthetic-schema.sqlite");
  const revoked = new Error("Database owner revoked");
  let current = true;
  const release = vi.fn();
  const acquireSchema = vi.fn(() => ({ assertCurrent() {}, release }));
  const admit = vi.fn((_request: SqliteWorkerAdmissionRequest, grant: () => boolean) => grant());
  const admission = createSqliteWorkerOperationAdmission(admit);
  admission.bindDatabaseAuthority({
    databasePath,
    assertAccess() {
      if (!current) {
        throw revoked;
      }
    },
    acquireSchema,
  });
  vi.spyOn(Atomics, "wait").mockImplementation(() => {
    admission.service();
    return "ok";
  });
  try {
    withSqliteWorkerOperationAdmission({ port: admission.port }, () => {
      expect(requestSqliteWorkerSchemaMaintenance(databasePath)).toBe(true);
      expect(requestSqliteWorkerSchemaMaintenance(databasePath)).toBe(true);
      requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: "ordinary write" });
      current = false;
      expect(() =>
        requestSqliteWorkerOperationAdmission({ stage: "commit", facts: "revoked write" }),
      ).toThrow("SQLite transaction admission was refused");
    });
    expect(acquireSchema).toHaveBeenCalledOnce();
    expect(admit).toHaveBeenCalledExactlyOnceWith(
      { stage: "transaction", facts: "ordinary write" },
      expect.any(Function),
    );
    expect(admission.failure).toBe(revoked);
    expect(release).not.toHaveBeenCalled();
    admission.finish();
    expect(release).toHaveBeenCalledOnce();
  } finally {
    admission.finish();
  }
});

it("refuses schema maintenance for a different database before acquiring authority", () => {
  const databasePath = path.resolve("synthetic-schema.sqlite");
  const admit = vi.fn();
  const acquireSchema = vi.fn(() => ({ assertCurrent() {}, release() {} }));
  const admission = createSqliteWorkerOperationAdmission(admit);
  admission.bindDatabaseAuthority({ databasePath, assertAccess() {}, acquireSchema });
  vi.spyOn(Atomics, "wait").mockImplementation(() => {
    admission.service();
    return "ok";
  });
  try {
    expect(() =>
      withSqliteWorkerOperationAdmission({ port: admission.port }, () =>
        requestSqliteWorkerSchemaMaintenance(path.resolve("another-schema.sqlite")),
      ),
    ).toThrow("SQLite transaction admission was refused");
    expect(admission.failure).toMatchObject({
      message: "SQLite schema maintenance target differs from its admitted database",
    });
    expect(acquireSchema).not.toHaveBeenCalled();
    expect(admit).not.toHaveBeenCalled();
  } finally {
    admission.finish();
  }
});

it.each(["admitted", "facts-only", "revoked", "different-path"] as const)(
  "keeps %s database creation under the current captured owner",
  (scenario) => {
    const root = tempDirs.make("sqlite-native-creation-");
    const databasePath = path.join(root, "admitted.sqlite");
    const requestedPath =
      scenario === "different-path" ? path.join(root, "other.sqlite") : databasePath;
    const admission = createSqliteWorkerOperationAdmission(() => {
      throw new Error("Format exchange must not request transaction authority");
    });
    if (scenario !== "facts-only") {
      admission.bindDatabaseAuthority({
        databasePath,
        assertAccess() {
          if (scenario === "revoked") {
            throw new Error("Captured creation owner was revoked");
          }
        },
        assertCreate(location) {
          if (location !== databasePath) {
            throw new Error("Creation target changed");
          }
        },
        acquireSchema() {
          throw new Error("File creation must not borrow migration authority");
        },
      });
    }
    vi.spyOn(Atomics, "wait").mockImplementation(() => {
      admission.service();
      return "ok";
    });
    try {
      const exchange = () =>
        exchangeSqliteDatabaseAdmissions(admission.port, [], requestedPath, true);
      if (scenario === "revoked" || scenario === "different-path") {
        expect(exchange).toThrow("SQLite admission facts exchange failed");
      } else {
        expect(exchange).not.toThrow();
      }
      expect(existsSync(requestedPath)).toBe(scenario === "admitted");
    } finally {
      admission.finish();
    }
  },
);

it.each(["unadmitted", "retired"] as const)(
  "refuses %s database creation relays before creating files",
  (scenario) => {
    const location = path.join(tempDirs.make("sqlite-refused-creation-relay-"), "absent.sqlite");
    const admission =
      scenario === "retired"
        ? createSqliteDatabaseAdmissionRelay(() => {
            throw new Error("Creation relay retired");
          })
        : createSqliteWorkerOperationAdmission(() => {
            throw new Error("File creation must not request transaction authority");
          });
    const { port1, port2 } = new MessageChannel();
    const decision = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
    try {
      admission.port.postMessage(
        {
          kind: "sqlite-database-admissions",
          admissions: [],
          location,
          create: "admitted",
          port: port2,
          decision: decision.buffer,
        },
        [port2],
      );
      admission.service();
      expect(Atomics.load(decision, 0)).toBe(2);
      expect(admission.failure).toMatchObject({
        message:
          scenario === "retired"
            ? "Creation relay retired"
            : "SQLite creation relay is not admitted",
      });
      expect(existsSync(location)).toBe(false);
    } finally {
      port1.close();
      port2.close();
      admission.finish();
    }
  },
);

it("reads a queued worker commit before settlement and message callbacks run", async () => {
  const admission = createSqliteWorkerOperationAdmission((_request, grant) => grant());
  const posted = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2));
  const worker = new Worker(
    `
    const { parentPort, workerData } = require("node:worker_threads");
    const posted = new Int32Array(workerData.posted);
    const committed = { version: 1, operationId: "queued-writer", sequence: 1, facts: { count: 1 } };
    workerData.port.postMessage({ kind: "native-commit", committed });
    Atomics.store(posted, 0, 1);
    Atomics.notify(posted, 0);
    Atomics.wait(posted, 1, 0, 10_000);
    workerData.port.postMessage({ kind: "native-settlement", settlement: {
      kind: "unknown", committed,
    } });
    workerData.port.close();
    Atomics.store(posted, 0, 2);
    Atomics.notify(posted, 0);
    parentPort.close();
  `,
    {
      eval: true,
      workerData: { port: admission.port, posted: posted.buffer },
      transferList: [admission.port],
    },
  );
  const joined = new Promise<number>((resolve, reject) => {
    worker.once("error", reject);
    worker.once("exit", resolve);
  });
  try {
    if (Atomics.load(posted, 0) === 0) {
      Atomics.wait(posted, 0, 0, 10_000);
    }
    expect(Atomics.load(posted, 0)).toBe(1);
    expect(admission.settlement).toBeUndefined();
    expect(admission.committed).toEqual({ facts: { count: 1 } });
    expect(admission.settlement).toBeUndefined();
    Atomics.store(posted, 1, 1);
    Atomics.notify(posted, 1);
    if (Atomics.load(posted, 0) === 1) {
      Atomics.wait(posted, 0, 1, 10_000);
    }
    expect(Atomics.load(posted, 0)).toBe(2);
    expect(admission.settlement).toBeUndefined();
    admission.finish();
    expect(admission.committed).toEqual({ facts: { count: 1 } });
    expect(admission.settlement).toEqual({ kind: "unknown", committed: { facts: { count: 1 } } });
    expect(await joined).toBe(0);
  } finally {
    Atomics.store(posted, 1, 1);
    Atomics.notify(posted, 1);
    admission.finish();
    await worker.terminate();
  }
});

it.each(["rollback", "unknown", "later rollback", "later commit", "same-value commit"] as const)(
  "keeps committed facts distinct from %s settlement",
  (outcome) => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE proof (value INTEGER)");
    const admission = createSqliteWorkerOperationAdmission((_request, grant) => grant());
    const published = vi.fn();
    observeSqliteWorkerCommittedFacts(admission, published);
    const owner: SqliteWorkerOperationContext = { port: admission.port };
    try {
      const write = (value: number, rollback = false) =>
        withSqliteWorkerOperationAdmission(owner, () =>
          withSqlitePostCommitPublications(db, () =>
            runSqliteImmediateTransactionSync(db, () => {
              db.prepare("INSERT INTO proof VALUES (?)").run(value);
              deferSqliteWorkerCommitReceipt(db, { value });
              if (rollback) {
                throw new Error("Rollback the synthetic write");
              }
            }),
          ),
        );
      if (outcome === "rollback") {
        expect(() => write(1, true)).toThrow("Rollback the synthetic write");
      } else {
        write(1);
        if (outcome === "later rollback") {
          expect(() => write(2, true)).toThrow("Rollback the synthetic write");
        } else if (outcome === "later commit") {
          write(2);
        } else if (outcome === "same-value commit") {
          write(1);
        }
      }
      const committed =
        outcome === "rollback"
          ? undefined
          : { facts: { value: outcome === "later commit" ? 2 : 1 } };
      expect(admission.settlement).toBeUndefined();
      expect(admission.committed).toEqual(committed);
      expect(admission.settlement).toBeUndefined();
      expect(() => admission.waitForSettlement(performance.now())).toThrow("settlement is unknown");
      settleSqliteWorkerOperationContext(owner, outcome === "unknown" ? "unknown" : "completed");
      if (outcome === "unknown") {
        expect(() => admission.waitForSettlement(performance.now())).toThrow(
          "settlement is unknown",
        );
        expect(admission.settlement).toEqual({
          kind: "unknown",
          committed: { facts: { value: 1 } },
        });
      } else {
        expect(admission.waitForSettlement(performance.now())).toEqual(
          committed ? { kind: "completed", committed } : { kind: "completed" },
        );
      }
      expect(db.prepare("SELECT value FROM proof ORDER BY value").all()).toEqual(
        outcome === "rollback"
          ? []
          : outcome === "later commit"
            ? [{ value: 1 }, { value: 2 }]
            : outcome === "same-value commit"
              ? [{ value: 1 }, { value: 1 }]
              : [{ value: 1 }],
      );
      admission.finish();
      expect(admission.committed).toEqual(committed);
      expect(published.mock.calls.map(([receipt]) => receipt.facts)).toEqual(
        outcome === "rollback"
          ? []
          : outcome === "later commit"
            ? [{ value: 1 }, { value: 2 }]
            : outcome === "same-value commit"
              ? [{ value: 1 }, { value: 1 }]
              : [{ value: 1 }],
      );
      if (outcome === "later commit") {
        expect(admission.waitForSettlement(performance.now()).committed).toEqual(committed);
      }
    } finally {
      admission.finish();
      db.close();
    }
  },
);

it.each([
  { receipt: "native commit", publicationFails: false },
  { receipt: "settlement fallback", publicationFails: false },
  { receipt: "native commit", publicationFails: true },
  { receipt: "settlement fallback", publicationFails: true },
  { receipt: "failed commit delivery", publicationFails: false },
  { receipt: "settlement only", publicationFails: false },
  { receipt: "settlement only", publicationFails: true },
] as const)(
  "installs $receipt before reply acknowledgement (publication failure: $publicationFails)",
  ({ receipt, publicationFails }) => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE proof (value INTEGER)");
    const ownerContext = new AsyncLocalStorage<string>();
    const admission = ownerContext.run("publication owner", () =>
      createSqliteWorkerOperationAdmission((_request, grant) => grant()),
    );
    const owner: SqliteWorkerOperationContext = { port: admission.port };
    const failure = new Error("Synthetic publication failed");
    const events: string[] = [];
    const publish = vi.fn((committed: { facts: unknown }) => {
      expect(ownerContext.getStore()).toBe("publication owner");
      expect(admission.committed).toBe(committed);
      events.push("publish");
      if (publicationFails) {
        throw failure;
      }
    });
    observeSqliteWorkerCommittedFacts(admission, publish);
    const postMessage = admission.port.postMessage.bind(admission.port);
    let nativeCommit: unknown;
    vi.spyOn(admission.port, "postMessage").mockImplementation((message) => {
      if (message.kind === "native-commit") {
        nativeCommit = message;
        if (receipt === "settlement fallback") {
          return;
        }
        if (receipt === "failed commit delivery") {
          throw new Error("Synthetic commit delivery failure");
        }
      }
      postMessage(message);
    });
    const resolve = vi.fn(() => events.push("reply"));
    const reject = vi.fn(() => events.push("reject"));
    const job: Job = {
      observation: { started() {}, completed() {} },
      request: { type: "execute", id: 1, actor: 1, input: new Uint8Array() },
      bytes: 0,
      nativeDispatched: true,
      operationAdmission: { admission, releaseService() {} },
      resolve,
      reject,
      detach() {},
    };
    try {
      withSqliteWorkerOperationAdmission(owner, () =>
        withSqlitePostCommitPublications(db, () =>
          runSqliteImmediateTransactionSync(db, () => {
            db.prepare("INSERT INTO proof VALUES (1)").run();
            deferSqliteWorkerCommitReceipt(
              db,
              { value: 1 },
              receipt === "settlement only" ? "settlement" : "commit",
            );
          }),
        ),
      );
      // Redelivery and settlement's retained copy must not repeat installation.
      if (receipt === "settlement only") {
        expect(nativeCommit).toBeUndefined();
      } else if (receipt !== "failed commit delivery") {
        admission.port.postMessage(nativeCommit, []);
      }
      settleSqliteWorkerOperationContext(owner, "completed");
      expect(events).toEqual([]);
      settleSqliteWorkerJob(job, undefined, { written: true });
      expect(events).toEqual(["publish", publicationFails ? "reject" : "reply"]);
      expect(publish).toHaveBeenCalledOnce();
      expect(db.prepare("SELECT value FROM proof").all()).toEqual([{ value: 1 }]);
      expect(admission.committed).toEqual({ facts: { value: 1 } });
      if (publicationFails) {
        expect(resolve).not.toHaveBeenCalled();
        expect(reject).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ code: "outcome-unknown", cause: failure }),
        );
      } else {
        expect(resolve).toHaveBeenCalledExactlyOnceWith({ written: true });
        expect(reject).not.toHaveBeenCalled();
      }
    } finally {
      admission.finish();
      db.close();
    }
  },
);

it("does not treat a grant or a lost settlement message as a committed receipt", () => {
  const admission = createSqliteWorkerOperationAdmission((_request, grant) => grant());
  const decision = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  try {
    admission.port.postMessage(
      {
        stage: "transaction",
        facts: undefined,
        decision: decision.buffer,
      },
      [],
    );
    admission.service();
    expect(Atomics.load(decision, 0)).toBe(1);
    expect(admission.committed).toBeUndefined();
    expect(() => admission.waitForSettlement(performance.now())).toThrow("settlement is unknown");
    expect(admission.settlement).toBeUndefined();
  } finally {
    admission.finish();
  }
});

it.each([
  "duplicate",
  "stale",
  "duplicate settlement",
  "malformed",
  "after settlement",
  "conflicting commit",
  "conflicting settlement",
  "stale settlement",
  "missing settlement receipt",
  "different operation",
] as const)("retains committed facts through %s receipt delivery", (delivery) => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE proof (value INTEGER)");
  const admission = createSqliteWorkerOperationAdmission((_request, grant) => grant());
  const owner = { port: admission.port };
  const published = vi.fn();
  observeSqliteWorkerCommittedFacts(admission, published);
  const frames: Array<{
    kind: "native-commit";
    committed: { version: number; operationId: string; sequence: number; facts: unknown };
  }> = [];
  const postMessage = admission.port.postMessage.bind(admission.port);
  vi.spyOn(admission.port, "postMessage").mockImplementation((message) => {
    if (message.kind === "native-commit") {
      frames.push(structuredClone(message));
    }
    postMessage(message);
  });
  try {
    for (const value of [1, 2]) {
      withSqliteWorkerOperationAdmission(owner, () =>
        withSqlitePostCommitPublications(db, () =>
          runSqliteImmediateTransactionSync(db, () => {
            db.prepare("INSERT INTO proof VALUES (?)").run(value);
            deferSqliteWorkerCommitReceipt(db, { value });
          }),
        ),
      );
    }
    admission.service();
    expect(published.mock.calls.map(([receipt]) => receipt.facts)).toEqual([
      { value: 1 },
      { value: 2 },
    ]);
    const [first, latest] = frames;
    if (!first || !latest) {
      throw new Error("Both real commits must produce receipt frames");
    }
    if (["duplicate", "stale", "duplicate settlement", "after settlement"].includes(delivery)) {
      settleSqliteWorkerOperationContext(owner, "completed");
    }
    if (delivery === "duplicate" || delivery === "stale") {
      postMessage(delivery === "duplicate" ? latest : first);
    } else if (
      [
        "duplicate settlement",
        "conflicting settlement",
        "stale settlement",
        "missing settlement receipt",
      ].includes(delivery)
    ) {
      postMessage({
        kind: "native-settlement",
        settlement: {
          kind: "completed",
          ...(delivery === "missing settlement receipt"
            ? {}
            : {
                committed:
                  delivery === "stale settlement"
                    ? first.committed
                    : {
                        ...latest.committed,
                        ...(delivery === "conflicting settlement" ? { facts: { value: 99 } } : {}),
                      },
              }),
        },
      });
    } else {
      postMessage({
        kind: "native-commit",
        committed:
          delivery === "malformed"
            ? null
            : {
                ...latest.committed,
                ...(delivery === "after settlement"
                  ? { sequence: latest.committed.sequence + 1 }
                  : {}),
                ...(delivery === "different operation" ? { operationId: "another-operation" } : {}),
                facts: { value: 99 },
              },
      });
    }
    admission.finish();
    expect(admission.committed).toEqual({ facts: { value: 2 } });
    expect(published).toHaveBeenCalledTimes(2);
    expect(db.prepare("SELECT value FROM proof ORDER BY value").all()).toEqual([
      { value: 1 },
      { value: 2 },
    ]);
    if (["duplicate", "stale", "duplicate settlement"].includes(delivery)) {
      expect(admission.failure).toBeUndefined();
      expect(admission.waitForSettlement(performance.now())).toEqual({
        kind: "completed",
        committed: { facts: { value: 2 } },
      });
    } else {
      expect(admission.failure).toMatchObject({ code: "outcome-unknown" });
      expect(admission.failureSource).toBe("protocol");
      expect(() => admission.waitForSettlement(performance.now())).toThrow("invalid");
    }
  } finally {
    admission.finish();
    db.close();
  }
});

it.each(["notification", "fact installation"] as const)(
  "retains native COMMIT evidence when earlier %s fails",
  (failure) => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE proof (value INTEGER)");
    const admission = createSqliteWorkerOperationAdmission((_request, grant) => grant());
    const owner = { port: admission.port };
    const fail = () => {
      throw new Error("Synthetic publication failure");
    };
    try {
      expect(() =>
        withSqliteWorkerOperationAdmission(owner, () =>
          withSqlitePostCommitPublications(db, () =>
            runSqliteImmediateTransactionSync(db, () => {
              db.prepare("INSERT INTO proof VALUES (1)").run();
              if (failure === "notification") {
                deferSqlitePostCommitPublication(db, fail);
              } else {
                stageSqliteTransactionState(db, { stage() {}, rollback() {}, commit: fail });
              }
              deferSqliteWorkerCommitReceipt(db, { value: 1 });
            }),
          ),
        ),
      ).not.toThrow();
      settleSqliteWorkerOperationContext(owner, "completed");
      expect(admission.waitForSettlement(performance.now())).toEqual({
        kind: "completed",
        committed: { facts: { value: 1 } },
      });
      expect(db.prepare("SELECT value FROM proof").all()).toEqual([{ value: 1 }]);
    } finally {
      admission.finish();
      db.close();
    }
  },
);

it("shares the active operation across module copies without mixing nested ports", async () => {
  vi.resetModules();
  const duplicate = await import("./sqlite-worker-operation-admission.js");
  expect(duplicate.withSqliteWorkerOperationAdmission).not.toBe(withSqliteWorkerOperationAdmission);
  const outer = new MessageChannel();
  const inner = new MessageChannel();
  // Only the carrier is under test here. Real cross-thread grants and revocation
  // are covered by the publication and public-runtime reclamation tests.
  const grant = (message: { decision: SharedArrayBuffer }) => {
    Atomics.store(new Int32Array(message.decision), 0, 1);
  };
  const outerRequests = vi.spyOn(outer.port1, "postMessage").mockImplementation(grant);
  const innerRequests = vi.spyOn(inner.port1, "postMessage").mockImplementation(grant);
  const request = (facts: string) =>
    duplicate.requestSqliteWorkerOperationAdmission({ stage: "transaction", facts });
  try {
    withSqliteWorkerOperationAdmission({ port: outer.port1 }, () => {
      request("outer-before");
      duplicate.withSqliteWorkerOperationAdmission({ port: inner.port1 }, () => request("inner"));
      request("outer-after");
    });
    expect(outerRequests.mock.calls.map(([message]) => message.facts)).toEqual([
      "outer-before",
      "outer-after",
    ]);
    expect(innerRequests.mock.calls.map(([message]) => message.facts)).toEqual(["inner"]);
    expect(() => request("outside")).toThrow("requires its retained admission");
  } finally {
    outer.port1.close();
    outer.port2.close();
    inner.port1.close();
    inner.port2.close();
  }
});

it("refuses escaped continuations and captured scopes after synchronous operation exit", async () => {
  vi.resetModules();
  const duplicate = await import("./sqlite-worker-operation-admission.js");
  const { port1, port2 } = new MessageChannel();
  const requests = vi.spyOn(port1, "postMessage");
  const schemaRequest = () => duplicate.requestSqliteWorkerSchemaMaintenance("synthetic.sqlite");
  const request = () =>
    duplicate.requestSqliteWorkerOperationAdmission({ stage: "commit", facts: undefined });
  try {
    const escaped = withSqliteWorkerOperationAdmission({ port: port1 }, () =>
      Promise.resolve().then(request),
    );
    await expect(escaped).rejects.toThrow("requires its retained admission");
    const escapedSchema = withSqliteWorkerOperationAdmission({ port: port1 }, () =>
      Promise.resolve().then(schemaRequest),
    );
    await expect(escapedSchema).rejects.toThrow("requires its retained admission");
    expect(schemaRequest()).toBe(false);
    const captured = withSqliteWorkerOperationAdmission({ port: port1 }, () =>
      AsyncLocalStorage.snapshot(),
    );
    expect(() => captured(request)).toThrow("requires its retained admission");
    expect(() => captured(schemaRequest)).toThrow("requires its retained admission");
    let failedScope: ReturnType<typeof AsyncLocalStorage.snapshot> | undefined;
    expect(() =>
      withSqliteWorkerOperationAdmission({ port: port1 }, () => {
        failedScope = AsyncLocalStorage.snapshot();
        throw new Error("operation failed");
      }),
    ).toThrow("operation failed");
    expect(failedScope).toBeDefined();
    expect(() => failedScope?.(request)).toThrow("requires its retained admission");
    expect(() => failedScope?.(schemaRequest)).toThrow("requires its retained admission");
    expect(requests).not.toHaveBeenCalled();
  } finally {
    port1.close();
    port2.close();
  }
});
