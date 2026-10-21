import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import {
  isSessionEntryDataSql,
  observeHostDataSql,
} from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { readDatabasePathIdentitySync } from "../../infra/sqlite-worker-identity.js";
import * as admission from "../../infra/sqlite-worker-operation-admission.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { captureOpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  patchSessionEntryCore as patchInternalSessionEntry,
  patchSessionEntryTarget,
  recordInboundSessionMeta,
  replaceSessionEntry,
} from "./session-accessor.sqlite-entry.js";
import type { SessionEntryTargetPatchScope } from "./session-accessor.types.js";
import { createSessionCompoundWorkerFixture as fixture } from "./session-compound-worker.test-support.js";
import { readSessionEntryInWorker } from "./session-entry-read-writable.js";

// mock-isolation: Background maintenance must not race the transaction/commit authority fixture.
vi.mock("./session-accessor.sqlite-maintenance-kick.js", () => ({
  kickSessionEntryMaintenanceAfterWrite() {},
}));
// mock-isolation: History eviction is independent of the live mutation authority being tested.
vi.mock("./session-history-eviction.js", () => ({ kickSessionHistoryDiskBudgetMaintenance() {} }));

afterEach(() => vi.restoreAllMocks());

it.each([false, true])(
  "creates an entry and patches its admitted read target (creation witness: %s)",
  async (useCreationIdentity) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const options = { agentId: "main" };
      const storePath = resolveOpenClawAgentSqlitePath(options);
      const creator = captureOpenClawAgentDatabaseExecution(
        options,
        useCreationIdentity
          ? { expectedCreationIdentity: readDatabasePathIdentitySync(storePath) }
          : undefined,
      );
      const scope = { ...options, storePath, sessionKey: "agent:main:creating-patch" };
      const entry = { sessionId: "creating-patch", updatedAt: 1, label: "created in worker" };
      try {
        await expect(replaceSessionEntry(scope, entry)).resolves.toMatchObject(entry);
        expect(creator.fileIdentity).toMatchObject({ kind: "file" });
        let target: SessionEntryTargetPatchScope | undefined;
        await expect(
          readSessionEntryInWorker(scope, undefined, undefined, (captured) => {
            target = captured;
          }),
        ).resolves.toMatchObject(entry);
        if (!target) {
          throw new Error("Session read did not return its admitted target");
        }
        const updated = { sessionId: entry.sessionId, label: "updated through read target" };
        await expect(
          patchSessionEntryTarget(target, () => ({ label: updated.label }), {
            skipMaintenance: true,
          }),
        ).resolves.toMatchObject(updated);
        await expect(readSessionEntryInWorker(scope)).resolves.toMatchObject(updated);
      } finally {
        await creator.release();
      }
    });
  },
);

it("transfers an ordinary patch candidate with its final authority grant", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const f = fixture();
    const transfers: string[] = [];
    const createAdmission = admission.createSqliteWorkerOperationAdmission;
    vi.spyOn(admission, "createSqliteWorkerOperationAdmission").mockImplementation(
      (callback, attachment) =>
        createAdmission((request, grant) => {
          const publication = isRecord(request.facts) ? request.facts.publication : undefined;
          if (
            isRecord(publication) &&
            typeof publication.kind === "string" &&
            publication.kind.startsWith("session-entry-patch-") &&
            publication.kind !== "session-entry-patch-validated"
          ) {
            transfers.push(publication.kind);
            if (request.stage === "commit") {
              expect(f.read()).toMatchObject({ label: "initial" });
              expect(publication.transfer).toMatchObject({
                frames: [{ recordDone: true }, { done: true }],
              });
            }
          }
          callback(request, grant);
        }, attachment),
    );
    await expect(
      patchInternalSessionEntry(f.scope, () => ({ label: "committed candidate" }), {
        workerGuard: {},
        skipMaintenance: true,
      }),
    ).resolves.toMatchObject({ label: "committed candidate" });
    expect(f.read()).toMatchObject({ label: "committed candidate" });
    expect(transfers).toEqual(["session-entry-patch-committed"]);
  });
});

