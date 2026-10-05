import fs from "node:fs/promises";
import path from "node:path";
import { deserialize } from "node:v8";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { patchSessionEntryCore } from "../../config/sessions/session-accessor.js";
import * as brokerReply from "../../infra/sqlite-worker-broker-reply.js";
import type { Slot } from "../../infra/sqlite-worker-broker.types.js";
import * as operationAdmission from "../../infra/sqlite-worker-operation-admission.js";
import { createDeferredCore } from "../../shared/deferred.js";
import * as stateWorker from "../../state/openclaw-state-worker-store.js";
import { placements, SESSION_ID, sessionTarget } from "./worker-turn-launcher.test-support.js";
import { useRepositoryWorkspaceResultFixture } from "./workspace-result-repository.test-support.js";

// This fixture clones a local Git origin; no GitHub identity is involved.
vi.mock("./worker-github-binding.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./worker-github-binding.js")>()),
  prepareWorkerRepositoryGitHubIdentity: async () => undefined,
  prepareWorkerGitHubBindingGrant: async () => undefined,
}));

describe("repository workspace editor admission", () => {
  const { fixture, readArtifact } = useRepositoryWorkspaceResultFixture();

  it.each(
    (["file", "native-incognito"] as const).flatMap((storage) =>
      (["healthy", "revoked"] as const).map((authority) => ({ storage, authority })),
    ),
  )(
    "checks $storage repository editor $authority authority at native commit",
    async ({ storage, authority }) => {
      const f = await fixture("worker-turn", false, storage === "native-incognito");
      const originalManifestRef = placements.get(SESSION_ID)!.workspaceBaseManifestRef;
      const editorBytes = "editor bytes retained for authorized recovery\n";
      const manifestWrites = vi.spyOn(placements, "updateWorkspaceBaseManifest");
      const createAdmission = operationAdmission.createSqliteWorkerOperationAdmission;
      let revoked = false;
      let commitObserved = false;
      let measuringCommit = false;
      const commitSql: string[] = [];
      const sql = observeHostDataSql((query) => {
        if (measuringCommit) {
          commitSql.push(query);
        }
      });
      const admission = vi
        .spyOn(operationAdmission, "createSqliteWorkerOperationAdmission")
        .mockImplementation((admit, attachment) =>
          createAdmission((request, grant) => {
            const input = manifestWrites.mock.calls[0]?.[0];
            const facts =
              isRecord(request.facts) && request.facts.kind === "session-entry-current"
                ? request.facts.domainFacts
                : request.facts;
            if (
              request.stage === "commit" &&
              input &&
              isRecord(facts) &&
              isRecord(facts.placement) &&
              facts.placement.sessionId === input.claim.sessionId &&
              facts.placement.workspaceBaseManifestRef === input.manifestRef
            ) {
              commitObserved = true;
              revoked = authority === "revoked";
              measuringCommit = true;
              try {
                admit(request, grant);
              } finally {
                measuringCommit = false;
              }
              return;
            }
            admit(request, grant);
          }, attachment),
        );
      try {
        placements.get(SESSION_ID);
        expect(sql.queries.length).toBeGreaterThan(0);
        const saving = f.mutations.mutate({
          ...sessionTarget,
          assertCurrent: () => {
            if (revoked) {
              throw new Error("repository editor authority closed");
            }
          },
          mutate: async (assertCurrent) => {
            assertCurrent();
            await fs.writeFile(path.join(f.remote, "editor.txt"), editorBytes);
            return { changed: true, value: "saved" };
          },
        });
        if (authority === "revoked") {
          await expect(saving).rejects.toThrow("repository editor authority closed");
        } else {
          await expect(saving).resolves.toBe("saved");
        }
        expect(commitObserved).toBe(true);
        expect(commitSql).toEqual([]);
        expect(revoked).toBe(authority === "revoked");
        expect(manifestWrites).toHaveBeenCalledOnce();
        expect(manifestWrites.mock.calls[0]![0].manifestRef).not.toBe(originalManifestRef);
        expect(placements.get(SESSION_ID)?.workspaceBaseManifestRef).toBe(
          authority === "revoked"
            ? originalManifestRef
            : manifestWrites.mock.calls[0]![0].manifestRef,
        );
        if (authority === "revoked") {
          expect(await placements.listPendingWorkspaceResultsAsync(SESSION_ID)).toMatchObject([
            {
              repositoryWorkspaceId: f.repository.workspaceId,
              stagedResultRef: expect.any(String),
              workspaceAcceptedAtMs: null,
              recoveryRequestedAtMs: expect.any(Number),
            },
          ]);
        } else {
          expect(await placements.listPendingWorkspaceResultsAsync(SESSION_ID)).toEqual([]);
          expect(placements.get(SESSION_ID)?.turnClaim).toBeNull();
        }
        const checkpoint = await readArtifact(f.repository.workspaceId, "editor.txt");
        expect(checkpoint.preview).toEqual(new Uint8Array(Buffer.from(editorBytes)));
      } finally {
        sql.restore();
        admission.mockRestore();
        manifestWrites.mockRestore();
      }
    },
  );

  it("rejects a queued repository manifest after its native session binding changes", async ({
    signal,
  }) => {
    const f = await fixture("worker-turn", false, true);
    const originalManifestRef = placements.get(SESSION_ID)!.workspaceBaseManifestRef;
    const replacement = await f.store.create({
      agentId: sessionTarget.agentId,
      sessionKey: "agent:main:dashboard:incognito-replacement",
      url: f.repository.url,
      runSetupScript: false,
      assertCurrent: () => {},
    });
    const editorBytes = "queued editor bytes retained for recovery\n";
    const predecessorHeld = createDeferredCore();
    const manifestQueued = createDeferredCore();
    const receive = brokerReply.receiveSqliteWorkerReply;
    const dispatch = brokerReply.dispatchSqliteWorkerJob;
    const dispatchedSlots = new WeakMap<object, Slot>();
    const runOperation = stateWorker.runOpenClawStateWorkerOperation;
    const updateManifest = placements.updateWorkspaceBaseManifest.bind(placements);
    let holding = false;
    let heldSlot: Slot | undefined;
    let deliver: (() => void) | undefined;
    let predecessor: ReturnType<typeof f.store.get> | undefined;
    const release = () => {
      const receiveHeld = deliver;
      deliver = undefined;
      receiveHeld?.();
    };
    signal.addEventListener("abort", release, { once: true });
    const dispatches = vi
      .spyOn(brokerReply, "dispatchSqliteWorkerJob")
      .mockImplementation((slot, job, onRejected) => {
        dispatchedSlots.set(slot, slot);
        dispatch(slot, job, onRejected);
      });
    const replies = vi
      .spyOn(brokerReply, "receiveSqliteWorkerReply")
      .mockImplementation((slot, reply, owner) => {
        if (
          holding &&
          !heldSlot &&
          slot.current?.request.type === "execute" &&
          reply.ok &&
          !reply.transfer &&
          !reply.input
        ) {
          const command: unknown = deserialize(slot.current.request.input);
          if (
            isRecord(command) &&
            command.type === "repositoryWorkspaces.get" &&
            isRecord(command.input) &&
            command.input.workspaceId === f.repository.workspaceId
          ) {
            heldSlot = dispatchedSlots.get(slot);
            if (!heldSlot) {
              throw new Error("Repository predecessor has no observed native dispatch");
            }
            deliver = () => receive(slot, reply, owner);
            predecessorHeld.resolve();
            if (signal.aborted) {
              release();
            }
            return;
          }
        }
        receive(slot, reply, owner);
      });
    const operations = vi
      .spyOn(stateWorker, "runOpenClawStateWorkerOperation")
      .mockImplementation((context, operation, options) =>
        runOperation(
          context,
          (scope) =>
            operation({
              execute: (command, executeOptions) => {
                const pending = scope.execute(command, executeOptions);
                if (command.type === "placementTurns.updateWorkspaceBaseManifest") {
                  manifestQueued.resolve();
                }
                return pending;
              },
            }),
          options,
        ),
      );
    const manifestWrites = vi
      .spyOn(placements, "updateWorkspaceBaseManifest")
      .mockImplementation(async (...args) => {
        holding = true;
        predecessor = f.store.get(f.repository.workspaceId);
        void predecessor.catch(predecessorHeld.reject);
        await predecessorHeld.promise;
        return updateManifest(...args);
      });
    const saving = f.mutations.mutate({
      ...sessionTarget,
      assertCurrent: () => {},
      mutate: async (assertCurrent) => {
        assertCurrent();
        await fs.writeFile(path.join(f.remote, "queued-editor.txt"), editorBytes);
        return { changed: true, value: "saved" };
      },
    });
    void saving.catch(() => {});
    try {
      await Promise.race([
        manifestQueued.promise,
        saving.then(() => {
          throw new Error("Editor save completed without queueing its manifest");
        }),
      ]);
      expect(
        heldSlot?.queue.some((job) => {
          if (job.request.type !== "execute") {
            return false;
          }
          const command: unknown = deserialize(job.request.input);
          return isRecord(command) && command.type === "placementTurns.updateWorkspaceBaseManifest";
        }),
      ).toBe(true);
      // The real predecessor has settled natively; only its ordinary reply holds the FIFO.
      const updated = await patchSessionEntryCore(
        sessionTarget,
        (entry) => ({ ...entry, repositoryWorkspaceId: replacement.workspaceId }),
        { replaceEntry: true },
      );
      expect(updated?.repositoryWorkspaceId).toBe(replacement.workspaceId);
      release();
      await predecessor;
      await expect(saving).rejects.toThrow("lost its exact session placement owner");
      expect(manifestWrites).toHaveBeenCalledOnce();
      expect(manifestWrites.mock.calls[0]![0].manifestRef).not.toBe(originalManifestRef);
      expect(placements.get(SESSION_ID)?.workspaceBaseManifestRef).toBe(originalManifestRef);
      expect(await placements.listPendingWorkspaceResultsAsync(SESSION_ID)).toMatchObject([
        {
          repositoryWorkspaceId: f.repository.workspaceId,
          stagedResultRef: expect.any(String),
          workspaceAcceptedAtMs: null,
          recoveryRequestedAtMs: expect.any(Number),
        },
      ]);
      const checkpoint = await readArtifact(f.repository.workspaceId, "queued-editor.txt");
      expect(checkpoint.preview).toEqual(new Uint8Array(Buffer.from(editorBytes)));
    } finally {
      release();
      await Promise.allSettled([saving, ...(predecessor ? [predecessor] : [])]);
      signal.removeEventListener("abort", release);
      manifestWrites.mockRestore();
      operations.mockRestore();
      replies.mockRestore();
      dispatches.mockRestore();
    }
  });
});
