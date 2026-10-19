import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  SqliteWorkerAdmissionFactory,
  SqliteWorkerOperationAdmission,
} from "../infra/sqlite-worker-operation-admission.js";
import type { SqliteWorkerOperationSettlement } from "../infra/sqlite-worker-operation-settlement.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createOpenClawDatabaseMaintenanceScope } from "./openclaw-state-db-async-lifecycle.js";
import { requestLeaseAdmission } from "./openclaw-state-lease-admission.test-support.js";
import type { OpenClawStateAsyncLeaseContext } from "./openclaw-state-lease-context.js";
import { runWithOpenClawStateLeasesWorker as runGroup } from "./openclaw-state-lease-worker-operation.js";
import {
  createOpenClawStateLeaseWorkerOwner,
  withOpenClawStateLeaseWorkerAdmission as withSingle,
  withOpenClawStateLeasesWorkerAdmission as withGroup,
} from "./openclaw-state-lease-worker-owner.js";
import type { OpenClawStateLeaseIdentity } from "./openclaw-state-lease.types.js";
import type { OpenClawStateWorkerContext } from "./openclaw-state-worker-context.types.js";

const runWorkerOperation = vi.hoisted(() => vi.fn());
vi.mock("./openclaw-state-worker-store.js", () => ({
  runOpenClawStateWorkerOperation: runWorkerOperation,
}));

type Owner = ReturnType<typeof createOpenClawStateLeaseWorkerOwner>;
const owners: Owner[] = [];
const jobs: Array<{
  admission: SqliteWorkerOperationAdmission;
  settled: ReturnType<typeof createDeferredCore<SqliteWorkerOperationSettlement>>;
}> = [];
const noop = () => {};
const asyncNoop = async () => {};

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
      coordinationKey: "file:1:2",
      databasePath: "/synthetic-alias/state.sqlite",
      identity: { key: "file:1:2", canonicalPath: "/synthetic-state/state.sqlite" },
      assertCurrent: noop,
    },
  };
}

function fixture(context?: OpenClawStateWorkerContext, key = "collection") {
  const controller = new AbortController();
  const lease: OpenClawStateAsyncLeaseContext = {
    signal: controller.signal,
    assertOwned: asyncNoop,
    renew: asyncNoop,
  };
  const owner = createOpenClawStateLeaseWorkerOwner({
    lease,
    identity: { scope: "core:test", key, owner: `owner-${key}` },
    databasePath: context?.admission.databasePath ?? "/synthetic-alias/state.sqlite",
    sourceContext: context,
    assertCurrent: () => controller.signal.throwIfAborted(),
  });
  owners.push(owner);
  return { owner, lease, controller };
}

function job(createAdmission: SqliteWorkerAdmissionFactory) {
  const settled = createDeferredCore<SqliteWorkerOperationSettlement>();
  const { admission } = createAdmission({ settled: settled.promise });
  const current = {
    admission,
    settled,
    request(stage: "transaction" | "commit", leases: unknown) {
      return requestLeaseAdmission(admission, stage, { kind: "state-leases", leases });
    },
  };
  jobs.push(current);
  return current;
}

function facts(identities: readonly OpenClawStateLeaseIdentity[], expiresAt = Date.now() + 30_000) {
  return identities.map((identity) => ({ identity, expiresAt }));
}
type LeaseFacts = ReturnType<typeof facts>;

function group(context = sourceContext()) {
  const members = [fixture(context), fixture(context, "target")] as const;
  const leases = members.map(({ lease }) => lease);
  return {
    context,
    members,
    leases,
    run: withGroup.bind(null, leases, context),
    expectReleasable: (value: boolean) => {
      expect(members.map(({ owner }) => owner.canRelease())).toEqual([value, value]);
    },
  };
}

