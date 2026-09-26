import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SqliteWorkerAdmissionFactory } from "../infra/sqlite-worker-operation-admission.js";
import type { SqliteWorkerOperationSettlement } from "../infra/sqlite-worker-operation-settlement.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createOpenClawDatabaseMaintenanceScope } from "./openclaw-state-db-async-lifecycle.js";
import type { OpenClawStateAsyncLeaseContext } from "./openclaw-state-lease-context.js";
import type { OpenClawStateLeaseIdentity } from "./openclaw-state-lease-store.js";
import {
  createOpenClawStateLeaseWorkerOwner,
  withOpenClawStateLeaseWorkerAdmission,
  withOpenClawStateLeasesWorkerAdmission,
} from "./openclaw-state-lease-worker-owner.js";
import { runWithOpenClawStateLeasesWorker } from "./openclaw-state-lease-worker-storage.js";
import type { OpenClawStateWorkerContext } from "./openclaw-state-worker-context.types.js";

const runWorkerOperation = vi.hoisted(() => vi.fn());
vi.mock("./openclaw-state-worker-store.js", () => ({
  runOpenClawStateWorkerOperation: runWorkerOperation,
}));

type Owner = ReturnType<typeof createOpenClawStateLeaseWorkerOwner>;
const owners: Owner[] = [];
const jobs: Array<ReturnType<typeof createJob>> = [];

afterEach(async () => {
  for (const current of jobs.splice(0)) {
    current.admission.finish();
    current.settled.resolve({ kind: "completed" });
  }
  for (const owner of owners.splice(0)) {
    await owner.settle();
    owner.close();
  }
  vi.restoreAllMocks();
  runWorkerOperation.mockReset();
});

function sourceContext(): OpenClawStateWorkerContext {
  return {
    environment: { OPENCLAW_STATE_DIR: "/synthetic-state" },
    admission: {
      databasePath: "/synthetic-alias/state.sqlite",
      identity: { key: "file:1:2", canonicalPath: "/synthetic-state/state.sqlite" },
      assertCurrent() {},
    },
  };
}

function fixture(context?: OpenClawStateWorkerContext, key = "collection") {
  const controller = new AbortController();
  const lease: OpenClawStateAsyncLeaseContext = {
    signal: controller.signal,
    assertOwned: async () => {},
    renew: async () => {},
  };
  const assertCurrent = vi.fn(() => controller.signal.throwIfAborted());
  const owner = createOpenClawStateLeaseWorkerOwner({
    lease,
    identity: { scope: "core:test", key, owner: `owner-${key}` },
    databasePath: context?.admission.databasePath ?? "/synthetic-alias/state.sqlite",
    sourceContext: context,
    assertCurrent,
  });
  owners.push(owner);
  return { owner, lease, controller, assertCurrent };
}

function createJob(createAdmission: SqliteWorkerAdmissionFactory) {
  const settled = createDeferredCore<SqliteWorkerOperationSettlement>();
  const { admission } = createAdmission({ settled: settled.promise });
  return {
    admission,
    settled,
    request(stage: "transaction" | "commit", leases: unknown) {
      const decision = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
      admission.port.postMessage(
        {
          stage,
          facts: { kind: "state-leases", leases },
          decision: decision.buffer,
        },
        [],
      );
      admission.service();
      return Atomics.load(decision, 0);
    },
  };
}

function job(createAdmission: SqliteWorkerAdmissionFactory) {
  const next = createJob(createAdmission);
  jobs.push(next);
  return next;
}

function facts(identities: readonly OpenClawStateLeaseIdentity[], expiresAt = Date.now() + 30_000) {
  return identities.map((identity) => ({ identity, expiresAt }));
}

