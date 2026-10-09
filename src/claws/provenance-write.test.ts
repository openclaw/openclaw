import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withAgentDeletion } from "../agents/agent-lifecycle-registry.js";
import * as workerAdmission from "../infra/sqlite-worker-operation-admission.js";
import {
  CLAW_PACKAGE_LIFECYCLE_LEASE_SCOPE,
  clawPackageLifecycleLeaseKey,
} from "../state/claw-package-lifecycle-lease-key.js";
import {
  withClawPackageDeletionLease,
  withClawPackageLifecycleLease,
} from "../state/claw-package-lifecycle-lease.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { acquireOpenClawStateLeaseInTransaction } from "../state/openclaw-state-lease-store.js";
import type { OpenClawStateLeaseContext } from "../state/openclaw-state-lease.js";
import { beginAgentDeletionJournal } from "../test-utils/agent-deletion-journal.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import {
  digestClawMcpServer,
  readClawMcpServerRefs,
  reconcileClawMcpServerRefs,
  upsertClawMcpServerRef,
  type PersistedClawMcpServerRef,
} from "./mcp.js";
import type { PersistedClawPackageRef } from "./package-extension-provenance.js";
import { replaceClawPackageRefExpected } from "./package-update-provenance.js";
import { claimClawPackageRefStatus } from "./provenance-write.js";
import { readClawPackageRefs } from "./provenance.js";
import { upsertClawWorkspaceFile } from "./workspace.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterAll(async () => {
    await closeStateDatabaseForTest();
    cleanup();
  }),
);
const options = { env: { OPENCLAW_STATE_DIR: "" } };
let sequence = 0;

beforeAll(() => {
  options.env.OPENCLAW_STATE_DIR = tempDirs.make("openclaw-claw-provenance-worker-");
});
afterEach(() => {
  vi.restoreAllMocks();
});

function withPackageLease<T>(
  ref: PersistedClawPackageRef,
  operation: (lease: OpenClawStateLeaseContext) => Promise<T>,
) {
  return withClawPackageLifecycleLease(
    ref.kind === "plugin"
      ? { kind: ref.kind, source: ref.source, ref: ref.ref }
      : { kind: ref.kind, source: ref.source, ref: ref.ref, workspace: "/synthetic/workspace" },
    operation,
    options,
  );
}

