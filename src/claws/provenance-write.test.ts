import { StatementSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withClawMcpLifecycleLease } from "../agents/mcp-lifecycle-lease.js";
import * as workerAdmission from "../infra/sqlite-worker-operation-admission.js";
import {
  acquireClawPackageLifecycleLease,
  maintainClawPackageLifecycleLease,
  type MaintainedClawPackageLifecycleLease,
} from "../state/claw-package-lifecycle-lease.js";
import {
  withOpenClawStateLease,
  type OpenClawStateLeaseContext,
} from "../state/openclaw-state-lease.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import {
  digestClawMcpServer,
  readClawMcpServerRefs,
  readClawMcpServerRefsByName,
  upsertClawMcpServerRef,
  type PersistedClawMcpServerRef,
} from "./mcp.js";
import type { PersistedClawPackageRef } from "./package-extension-provenance.js";
import { replaceClawPackageRefExpected } from "./package-update-provenance.js";
import { claimClawPackageRefStatus, recoverClawMcpPendingRef } from "./provenance-write.js";
import { readClawPackageRefs } from "./provenance.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterAll(async () => {
    await closeStateDatabaseForTest();
    cleanup();
  }),
);
const options = { env: { OPENCLAW_STATE_DIR: "" } };
const leases: MaintainedClawPackageLifecycleLease[] = [];
let sequence = 0;

beforeAll(() => {
  options.env.OPENCLAW_STATE_DIR = tempDirs.make("openclaw-claw-provenance-worker-");
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const lease of leases.splice(0)) {
    lease.release();
  }
});

function acquireLease(ref: PersistedClawPackageRef, nowMs?: number) {
  const native = acquireClawPackageLifecycleLease(
    { kind: "plugin", source: "clawhub", ref: ref.ref },
    { ...options, required: true, nowMs },
  );
  if (!native) {
    throw new Error("Fixture package lease was not acquired.");
  }
  const lease = maintainClawPackageLifecycleLease(native);
  leases.push(lease);
  return lease;
}

function packageFixture() {
  const id = `package-${++sequence}`;
  const ref: PersistedClawPackageRef = {
    schemaVersion: "openclaw.clawPackageRef.v1",
    agentId: id,
    clawName: "@fixture/worker",
    kind: "plugin",
    source: "clawhub",
    ref: id,
    version: "1.0.0",
    integrity: `sha256:${id}`,
    status: "complete",
    relationship: "referenced",
    origin: "claw-introduced",
    independentOwner: false,
    installedAtMs: 1,
    updatedAtMs: 1,
  };
  replaceClawPackageRefExpected(undefined, ref, options);
  return { ref, lease: acquireLease(ref) };
}

function persisted(ref: PersistedClawPackageRef) {
  return readClawPackageRefs({ ...options, agentId: ref.agentId });
}

async function withRecoveryLeases<T>(
  agentId: string,
  name: string,
  run: (leases: {
    agentLease: OpenClawStateLeaseContext;
    mcpLease: OpenClawStateLeaseContext;
  }) => Promise<T>,
): Promise<T> {
  return await withOpenClawStateLease(
    {
      scope: "core:agent-deletion",
      key: agentId,
      database: { scope: "shared", options },
      leaseMs: 60_000,
      waitMs: 0,
      heartbeat: "worker",
      leaseLabel: "Claw MCP recovery test",
      operationLabel: "claw.mcp.recovery.test.lease",
    },
    async (agentLease) =>
      await withClawMcpLifecycleLease(
        name,
        options,
        async (_assertOwned, mcpLease) => await run({ agentLease, mcpLease }),
      ),
  );
}

