import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { serialize } from "node:v8";
import { MessageChannel, Worker } from "node:worker_threads";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveIdentityPathViaExistingAncestorSync } from "./boundary-path.js";
import {
  acquireGatewayStateOwner,
  assertStateDatabaseAccessAllowed,
} from "./gateway-state-owner.js";
import {
  deferSqlitePostCommitPublication,
  withSqlitePostCommitPublications,
} from "./sqlite-post-commit.js";
import { runSqliteImmediateTransactionSync } from "./sqlite-transaction.js";
import { settleSqliteWorkerJob } from "./sqlite-worker-broker-reply.js";
import type { Job } from "./sqlite-worker-broker.types.js";
import { SQLITE_WORKER_MAX_MESSAGE_BYTES } from "./sqlite-worker-contract.js";
import { exchangeSqliteDatabaseAdmissions } from "./sqlite-worker-database-admission-relay.js";
import {
  createSqliteDatabaseAdmissionRelay,
  type SqliteWorkerOperationAdmission,
  createSqliteWorkerOperationAdmission as createAdmission,
  deferCapturedSqliteWorkerCommitReceipt,
  deferSqliteWorkerCommitReceipt,
  observeSqliteWorkerCommittedFacts as observeCommits,
  requestSqliteWorkerOperationAdmission as requestAdmission,
  requestSqliteWorkerSchemaMaintenance as requestSchema,
  withSqliteWorkerOperationAdmission as withAdmission,
  type SqliteWorkerAdmissionRequest,
} from "./sqlite-worker-operation-admission.js";
import {
  captureSqliteWorkerCommitReceipt as captureReceipt,
  settleSqliteWorkerOperationContext as settleOperation,
  type SqliteWorkerOperationContext,
} from "./sqlite-worker-operation-settlement.js";
import {
  SqliteWorkerSlotCustody,
  readSqliteWorkerRequestCustody,
} from "./sqlite-worker-request-custody.js";
import { getWorkerMessageMetrics } from "./worker-message-metrics.js";