describe("state lease group admission", () => {
  it.each([
    ["admission", "source"],
    ["maintenance", "source"],
    ["effect", "caller"],
    ["transaction-replacement", "caller"],
    ["commit", "caller"],
    ["member-0", "member"],
    ["member-1", "member"],
    ["caller", "caller"],
    ["expiry", "expiry"],
    ["async", "async"],
  ] as const)("refuses grants after %s authority changes", async (kind, failure) => {
    const context = sourceContext();
    let now = 1_000;
    const current = { source: true, caller: true };
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const failures = {
      source: new Error("original source retired"),
      caller: new Error(kind === "caller" ? "caller retired" : "original caller retired"),
      member: new Error("lease retired during host commit preparation"),
      expiry: "State lease worker ownership was refused",
      async: "State lease worker authority must complete synchronously",
    };
    const assertSourceCurrent = () => {
      if (!current.source) {
        throw failures.source;
      }
    };
    const maintenance = createOpenClawDatabaseMaintenanceScope({
      assertOwnerCurrent: assertSourceCurrent,
    });
    if (kind === "admission") {
      context.admission.assertCurrent = assertSourceCurrent;
    } else if (kind === "maintenance") {
      context.maintenanceScope = maintenance;
    }
    const { members, run } = group(context);
    const authority = {
      assertCurrent() {
        if (kind === "transaction-replacement") {
          authority.beforeTransaction = noop;
        }
        if (!current.caller) {
          throw failures.caller;
        }
      },
      beforeTransaction() {
        if (kind === "transaction-replacement") {
          throw failures.caller;
        }
      },
      beforeCommit() {
        if (kind === "member-0" || kind === "member-1") {
          members[kind === "member-0" ? 0 : 1].controller.abort(failures.member);
        } else if (kind === "caller" || kind === "commit") {
          current.caller = false;
        } else if (kind === "expiry") {
          now = 2_000;
        }
      },
    };
    if (kind === "async") {
      // oxlint-disable-next-line typescript/no-misused-promises -- Deliberately violates the synchronous authority contract.
      authority.beforeCommit = asyncNoop;
    }
    try {
      await run(async (scope) => {
        const task = job(scope.createAdmission);
        const held = facts(scope.identities, 2_000);
        expect(task.request("transaction", held)).toBe(kind === "transaction-replacement" ? 2 : 1);
        if (kind !== "transaction-replacement") {
          if (kind === "admission") {
            context.admission.assertCurrent = noop;
          }
          if (kind === "maintenance") {
            maintenance.assertAdmission = noop;
          }
          if (kind === "effect") {
            authority.assertCurrent = noop;
            current.caller = false;
          }
          if (kind === "commit") {
            authority.beforeCommit = noop;
          }
          current.source = false;
          expect(task.request("commit", held)).toBe(2);
        }
        const expected = failures[failure];
        if (typeof expected === "string") {
          expect(task.admission.failure).toMatchObject({ message: expected });
        } else {
          expect(task.admission.failure).toBe(expected);
        }
        task.settled.resolve({ kind: "completed" });
      }, authority);
    } finally {
      current.source = true;
      await maintenance.close();
    }
  });

  it("routes the plural storage entry point through one retained worker operation", async () => {
    const { context, leases, expectReleasable } = group();
    let expectedIdentities: readonly OpenClawStateLeaseIdentity[] = [];
    const execute = vi.fn(async () => 42);
    runWorkerOperation.mockImplementation(
      async (
        captured: OpenClawStateWorkerContext,
        operation: (scope: { execute: typeof execute }) => Promise<number>,
        options: { assertCurrent: () => void; createAdmission: SqliteWorkerAdmissionFactory },
      ) => {
        expect(captured).toBe(context);
        expectReleasable(false);
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
    const value = await runGroup(leases, context, async (scope, identities) => {
      expectedIdentities = identities;
      return scope.execute({
        type: "stateLease.verify",
        input: { identity: expectDefined(identities[0], "collection identity") },
      });
    });
    expect(value).toBe(42);
    expect(runWorkerOperation).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledOnce();
    expectReleasable(true);
  });

  it("retains both owners before callback entry and joins each job's native settlement", async () => {
    const { members, run, expectReleasable } = group();
    const callbacks: string[] = [];
    await run(
      async (scope) => {
        expectReleasable(false);
        // Schema and domain commands share their retained actor, not a grant port or stage.
        for (let index = 0; index < 2; index += 1) {
          const current = job(scope.createAdmission);
          if (index === 0) {
            expect(current.request("transaction", facts(scope.identities))).toBe(1);
          }
          expect(current.request("commit", facts(scope.identities))).toBe(1);
        }
      },
      {
        assertCurrent: noop,
        beforeTransaction: () => {
          callbacks.push("prepare");
        },
        beforeCommit: () => {
          callbacks.push("commit");
        },
      },
    );
    expect(callbacks).toEqual(["prepare", "commit", "prepare", "commit"]);
    const firstJob = expectDefined(jobs[0], "schema job");
    const secondJob = expectDefined(jobs[1], "domain job");
    expect(firstJob.admission.port).not.toBe(secondJob.admission.port);
    firstJob.settled.resolve({ kind: "completed" });
    await firstJob.settled.promise;
    expectReleasable(false);
    secondJob.settled.resolve({ kind: "completed" });
    await Promise.all(members.map(({ owner }) => owner.drain()));
    expectReleasable(true);
  });

  it.each<[string, (held: LeaseFacts) => LeaseFacts]>([
    ["missing", (held) => held.slice(0, 1)],
    ["extra", (held) => [...held, expectDefined(held[0], "first lease facts")]],
    ["reordered", (held) => held.toReversed()],
    [
      "wrong-owner",
      (held) =>
        held.map((entry, index) =>
          index === 1 ? { ...entry, identity: { ...entry.identity, owner: "unrelated" } } : entry,
        ),
    ],
    [
      "expired",
      (held) =>
        held.map((entry, index) => (index === 1 ? { ...entry, expiresAt: Date.now() } : entry)),
    ],
  ])("refuses invalid %s grant requests", async (_kind, invalidate) => {
    await group().run(async (scope) => {
      const current = job(scope.createAdmission);
      expect(current.request("transaction", invalidate(facts(scope.identities)))).toBe(2);
      expect(current.admission.failure).toMatchObject({ code: "OPENCLAW_STATE_LEASE_LOST" });
      current.settled.resolve({ kind: "not-entered", error: current.admission.failure });
    });
  });

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
    const otherContext = { ...context, admission: { ...context.admission } };
    if (kind === "alias-context") {
      otherContext.admission.databasePath = context.admission.identity.canonicalPath;
    }
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
    const operation = vi.fn(asyncNoop);
    expect(() => withGroup(selected, context, operation)).toThrow();
    expect(operation).not.toHaveBeenCalled();
    expect(first.owner.canRelease()).toBe(true);
    expect(second.owner.canRelease()).toBe(true);
  });

  it("unwinds earlier custody when a later owner refuses and preserves single selected-path checks", async () => {
    const context = sourceContext();
    const first = fixture(context);
    const second = fixture(context, "target");
    second.controller.abort(new Error("target retired"));
    const operation = vi.fn(asyncNoop);
    expect(() => withGroup([first.lease, second.lease], context, operation)).toThrow(
      "target retired",
    );
    expect(operation).not.toHaveBeenCalled();
    expect(first.owner.canRelease()).toBe(true);
    expect(() =>
      withSingle(first.lease, context.admission.identity.canonicalPath, operation),
    ).toThrow("differs from its live owner");
    await withSingle(first.lease, context.admission.databasePath, operation);
    expect(operation).toHaveBeenCalledOnce();
  });

  it("poisons both owners from one unknown native outcome even after a handled callback failure", async () => {
    const { context, members, run } = group();
    const failure = new Error("native outcome unavailable");
    await expect(
      run(async (scope) => {
        const current = job(scope.createAdmission);
        current.settled.resolve({ kind: "unknown", error: failure });
        await Promise.reject(new Error("delivery lost")).catch(() => {});
        return "handled";
      }),
    ).rejects.toMatchObject({ code: "outcome-unknown" });
    for (const member of members) {
      expect(member.owner.canRelease()).toBe(false);
      expect(() => withSingle(member.lease, context.admission.databasePath, asyncNoop)).toThrow(
        "outcome is unknown",
      );
      await expect(member.owner.drain()).rejects.toMatchObject({ code: "outcome-unknown" });
    }
  });
});