it.each(["allowed", "transaction", "commit"] as const)(
  "checks inbound authority only at native mutation grants (%s)",
  async (revokedAt) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const f = fixture();
      const original = f.read();
      let current = true;
      let edge: "transaction" | "commit" | undefined;
      const checks: Array<"transaction" | "commit"> = [];
      const refusal = new Error("peer trust revoked");
      const createAdmission = admission.createSqliteWorkerOperationAdmission;
      vi.spyOn(admission, "createSqliteWorkerOperationAdmission").mockImplementation(
        (callback, attachment) =>
          createAdmission((request, grant) => {
            const facts = request.facts;
            const publication = isRecord(facts) ? facts.publication : undefined;
            const previous = edge;
            edge =
              request.stage === "transaction" &&
              isRecord(publication) &&
              publication.kind === "session-entry-patch-validated"
                ? "transaction"
                : request.stage === "commit" &&
                    isRecord(publication) &&
                    publication.kind === "session-entry-patch-committed"
                  ? "commit"
                  : undefined;
            if (edge === "transaction") {
              expect(checks).toEqual([]);
            }
            if (edge === revokedAt) {
              current = false;
            }
            try {
              callback(request, grant);
            } finally {
              edge = previous;
            }
          }, attachment),
      );
      const result = recordInboundSessionMeta({
        storePath: f.scope.storePath,
        sessionKey: f.scope.sessionKey,
        ctx: { Provider: "reef", From: "reef:alice", ChatType: "direct", SenderName: "Alice" },
        assertCommitAllowed: () => {
          if (!edge) {
            throw new Error("mutation authority was polled during preparation");
          }
          checks.push(edge);
          if (!current) {
            throw refusal;
          }
        },
      });

      if (revokedAt === "allowed") {
        await expect(result).resolves.not.toBeNull();
        expect(f.read()).not.toEqual(original);
      } else {
        await expect(result).rejects.toBe(refusal);
        expect(f.read()).toEqual(original);
      }
      expect(checks).toEqual(
        revokedAt === "transaction" ? ["transaction"] : ["transaction", "commit"],
      );
    });
  },
);

it("checks legacy mutation authority after asynchronous patch preparation", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const f = fixture();
    const original = f.read();
    let prepared = false;
    let current = true;
    const refusal = new Error("native mutation authority revoked");
    const assertMutationAllowed = vi.fn(() => {
      expect(prepared).toBe(true);
      if (!current) {
        throw refusal;
      }
    });

    await expect(
      patchInternalSessionEntry(
        f.scope,
        async () => {
          await Promise.resolve();
          prepared = true;
          current = false;
          return { label: "must not persist" };
        },
        {
          assertCommitAllowed: assertMutationAllowed,
          skipMaintenance: true,
        },
      ),
    ).rejects.toBe(refusal);

    expect(assertMutationAllowed).toHaveBeenCalledOnce();
    expect(f.read()).toEqual(original);
  });
});

it.each([true, false])(
  "applies a host-guarded generation patch off the main thread (commit=%s)",
  async (shouldCommit) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const f = fixture();
      const original = f.read();
      const allowed = vi.fn();
      const sql = observeHostDataSql();
      try {
        const updated = await patchInternalSessionEntry(
          f.scope,
          async () => ({ sessionId: "successor", label: "updated" }),
          {
            assertCommitAllowed: allowed,
            shouldCommit: () => shouldCommit,
            skipMaintenance: true,
          },
        );
        expect(sql.queries.filter(isSessionEntryDataSql)).toEqual([]);
        if (shouldCommit) {
          expect(updated).toMatchObject({ sessionId: "successor", label: "updated" });
          expect(allowed).toHaveBeenCalled();
        } else {
          expect(updated).toBeNull();
          expect(allowed).not.toHaveBeenCalled();
        }
      } finally {
        sql.restore();
      }
      expect(f.read()).toMatchObject(
        shouldCommit ? { sessionId: "successor", label: "updated" } : original!,
      );
    });
  },
);