afterEach(() => vi.restoreAllMocks());
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function admissionFixture(
  admit: Parameters<typeof createAdmission>[0] = (_request, grant) => grant(),
) {
  const admission = createAdmission(admit);
  onTestFinished(() => admission.finish());
  return admission;
}
function serviceOnWait(admission: SqliteWorkerOperationAdmission) {
  return vi.spyOn(Atomics, "wait").mockImplementation(() => {
    admission.service();
    return "ok";
  });
}
function channelFixture() {
  const channel = new MessageChannel();
  onTestFinished(() => {
    channel.port1.close();
    channel.port2.close();
  });
  return channel;
}
function bindAuthority(
  admission: SqliteWorkerOperationAdmission,
  databasePath: string,
  overrides: Partial<Parameters<SqliteWorkerOperationAdmission["bindDatabaseAuthority"]>[0]>,
) {
  admission.bindDatabaseAuthority({
    databasePath: resolveIdentityPathViaExistingAncestorSync(databasePath),
    assertAccess() {},
    acquireSchema() {
      throw new Error("Unexpected schema authority request");
    },
    ...overrides,
  });
}
function captureInline(facts: unknown) {
  const captured = captureReceipt(facts);
  if (captured.kind !== "inline") {
    throw new Error("Expected an inline test receipt");
  }
  return captured;
}

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
  const admission = admissionFixture((_request, grant) => {
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
  admission.observeRequests((request) => observed.push(request));
  bindAuthority(admission, "synthetic-delayed-writer.sqlite", {
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
  });
  const mutate = vi.fn();
  // Elapsed time before the host runs is not an authority decision.
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
    withAdmission({ port: admission.port }, () => {
      requestAdmission({ stage: "transaction", facts: undefined });
      mutate();
    });
  if (outcome === "self-fence") {
    expect(write).not.toThrow();
    expect(beforeRelease).toHaveBeenCalledOnce();
    expect(mutate).toHaveBeenCalledOnce();
    expect(admission).toMatchObject({ failure: undefined, failureSource: undefined });
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
  expect(admission).toMatchObject({ committed: undefined, settlement: undefined });
});

it("rechecks database ownership after a worker request crosses the message port", () => {
  const root = tempDirs.make("openclaw-worker-admission-maintenance-");
  const databasePath = path.join(root, "state", "openclaw.sqlite");
  const admit = vi.fn((_request: SqliteWorkerAdmissionRequest, grant: () => boolean) => grant());
  const admission = admissionFixture(admit);
  bindAuthority(admission, databasePath, {
    assertAccess: () => assertStateDatabaseAccessAllowed(databasePath),
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
  const maintenance = acquireGatewayStateOwner({ databasePath });
  try {
    admission.service();
    expect(Atomics.load(pending, 0)).toBe(2);
    expect(admission.failure).toMatchObject({
      message: expect.stringContaining("undergoing offline maintenance"),
    });
    expect(admission.failureSource).toBe("authority");
  } finally {
    admission.finish();
    maintenance.release();
  }
});

it.each(["same", "different"])("holds schema authority only for the %s database", (target) => {
  const databasePath = path.resolve("synthetic-schema.sqlite");
  const revoked = new Error("Database owner revoked");
  let current = true;
  const release = vi.fn();
  const acquireSchema = vi.fn(() => ({ assertCurrent() {}, release }));
  const admit = vi.fn((_request: SqliteWorkerAdmissionRequest, grant: () => boolean) => grant());
  const admission = admissionFixture(admit);
  bindAuthority(admission, databasePath, {
    assertAccess() {
      if (!current) {
        throw revoked;
      }
    },
    acquireSchema,
  });
  serviceOnWait(admission);
  if (target === "different") {
    expect(() =>
      withAdmission({ port: admission.port }, () => requestSchema(path.resolve("other.sqlite"))),
    ).toThrow("SQLite transaction admission was refused");
    expect(admission.failure).toMatchObject({
      message: "SQLite schema maintenance target differs from its admitted database",
    });
    expect(acquireSchema).not.toHaveBeenCalled();
    expect(admit).not.toHaveBeenCalled();
    return;
  }
  withAdmission({ port: admission.port }, () => {
    expect(requestSchema(databasePath)).toBe(true);
    expect(requestSchema(databasePath)).toBe(true);
    requestAdmission({ stage: "transaction", facts: "ordinary write" });
    current = false;
    expect(() => requestAdmission({ stage: "commit", facts: "revoked write" })).toThrow(
      "SQLite transaction admission was refused",
    );
  });
  expect(acquireSchema).toHaveBeenCalledOnce();
  expect(admission.failure).toBe(revoked);
  expect(release).not.toHaveBeenCalled();
  admission.finish();
  expect(release).toHaveBeenCalledOnce();
});

it.each(["admitted", "facts-only", "revoked", "different-path"] as const)(
  "keeps %s database creation under the current captured owner",
  (scenario) => {
    const root = tempDirs.make("sqlite-native-creation-");
    const databasePath = path.join(root, "admitted.sqlite");
    const requestedPath =
      scenario === "different-path" ? path.join(root, "other.sqlite") : databasePath;
    const admission = admissionFixture(() => {
      throw new Error("Format exchange must not request transaction authority");
    });
    if (scenario !== "facts-only") {
      bindAuthority(admission, databasePath, {
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
      });
    }
    serviceOnWait(admission);
    const exchange = () =>
      exchangeSqliteDatabaseAdmissions(admission.port, [], requestedPath, true);
    if (scenario === "revoked" || scenario === "different-path") {
      expect(exchange).toThrow("SQLite admission facts exchange failed");
    } else {
      expect(exchange).not.toThrow();
    }
    expect(existsSync(requestedPath)).toBe(scenario === "admitted");
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
        : admissionFixture(() => {
            throw new Error("File creation must not request transaction authority");
          });
    const { port2 } = channelFixture();
    const decision = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
    onTestFinished(() => admission.finish());
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
        scenario === "retired" ? "Creation relay retired" : "SQLite creation relay is not admitted",
    });
    expect(existsSync(location)).toBe(false);
  },
);

it("reads a queued worker commit before settlement and message callbacks run", async () => {
  const admission = admissionFixture();
  const posted = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2));
  const worker = new Worker(
    `
    const { parentPort, workerData } = require("node:worker_threads");
    const posted = new Int32Array(workerData.posted);
    const committed = { version: 1, sequence: 1, facts: { count: 1 } };
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

function receiptFixture(captured = false) {
  const admission = createAdmission((_request, grant) => grant());
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE proof (value INTEGER)");
  const owner: SqliteWorkerOperationContext = { port: admission.port };
  onTestFinished(() => {
    admission.finish();
    db.close();
  });
  const transaction = (operation: () => void) =>
    withAdmission(owner, () =>
      withSqlitePostCommitPublications(db, () => runSqliteImmediateTransactionSync(db, operation)),
    );
  const write = (value: number, rollback = false, delivery: "commit" | "settlement" = "commit") =>
    transaction(() => {
      db.prepare("INSERT INTO proof VALUES (?)").run(value);
      if (captured) {
        deferCapturedSqliteWorkerCommitReceipt(db, captureInline({ value }), delivery);
      } else {
        deferSqliteWorkerCommitReceipt(db, { value }, delivery);
      }
      if (rollback) {
        throw new Error("Rollback the synthetic write");
      }
    });
  const rows = () => db.prepare("SELECT value FROM proof ORDER BY value").all();
  return { db, admission, owner, transaction, write, rows };
}

it.each(
  (["rollback", "unknown", "later rollback"] as const).flatMap((outcome) =>
    [false, true].map((captured) => ({ outcome, captured })),
  ),
)(
  "keeps committed facts distinct from $outcome settlement (captured: $captured)",
  ({ outcome, captured }) => {
    const { admission, owner, write, rows } = receiptFixture(captured);
    const published = vi.fn();
    observeCommits(admission, published);
    const projected = vi.fn();
    observeCommits(admission, projected);
    if (outcome === "rollback") {
      expect(() => write(1, true)).toThrow("Rollback the synthetic write");
    } else {
      write(1);
      if (outcome === "later rollback") {
        expect(() => write(2, true)).toThrow("Rollback the synthetic write");
      }
    }
    const committed = outcome === "rollback" ? undefined : { facts: { value: 1 } };
    expect(admission.settlement).toBeUndefined();
    expect(admission.committed).toEqual(committed);
    expect(admission.settlement).toBeUndefined();
    expect(() => admission.waitForSettlement(performance.now())).toThrow("settlement is unknown");
    settleOperation(owner, outcome === "unknown" ? "unknown" : "completed");
    if (outcome === "unknown") {
      expect(() => admission.waitForSettlement(performance.now())).toThrow("settlement is unknown");
      expect(admission.settlement).toEqual({ kind: "unknown", committed });
    } else {
      expect(admission.waitForSettlement(performance.now())).toEqual(
        committed ? { kind: "completed", committed } : { kind: "completed" },
      );
    }
    expect(rows()).toEqual(outcome === "rollback" ? [] : [{ value: 1 }]);
    admission.finish();
    expect(admission.committed).toEqual(committed);
    const expectedFacts = outcome === "rollback" ? [] : [{ value: 1 }];
    expect(published.mock.calls.map(([receipt]) => receipt.facts)).toEqual(expectedFacts);
    expect(projected.mock.calls.map(([receipt]) => receipt.facts)).toEqual(expectedFacts);
  },
);

it.each(
  [
    { receipt: "native commit", publicationFails: true },
    { receipt: "failed commit delivery", publicationFails: false },
  ].flatMap(({ receipt, publicationFails }) =>
    [false, true].map((captured) => ({ receipt, publicationFails, captured })),
  ),
)(
  "installs $receipt before reply acknowledgement (publication failure: $publicationFails, captured: $captured)",
  ({ receipt, publicationFails, captured }) => {
    const ownerContext = new AsyncLocalStorage<string>();
    const { admission, owner, write, rows } = ownerContext.run("publication owner", () =>
      receiptFixture(captured),
    );
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
    observeCommits(admission, publish);
    const before = getWorkerMessageMetrics().find(
      (metric) => metric.kind === "authority" && metric.direction === "from_worker",
    );
    const payloadBytes = serialize({ value: 1 }).byteLength;
    const postMessage = admission.port.postMessage.bind(admission.port);
    const posted = vi.spyOn(admission.port, "postMessage").mockImplementation((message) => {
      if (message.kind === "native-commit" && receipt === "failed commit delivery") {
        throw new Error("Synthetic commit delivery failure");
      }
      postMessage(message);
    });
    const resolve = vi.fn(() => events.push("reply"));
    const reject = vi.fn(() => events.push("reject"));
    const custody = new SqliteWorkerSlotCustody().createRequest();
    custody.activate();
    custody.accept();
    const job: Job = {
      custody,
      observation: { started() {}, completed() {} },
      request: { type: "execute", id: 1, actor: 1, input: new Uint8Array() },
      bytes: 0,
      operationAdmission: { admission, releaseService() {} },
      resolve,
      reject,
      detach() {},
    };
    write(1);
    settleOperation(owner, "completed");
    expect(posted).toHaveBeenLastCalledWith(
      {
        kind: "native-settlement",
        settlement:
          receipt === "failed commit delivery"
            ? { kind: "completed", committed: { version: 1, sequence: 1, facts: { value: 1 } } }
            : { kind: "completed" },
        payloadBytes: receipt === "failed commit delivery" ? payloadBytes : 0,
      },
      [],
    );
    expect(events).toEqual([]);
    settleSqliteWorkerJob(job, undefined, { written: true });
    expect(getWorkerMessageMetrics()).toContainEqual({
      kind: "authority",
      direction: "from_worker",
      messages: (before?.messages ?? 0) + (receipt === "failed commit delivery" ? 1 : 2),
      payloadBytes: (before?.payloadBytes ?? 0) + payloadBytes,
      unmeasuredMessages: before?.unmeasuredMessages ?? 0,
    });
    expect(readSqliteWorkerRequestCustody(custody.descriptor)).toBe(false);
    expect(events).toEqual(["publish", publicationFails ? "reject" : "reply"]);
    expect(publish).toHaveBeenCalledOnce();
    expect(rows()).toEqual([{ value: 1 }]);
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
  },
);

it("publishes the captured snapshot even when its producer changes before deferral", () => {
  const { db, admission, owner, transaction } = receiptFixture();
  const facts = { value: { text: "captured" }, bytes: Buffer.from([1, 2, 3]) };
  const captured = captureInline(facts);
  facts.value.text = "changed";
  facts.bytes.fill(9);
  transaction(() => {
    deferCapturedSqliteWorkerCommitReceipt(db, captured);
    expect(admission.committed).toBeUndefined();
  });
  expect(admission.committed).toEqual({
    facts: { value: { text: "captured" }, bytes: new Uint8Array([1, 2, 3]) },
  });
  settleOperation(owner, "completed");
  expect(admission.waitForSettlement(performance.now()).committed).toEqual(admission.committed);
});

it("keeps the exact transport limit inline and retains oversized bytes for transfer", () => {
  // V8 header size can vary by runtime; both payloads stay in the same length encoding.
  const overhead =
    serialize("x".repeat(SQLITE_WORKER_MAX_MESSAGE_BYTES)).byteLength -
    SQLITE_WORKER_MAX_MESSAGE_BYTES;
  expect(captureInline("x".repeat(SQLITE_WORKER_MAX_MESSAGE_BYTES - overhead)).payloadBytes).toBe(
    SQLITE_WORKER_MAX_MESSAGE_BYTES,
  );
  const oversized = captureReceipt("x".repeat(SQLITE_WORKER_MAX_MESSAGE_BYTES - overhead + 1));
  expect(oversized.kind).toBe("oversized");
  if (oversized.kind === "oversized") {
    expect(oversized.serialized.byteLength).toBe(SQLITE_WORKER_MAX_MESSAGE_BYTES + 1);
  }
});

it.each(["settlement", "settlement-only", "malformed"] as const)(
  "retains committed facts through %s receipt delivery",
  (delivery) => {
    const { admission, owner, write, rows } = receiptFixture();
    const published = vi.fn();
    observeCommits(admission, published);
    for (const value of [1, 2]) {
      write(value, false, delivery === "settlement-only" && value === 2 ? "settlement" : "commit");
    }
    admission.service();
    expect(published.mock.calls.map(([receipt]) => receipt.facts)).toEqual(
      delivery === "settlement-only" ? [{ value: 1 }] : [{ value: 1 }, { value: 2 }],
    );
    if (delivery !== "malformed") {
      settleOperation(owner, "completed");
    } else {
      admission.port.postMessage({ kind: "native-commit", committed: null }, []);
    }
    admission.finish();
    expect(admission.committed).toEqual({ facts: { value: 2 } });
    expect(published).toHaveBeenCalledTimes(2);
    expect(rows()).toEqual([{ value: 1 }, { value: 2 }]);
    if (delivery !== "malformed") {
      expect(admission.failure).toBeUndefined();
      expect(admission.waitForSettlement(performance.now())).toEqual({
        kind: "completed",
        committed: { facts: { value: 2 } },
      });
    } else {
      expect(admission).toMatchObject({
        failure: { code: "outcome-unknown" },
        failureSource: "protocol",
      });
      expect(() => admission.waitForSettlement(performance.now())).toThrow("invalid");
    }
  },
);

it("retains native COMMIT evidence when an earlier notification fails", () => {
  const { db, admission, owner, transaction, rows } = receiptFixture();
  const fail = () => {
    throw new Error("Synthetic publication failure");
  };
  expect(() =>
    transaction(() => {
      db.prepare("INSERT INTO proof VALUES (1)").run();
      deferSqlitePostCommitPublication(db, fail);
      deferSqliteWorkerCommitReceipt(db, { value: 1 });
    }),
  ).not.toThrow();
  settleOperation(owner, "completed");
  expect(admission.waitForSettlement(performance.now())).toEqual({
    kind: "completed",
    committed: { facts: { value: 1 } },
  });
  expect(rows()).toEqual([{ value: 1 }]);
});

it("refuses escaped continuations and captured scopes after synchronous operation exit", async () => {
  vi.resetModules();
  const duplicate = await import("./sqlite-worker-operation-admission.js");
  const { port1 } = channelFixture();
  const requests = vi.spyOn(port1, "postMessage");
  const schemaRequest = () => duplicate.requestSqliteWorkerSchemaMaintenance("synthetic.sqlite");
  const request = () =>
    duplicate.requestSqliteWorkerOperationAdmission({ stage: "commit", facts: undefined });
  for (const escapedRequest of [request, schemaRequest]) {
    const escaped = withAdmission({ port: port1 }, () => Promise.resolve().then(escapedRequest));
    await expect(escaped).rejects.toThrow("requires its retained admission");
  }
  expect(schemaRequest()).toBe(false);
  const captured = withAdmission({ port: port1 }, () => AsyncLocalStorage.snapshot());
  expect(() => captured(request)).toThrow("requires its retained admission");
  expect(() => captured(schemaRequest)).toThrow("requires its retained admission");
  let failedScope: ReturnType<typeof AsyncLocalStorage.snapshot> | undefined;
  expect(() =>
    withAdmission({ port: port1 }, () => {
      failedScope = AsyncLocalStorage.snapshot();
      throw new Error("operation failed");
    }),
  ).toThrow("operation failed");
  expect(failedScope).toBeDefined();
  expect(() => failedScope?.(request)).toThrow("requires its retained admission");
  expect(() => failedScope?.(schemaRequest)).toThrow("requires its retained admission");
  expect(requests).not.toHaveBeenCalled();
});