describe("Claw provenance worker writes", () => {
  it("commits package status without executing SQLite on the caller thread", async () => {
    const { ref, lease } = packageFixture();
    const sql = observeMainThreadSql();
    sql.calibrate();
    try {
      const pending = await claimClawPackageRefStatus(ref, "pending", {
        ...options,
        lease,
        nowMs: 2,
      });
      expect(pending).toEqual({ ...ref, status: "pending", updatedAtMs: 2 });
      expect(
        await claimClawPackageRefStatus(pending, "failed", { ...options, lease, nowMs: 3 }),
      ).toEqual({ ...ref, status: "failed", updatedAtMs: 3 });
      sql.expectIdle();
    } finally {
      sql.restore();
    }
    expect(persisted(ref)).toEqual([{ ...ref, status: "failed", updatedAtMs: 3 }]);
  });

  it("claims only the exact pending MCP ref in the worker", async () => {
    const server = { command: "fixture-mcp", args: ["serve"] };
    const agentId = `mcp-${++sequence}`;
    const pending: PersistedClawMcpServerRef = {
      schemaVersion: "openclaw.clawMcpServerRef.v1",
      agentId,
      name: "matching",
      configDigest: digestClawMcpServer(server),
      relationship: "managed",
      origin: "claw-introduced",
      independentOwner: false,
      status: "pending",
      error: "Configuration response was lost.",
      createdAtMs: 1,
      updatedAtMs: 1,
    };
    const other = { ...pending, agentId: `${agentId}-other` };
    for (const ref of [pending, other]) {
      upsertClawMcpServerRef(ref, options);
    }
    const expectedRefs = readClawMcpServerRefsByName(pending.name, options);
    const claimed = await withRecoveryLeases(agentId, pending.name, async (recoveryLeases) => {
      const writes = vi.spyOn(StatementSync.prototype, "run");
      try {
        const result = await recoverClawMcpPendingRef(
          agentId,
          pending.name,
          "complete",
          expectedRefs,
          { ...options, ...recoveryLeases, nowMs: 2 },
        );
        expect(writes).not.toHaveBeenCalled();
        return result;
      } finally {
        writes.mockRestore();
      }
    });
    expect(claimed).toMatchObject({ agentId, name: pending.name, action: "complete" });
    const { error: _error, ...retained } = pending;
    expect(readClawMcpServerRefs(agentId, options)).toEqual([
      { ...retained, status: "complete", updatedAtMs: 2 },
    ]);
    expect(readClawMcpServerRefs(other.agentId, options)).toEqual([other]);
  });

  it("rejects a changed MCP ref inside the worker transaction", async () => {
    const agentId = `mcp-${++sequence}`;
    const pending: PersistedClawMcpServerRef = {
      schemaVersion: "openclaw.clawMcpServerRef.v1",
      agentId,
      name: "changed",
      configDigest: digestClawMcpServer({ command: "fixture-mcp" }),
      relationship: "managed",
      origin: "claw-introduced",
      independentOwner: false,
      status: "pending",
      createdAtMs: 1,
      updatedAtMs: 1,
    };
    upsertClawMcpServerRef(pending, options);
    const expectedRefs = readClawMcpServerRefsByName(pending.name, options);
    const adopted = { ...pending, independentOwner: true, updatedAtMs: 2 };
    upsertClawMcpServerRef(adopted, options);

    await withRecoveryLeases(agentId, pending.name, async (recoveryLeases) => {
      await expect(
        recoverClawMcpPendingRef(agentId, pending.name, "release", expectedRefs, {
          ...options,
          ...recoveryLeases,
        }),
      ).rejects.toThrow("ownership changed before recovery");
    });
    expect(readClawMcpServerRefs(agentId, options)).toEqual([adopted]);
  });

  it("rejects a changed sibling MCP ref inside the worker transaction", async () => {
    const agentId = `mcp-${++sequence}`;
    const pending: PersistedClawMcpServerRef = {
      schemaVersion: "openclaw.clawMcpServerRef.v1",
      agentId,
      name: "shared",
      configDigest: digestClawMcpServer({ command: "fixture-mcp" }),
      relationship: "managed",
      origin: "claw-introduced",
      independentOwner: false,
      status: "pending",
      createdAtMs: 1,
      updatedAtMs: 1,
    };
    const sibling = {
      ...pending,
      agentId: `${agentId}-other`,
      relationship: "referenced" as const,
    };
    upsertClawMcpServerRef(pending, options);
    upsertClawMcpServerRef(sibling, options);
    const expectedRefs = readClawMcpServerRefsByName(pending.name, options);
    const changedSibling = { ...sibling, independentOwner: true, updatedAtMs: 2 };
    upsertClawMcpServerRef(changedSibling, options);

    await withRecoveryLeases(agentId, pending.name, async (recoveryLeases) => {
      await expect(
        recoverClawMcpPendingRef(agentId, pending.name, "complete", expectedRefs, {
          ...options,
          ...recoveryLeases,
        }),
      ).rejects.toThrow("ownership changed before recovery");
    });
    expect(readClawMcpServerRefs(agentId, options)).toEqual([pending]);
    expect(readClawMcpServerRefs(sibling.agentId, options)).toEqual([changedSibling]);
  });

  it.each(["transaction", "commit"] as const)(
    "rolls back MCP recovery when caller authority retires at %s admission",
    async (stage) => {
      const agentId = `mcp-${++sequence}`;
      const pending: PersistedClawMcpServerRef = {
        schemaVersion: "openclaw.clawMcpServerRef.v1",
        agentId,
        name: `pending-${stage}`,
        configDigest: digestClawMcpServer({ command: "fixture-mcp" }),
        relationship: "managed",
        origin: "claw-introduced",
        independentOwner: false,
        status: "pending",
        createdAtMs: 1,
        updatedAtMs: 1,
      };
      upsertClawMcpServerRef(pending, options);
      const expectedRefs = readClawMcpServerRefsByName(pending.name, options);
      await withRecoveryLeases(agentId, pending.name, async (recoveryLeases) => {
        const originalAdmission = workerAdmission.createSqliteWorkerOperationAdmission;
        let retired = false;
        vi.spyOn(workerAdmission, "createSqliteWorkerOperationAdmission").mockImplementation(
          (admit, attachment) =>
            originalAdmission((request, grant) => {
              retired ||= request.stage === stage;
              admit(request, grant);
            }, attachment),
        );
        const error = new Error("MCP recovery owner retired.");
        await expect(
          recoverClawMcpPendingRef(agentId, pending.name, "complete", expectedRefs, {
            ...options,
            ...recoveryLeases,
            assertCurrent: () => {
              if (retired) {
                throw error;
              }
            },
          }),
        ).rejects.toBe(error);
        expect(retired).toBe(true);
      });
      expect(readClawMcpServerRefs(agentId, options)).toEqual([pending]);
    },
  );

  it.each(["transaction", "commit"] as const)(
    "rolls back a package claim when caller authority retires at %s admission",
    async (stage) => {
      const { ref, lease } = packageFixture();
      const originalAdmission = workerAdmission.createSqliteWorkerOperationAdmission;
      let retired = false;
      vi.spyOn(workerAdmission, "createSqliteWorkerOperationAdmission").mockImplementation(
        (admit, attachment) =>
          originalAdmission((request, grant) => {
            retired ||= request.stage === stage;
            admit(request, grant);
          }, attachment),
      );
      const error = new Error("Package removal owner retired.");
      await expect(
        claimClawPackageRefStatus(ref, "pending", {
          ...options,
          lease,
          assertCurrent: () => {
            if (retired) {
              throw error;
            }
          },
        }),
      ).rejects.toBe(error);
      expect(retired).toBe(true);
      expect(persisted(ref)).toEqual([ref]);
    },
  );

  it("rejects a changed package owner inside the worker transaction", async () => {
    const { ref, lease } = packageFixture();
    const replacement = { ...ref, independentOwner: true };
    replaceClawPackageRefExpected(ref, replacement, options);

    await expect(claimClawPackageRefStatus(ref, "pending", { ...options, lease })).rejects.toThrow(
      "ownership changed before its status write",
    );
    expect(persisted(ref)).toEqual([replacement]);
  });

  it("keeps queued claims bound to the captured package", async () => {
    const { ref, lease } = packageFixture();
    const original = structuredClone(ref);
    const other = packageFixture();
    let changed = false;
    const result = await claimClawPackageRefStatus(ref, "pending", {
      ...options,
      lease,
      nowMs: 2,
      assertCurrent: () => {
        if (!changed) {
          changed = true;
          Object.assign(ref, other.ref);
        }
      },
    });
    const expected = { ...original, status: "pending", updatedAtMs: 2 };
    expect(result).toEqual(expected);
    expect(persisted(original)).toEqual([expected]);
    expect(persisted(other.ref)).toEqual([other.ref]);
  });

  it("refuses to borrow another artifact's live package lease", async () => {
    const { ref } = packageFixture();
    const unrelated = packageFixture();

    await expect(
      claimClawPackageRefStatus(ref, "pending", { ...options, lease: unrelated.lease }),
    ).rejects.toThrow("requires its original lifecycle owner");
    expect(persisted(ref)).toEqual([ref]);
    expect(persisted(unrelated.ref)).toEqual([unrelated.ref]);
  });

  it("rejects a replaced lifecycle lease even while its original local handle remains active", async () => {
    const { ref, lease } = packageFixture();
    acquireLease(ref, Date.now() + 6 * 60_000);

    await expect(
      claimClawPackageRefStatus(ref, "pending", { ...options, lease }),
    ).rejects.toMatchObject({ code: "OPENCLAW_STATE_LEASE_LOST" });
    expect(persisted(ref)).toEqual([ref]);
  });
});