describe("state lease group admission", () => {
  it("binds source guards when leases are registered, before group admission", () => {
    const context = sourceContext();
    const members = [fixture(context), fixture(context, "target")];
    context.admission.assertCurrent = () => {};
    const operation = vi.fn(async () => {});
    expect(() =>
      withOpenClawStateLeasesWorkerAdmission(
        members.map(({ lease }) => lease),
        context,
        operation,
      ),
    ).toThrow("source binding was replaced");
    expect(operation).not.toHaveBeenCalled();
    expect(members.every(({ owner }) => owner.canRelease())).toBe(true);
  });

  it.each(["admission", "environment-values"] as const)(
    "refuses %s replacement during the bridge's first await",
    async (kind) => {
      const context = sourceContext();
      const members = [fixture(context), fixture(context, "target")];
      const operation = vi.fn(async () => {});
      const pending = runWithOpenClawStateLeasesWorker(
        members.map(({ lease }) => lease),
        context,
        operation,
      );
      if (kind === "admission") {
        context.admission = { ...context.admission };
      } else {
        context.environment.OPENCLAW_STATE_DIR = "/unrelated-state";
      }
      await expect(pending).rejects.toThrow("source binding was replaced");
      expect(runWorkerOperation).not.toHaveBeenCalled();
      expect(operation).not.toHaveBeenCalled();
      expect(members.every(({ owner }) => owner.canRelease())).toBe(true);
    },
  );

  it.each(["admission", "maintenance", "maintenance-owner"] as const)(
    "retains the original source %s guard",
    async (kind) => {
      const context = sourceContext();
      let sourceCurrent = true;
      const withdrawn = new Error("original source retired");
      const assertSourceCurrent = () => {
        if (!sourceCurrent) {
          throw withdrawn;
        }
      };
      const maintenance = createOpenClawDatabaseMaintenanceScope({
        assertOwnerCurrent: assertSourceCurrent,
      });
      if (kind === "admission") {
        context.admission.assertCurrent = assertSourceCurrent;
      } else {
        context.maintenanceScope = maintenance;
      }
      const members = [fixture(context), fixture(context, "target")];
      try {
        await withOpenClawStateLeasesWorkerAdmission(
          members.map(({ lease }) => lease),
          context,
          async (scope) => {
            const current = job(scope.createAdmission);
            expect(current.request("transaction", facts(scope.identities))).toBe(1);
            if (kind === "admission") {
              context.admission.assertCurrent = () => {};
            } else if (kind === "maintenance") {
              maintenance.assertAdmission = () => {};
            } else {
              maintenance.assertOwnerCurrent = () => {};
            }
            sourceCurrent = false;
            expect(current.request("commit", facts(scope.identities))).toBe(2);
            expect(current.admission.failure).toMatchObject({
              message: "State lease worker source binding was replaced",
            });
            current.settled.resolve({ kind: "completed" });
          },
        );
      } finally {
        sourceCurrent = true;
        await maintenance.close();
      }
    },
  );

  it.each(["effect", "commit"] as const)(
    "retains the original %s authority callback",
    async (kind) => {
      const context = sourceContext();
      const members = [fixture(context), fixture(context, "target")];
      let currentCaller = true;
      const withdrawn = new Error("original caller retired");
      const authority = {
        assertCurrent() {
          if (!currentCaller) {
            throw withdrawn;
          }
        },
        beforeCommit() {
          currentCaller = false;
        },
      };
      await withOpenClawStateLeasesWorkerAdmission(
        members.map(({ lease }) => lease),
        context,
        async (scope) => {
          const current = job(scope.createAdmission);
          expect(current.request("transaction", facts(scope.identities))).toBe(1);
          if (kind === "effect") {
            authority.assertCurrent = () => {};
            currentCaller = false;
          } else {
            authority.beforeCommit = () => {};
          }
          expect(current.request("commit", facts(scope.identities))).toBe(2);
          expect(current.admission.failure).toBe(withdrawn);
          current.settled.resolve({ kind: "completed" });
        },
        authority,
      );
    },
  );

  it("routes the plural storage entry point through one retained worker operation", async () => {
    const context = sourceContext();
    const members = [fixture(context), fixture(context, "target")];
    let expectedIdentities: readonly OpenClawStateLeaseIdentity[] = [];
    const execute = vi.fn(async () => 42);
    runWorkerOperation.mockImplementation(
      async (
        captured: OpenClawStateWorkerContext,
        operation: (scope: { execute: typeof execute }) => Promise<number>,
        options: { assertCurrent: () => void; createAdmission: SqliteWorkerAdmissionFactory },
      ) => {
        expect(captured).toBe(context);
        expect(members.every(({ owner }) => !owner.canRelease())).toBe(true);
        execute.mockImplementationOnce(async () => {
          options.assertCurrent();
          const current = job(options.createAdmission);
          expect(current.request("transaction", facts(expectedIdentities))).toBe(1);
          expect(current.request("commit", facts(expectedIdentities))).toBe(1);
          current.settled.resolve({ kind: "completed" });
          return 42;
        });
        return operation({ execute });
      },
    );
    const value = await runWithOpenClawStateLeasesWorker(
      members.map(({ lease }) => lease),
      context,
      async (scope, identities) => {
        expectedIdentities = identities;
        return scope.execute({
          type: "stateLease.verify",
          input: { identity: expectDefined(identities[0], "collection identity") },
        });
      },
    );
    expect(value).toBe(42);
    expect(runWorkerOperation).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledOnce();
    expect(members.every(({ owner }) => owner.canRelease())).toBe(true);
  });

  it.each(["transaction", "commit"] as const)("refuses an out-of-order %s grant", async (stage) => {
    const context = sourceContext();
    const members = [fixture(context), fixture(context, "target")];
    await withOpenClawStateLeasesWorkerAdmission(
      members.map(({ lease }) => lease),
      context,
      async (scope) => {
        const current = job(scope.createAdmission);
        if (stage === "transaction") {
          expect(current.request("transaction", facts(scope.identities))).toBe(1);
        }
        expect(current.request(stage, facts(scope.identities))).toBe(2);
        expect(current.admission.failure).toMatchObject({ code: "OPENCLAW_STATE_LEASE_LOST" });
        current.settled.resolve({ kind: "completed" });
      },
    );
  });

  it("retains both owners before callback entry and joins each job's native settlement", async () => {
    const context = sourceContext();
    const first = fixture(context);
    const second = fixture(context, "target");
    const beforeCommit = vi.fn();
    await withOpenClawStateLeasesWorkerAdmission(
      [first.lease, second.lease],
      context,
      async (scope) => {
        expect(first.owner.canRelease()).toBe(false);
        expect(second.owner.canRelease()).toBe(false);
        // Schema and domain commands share their retained actor, not a grant port or stage.
        for (let index = 0; index < 2; index += 1) {
          const current = job(scope.createAdmission);
          expect(current.request("transaction", facts(scope.identities))).toBe(1);
          expect(current.request("commit", facts(scope.identities))).toBe(1);
          expect(current.request("commit", facts(scope.identities))).toBe(2);
        }
      },
      { assertCurrent() {}, beforeCommit },
    );
    expect(beforeCommit).toHaveBeenCalledTimes(2);
    const firstJob = expectDefined(jobs[0], "schema job");
    const secondJob = expectDefined(jobs[1], "domain job");
    expect(firstJob.admission.port).not.toBe(secondJob.admission.port);
    firstJob.settled.resolve({ kind: "completed" });
    await firstJob.settled.promise;
    expect(first.owner.canRelease()).toBe(false);
    expect(second.owner.canRelease()).toBe(false);
    secondJob.settled.resolve({ kind: "completed" });
    await Promise.all([first.owner.drain(), second.owner.drain()]);
    expect(first.owner.canRelease()).toBe(true);
    expect(second.owner.canRelease()).toBe(true);
  });

  it.each([0, 1])("refuses a commit when beforeCommit revokes member %s", async (index) => {
    const context = sourceContext();
    const members = [fixture(context), fixture(context, "target")];
    const revoked = new Error("lease retired during host commit preparation");
    await withOpenClawStateLeasesWorkerAdmission(
      members.map(({ lease }) => lease),
      context,
      async (scope) => {
        const current = job(scope.createAdmission);
        expect(current.request("transaction", facts(scope.identities))).toBe(1);
        expect(current.request("commit", facts(scope.identities))).toBe(2);
        expect(current.admission.failure).toBe(revoked);
        current.settled.resolve({ kind: "completed" });
      },
      {
        assertCurrent() {},
        beforeCommit() {
          expectDefined(members[index], "selected member").controller.abort(revoked);
        },
      },
    );
  });

  it.each(["caller", "expiry"] as const)("rechecks %s after beforeCommit", async (kind) => {
    const context = sourceContext();
    const members = [fixture(context), fixture(context, "target")];
    let now = 1_000;
    let currentCaller = true;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    await withOpenClawStateLeasesWorkerAdmission(
      members.map(({ lease }) => lease),
      context,
      async (scope) => {
        const current = job(scope.createAdmission);
        const held = facts(scope.identities, 2_000);
        expect(current.request("transaction", held)).toBe(1);
        expect(current.request("commit", held)).toBe(2);
        expect(current.admission.failure).toMatchObject({
          message:
            kind === "caller" ? "caller retired" : "State lease worker ownership was refused",
        });
        current.settled.resolve({ kind: "completed" });
      },
      {
        assertCurrent() {
          if (!currentCaller) {
            throw new Error("caller retired");
          }
        },
        beforeCommit() {
          if (kind === "caller") {
            currentCaller = false;
          } else {
            now = 2_000;
          }
        },
      },
    );
  });

  it.each(["missing", "extra", "reordered", "wrong-owner", "expired"] as const)(
    "refuses %s lease facts without granting the transaction",
    async (kind) => {
      const context = sourceContext();
      const members = [fixture(context), fixture(context, "target")];
      await withOpenClawStateLeasesWorkerAdmission(
        members.map(({ lease }) => lease),
        context,
        async (scope) => {
          const current = job(scope.createAdmission);
          const held = facts(scope.identities);
          if (kind === "missing") {
            held.pop();
          }
          if (kind === "extra") {
            held.push(expectDefined(held[0], "first lease facts"));
          }
          if (kind === "reordered") {
            held.reverse();
          }
          if (kind === "wrong-owner") {
            expectDefined(held[1], "second lease facts").identity.owner = "unrelated";
          }
          if (kind === "expired") {
            expectDefined(held[1], "second lease facts").expiresAt = Date.now();
          }
          expect(current.request("transaction", held)).toBe(2);
          expect(current.admission.failure).toMatchObject({ code: "OPENCLAW_STATE_LEASE_LOST" });
          current.settled.resolve({ kind: "not-entered", error: current.admission.failure });
        },
      );
    },
  );

  it.each([
    "empty",
    "repeated",
    "same-key",
    "uncaptured",
    "copied-context",
    "alias-context",
  ] as const)("rejects %s source membership before callback entry", async (kind) => {
    const context = sourceContext();
    const first = fixture(context);
    const otherContext = {
      ...context,
      admission: {
        ...context.admission,
        databasePath:
          kind === "alias-context"
            ? context.admission.identity.canonicalPath
            : context.admission.databasePath,
      },
    };
    const second = fixture(
      kind === "uncaptured" ? undefined : kind.endsWith("context") ? otherContext : context,
      kind === "same-key" ? "collection" : "target",
    );
    const selected =
      kind === "empty"
        ? []
        : kind === "repeated"
          ? [first.lease, first.lease]
          : [first.lease, second.lease];
    const operation = vi.fn(async () => {});
    expect(() => withOpenClawStateLeasesWorkerAdmission(selected, context, operation)).toThrow();
    expect(operation).not.toHaveBeenCalled();
    expect(first.owner.canRelease()).toBe(true);
    expect(second.owner.canRelease()).toBe(true);
  });

  it("unwinds earlier custody when a later owner refuses and preserves single selected-path checks", async () => {
    const context = sourceContext();
    const first = fixture(context);
    const second = fixture(context, "target");
    second.controller.abort(new Error("target retired"));
    const operation = vi.fn(async () => {});
    expect(() =>
      withOpenClawStateLeasesWorkerAdmission([first.lease, second.lease], context, operation),
    ).toThrow("target retired");
    expect(operation).not.toHaveBeenCalled();
    expect(first.owner.canRelease()).toBe(true);
    expect(() =>
      withOpenClawStateLeaseWorkerAdmission(
        first.lease,
        context.admission.identity.canonicalPath,
        operation,
      ),
    ).toThrow("differs from its live owner");
    await withOpenClawStateLeaseWorkerAdmission(
      first.lease,
      context.admission.databasePath,
      operation,
    );
    expect(operation).toHaveBeenCalledOnce();
  });

  it("rejects promise-returning commit authority before granting", async () => {
    const context = sourceContext();
    const members = [fixture(context), fixture(context, "target")];
    await withOpenClawStateLeasesWorkerAdmission(
      members.map(({ lease }) => lease),
      context,
      async (scope) => {
        const current = job(scope.createAdmission);
        expect(current.request("transaction", facts(scope.identities))).toBe(1);
        expect(current.request("commit", facts(scope.identities))).toBe(2);
        expect(current.admission.failure).toMatchObject({
          message: "State lease worker authority must complete synchronously",
        });
        current.settled.resolve({ kind: "completed" });
      },
      {
        assertCurrent() {},
        // oxlint-disable-next-line typescript/no-misused-promises -- Deliberately violates the synchronous authority contract.
        beforeCommit: async () => {},
      },
    );
  });

  it("poisons both owners from one unknown native outcome even after a handled callback failure", async () => {
    const context = sourceContext();
    const members = [fixture(context), fixture(context, "target")];
    const failure = new Error("native outcome unavailable");
    await expect(
      withOpenClawStateLeasesWorkerAdmission(
        members.map(({ lease }) => lease),
        context,
        async (scope) => {
          const current = job(scope.createAdmission);
          current.settled.resolve({ kind: "unknown", error: failure });
          await Promise.reject(new Error("delivery lost")).catch(() => {});
          return "handled";
        },
      ),
    ).rejects.toMatchObject({ code: "outcome-unknown" });
    for (const member of members) {
      expect(member.owner.canRelease()).toBe(false);
      expect(() =>
        withOpenClawStateLeaseWorkerAdmission(
          member.lease,
          context.admission.databasePath,
          async () => {},
        ),
      ).toThrow("outcome is unknown");
      await expect(member.owner.drain()).rejects.toMatchObject({ code: "outcome-unknown" });
    }
  });
});