function packageFixture(kind: PersistedClawPackageRef["kind"] = "plugin") {
  const id = `package-${++sequence}`;
  const ref: PersistedClawPackageRef = {
    schemaVersion: "openclaw.clawPackageRef.v1",
    agentId: id,
    clawName: "@fixture/worker",
    kind,
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
  if (kind === "skill") {
    fixtureWorkspace(ref, "/synthetic/workspace");
  }
  return ref;
}

function fixtureWorkspace(ref: PersistedClawPackageRef, workspace: string) {
  upsertClawWorkspaceFile(
    {
      schemaVersion: "openclaw.clawWorkspaceFileRecord.v1",
      agentId: ref.agentId,
      workspace,
      path: "SOUL.md",
      sourcePath: "SOUL.md",
      contentDigest: "sha256:fixture",
      status: "complete",
      createdAtMs: 1,
      updatedAtMs: 1,
    },
    options,
  );
}

function persisted(ref: PersistedClawPackageRef) {
  return readClawPackageRefs({ ...options, agentId: ref.agentId });
}

describe("Claw provenance worker writes", () => {
  it("retains both package and deletion owners and rejects a replaced deletion journal", async () => {
    const ref = packageFixture();
    await withAgentDeletion(
      ref.agentId,
      async (begin) => {
        const deletion = await begin({
          agentId: ref.agentId,
          workspaceDir: "/synthetic/workspace",
          agentDir: `/synthetic/agents/${ref.agentId}`,
          sessionsDir: `/synthetic/agents/${ref.agentId}/sessions`,
          deleteFiles: false,
        });
        await withClawPackageDeletionLease(
          { kind: "plugin", source: ref.source, ref: ref.ref },
          deletion,
          async (lease) => {
            const sql = observeMainThreadSql();
            sql.calibrate();
            let pending: PersistedClawPackageRef;
            try {
              pending = await claimClawPackageRefStatus(ref, "pending", {
                ...options,
                lease,
                deletion,
                nowMs: 2,
              });
              sql.expectIdle();
            } finally {
              sql.restore();
            }
            beginAgentDeletionJournal({ ...deletion.entry, operationId: "replacement" }, options);
            await expect(
              claimClawPackageRefStatus(pending, "failed", {
                ...options,
                lease,
                deletion,
                nowMs: 3,
              }),
            ).rejects.toThrow("no longer owns");
          },
        );
      },
      options,
    );
    expect(persisted(ref)).toEqual([{ ...ref, status: "pending", updatedAtMs: 2 }]);
  });

  it.each(["plugin", "skill"] as const)(
    "commits %s status without executing SQLite on the caller thread",
    async (kind) => {
      const ref = packageFixture(kind);
      await withPackageLease(ref, async (lease) => {
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
      });
      expect(persisted(ref)).toEqual([{ ...ref, status: "failed", updatedAtMs: 3 }]);
    },
  );

  it("reconciles only matching pending MCP ownership without caller-thread SQLite", async () => {
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
    const drifted = { ...pending, name: "drifted" };
    const failed = { ...pending, name: "failed", status: "failed" as const };
    const other = { ...pending, agentId: `${agentId}-other` };
    for (const ref of [pending, drifted, failed, other]) {
      upsertClawMcpServerRef(ref, options);
    }
    const { error: _error, ...retained } = pending;
    const complete = { ...retained, status: "complete", updatedAtMs: 2 };
    const sql = observeMainThreadSql();
    sql.calibrate();
    try {
      const reconciled = await reconcileClawMcpServerRefs(
        agentId,
        { matching: server, failed: server, drifted: { command: "changed" } },
        { ...options, nowMs: 2 },
      );
      sql.expectIdle();
      expect(reconciled).toEqual([drifted, failed, complete]);
    } finally {
      sql.restore();
    }
    expect(readClawMcpServerRefs(agentId, options)).toEqual([drifted, failed, complete]);
    expect(readClawMcpServerRefs(other.agentId, options)).toEqual([other]);
  });

  it.each(["transaction", "commit"] as const)(
    "rolls back a package claim when caller authority retires at %s admission",
    async (stage) => {
      const ref = packageFixture();
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
      await withPackageLease(ref, async (lease) => {
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
      });
      expect(retired).toBe(true);
      expect(persisted(ref)).toEqual([ref]);
    },
  );

  it("rejects a changed package owner inside the worker transaction", async () => {
    const ref = packageFixture();
    const replacement = { ...ref, independentOwner: true };
    replaceClawPackageRefExpected(ref, replacement, options);

    await withPackageLease(ref, async (lease) => {
      await expect(
        claimClawPackageRefStatus(ref, "pending", { ...options, lease }),
      ).rejects.toThrow("ownership changed before its status write");
    });
    expect(persisted(ref)).toEqual([replacement]);
  });

  it("keeps queued claims bound to the captured package", async () => {
    const ref = packageFixture();
    const original = structuredClone(ref);
    const other = packageFixture();
    let changed = false;
    const result = await withPackageLease(ref, (lease) =>
      claimClawPackageRefStatus(ref, "pending", {
        ...options,
        lease,
        nowMs: 2,
        assertCurrent: () => {
          if (!changed) {
            changed = true;
            Object.assign(ref, other);
          }
        },
      }),
    );
    const expected = { ...original, status: "pending", updatedAtMs: 2 };
    expect(result).toEqual(expected);
    expect(persisted(original)).toEqual([expected]);
    expect(persisted(other)).toEqual([other]);
  });

  it.each(["plugin", "skill"] as const)(
    "refuses to borrow another %s artifact's live package lease",
    async (kind) => {
      const ref = packageFixture(kind);
      const unrelated = packageFixture(kind);
      await withPackageLease(unrelated, async (lease) => {
        await expect(
          claimClawPackageRefStatus(ref, "pending", { ...options, lease }),
        ).rejects.toThrow("requires its original lifecycle owner");
      });
      expect(persisted(ref)).toEqual([ref]);
      expect(persisted(unrelated)).toEqual([unrelated]);
    },
  );

  it("refuses a skill claim after its recorded workspace changes", async () => {
    const ref = packageFixture("skill");
    await withPackageLease(ref, async (lease) => {
      fixtureWorkspace(ref, "/synthetic/replacement");
      await expect(
        claimClawPackageRefStatus(ref, "pending", { ...options, lease }),
      ).rejects.toThrow("does not match the held artifact lease");
    });
    expect(persisted(ref)).toEqual([ref]);
  });

  it("refuses a retained callback lease after its owner has closed", async () => {
    const ref = packageFixture();
    const lease = await withPackageLease(ref, async (current) => current);
    await expect(claimClawPackageRefStatus(ref, "pending", { ...options, lease })).rejects.toThrow(
      "requires its original live lease context",
    );
    expect(persisted(ref)).toEqual([ref]);
  });

  it("rejects a replaced lifecycle lease even while its original local handle remains active", async () => {
    const ref = packageFixture();
    await expect(
      withPackageLease(ref, async (lease) => {
        runOpenClawStateWriteTransaction(({ db }) => {
          acquireOpenClawStateLeaseInTransaction(
            db,
            {
              scope: CLAW_PACKAGE_LIFECYCLE_LEASE_SCOPE,
              key: clawPackageLifecycleLeaseKey({
                kind: "plugin",
                source: "clawhub",
                ref: ref.ref,
              }),
              owner: "replacement-owner",
            },
            5 * 60_000,
            undefined,
            Date.now() + 6 * 60_000,
          );
        }, options);
        await expect(
          claimClawPackageRefStatus(ref, "pending", { ...options, lease }),
        ).rejects.toMatchObject({ code: "OPENCLAW_STATE_LEASE_LOST" });
      }),
    ).rejects.toMatchObject({ code: "OPENCLAW_STATE_LEASE_LOST" });
    expect(persisted(ref)).toEqual([ref]);
  });
});
