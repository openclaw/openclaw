import { deserialize } from "node:v8";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { patchSessionEntryCore } from "../../config/sessions/session-accessor.js";
import * as brokerReply from "../../infra/sqlite-worker-broker-reply.js";
import type { Slot } from "../../infra/sqlite-worker-broker.types.js";
import type { SqliteWorkerRequest } from "../../infra/sqlite-worker-contract.js";
import * as operationAdmission from "../../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../../infra/sqlite-worker-owner-probe.test-support.js";
import { createDeferredCore } from "../../shared/deferred.js";
import * as stateWorker from "../../state/openclaw-state-worker-store.js";
import { placements, SESSION_ID, sessionTarget } from "./worker-turn-launcher.test-support.js";
import { useRepositoryWorkspaceResultFixture } from "./workspace-result-repository.test-support.js";

// mock-isolation: This fixture clones a local Git origin without GitHub credentials.
vi.mock("./repository-github-identity.js", () => ({
  prepareRepositoryGitHubIdentity: async (_agentId: string, assertCurrent: () => void) => ({
    token: undefined,
    assertSelected: assertCurrent,
    start: async (start: () => Promise<unknown>) => await start(),
  }),
}));

function readCommand(request: SqliteWorkerRequest) {
  const command: unknown = request.type === "execute" ? deserialize(request.input) : undefined;
  return isRecord(command) ? command : undefined;
}

describe("repository workspace editor admission", () => {
  const { fixture, readArtifact } = useRepositoryWorkspaceResultFixture();
  async function editorFixture(incognito: boolean) {
    const f = await fixture("worker-turn", false, incognito);
    const original = placements.get(SESSION_ID)!.workspaceBaseManifestRef;
    const updateManifest = placements.updateWorkspaceBaseManifest.bind(placements);
    const manifestWrites = vi.spyOn(placements, "updateWorkspaceBaseManifest");
    return {
      ...f,
      manifestWrites,
      updateManifest,
      async expectSave(file: string, bytes: string, accepted = false) {
        expect(manifestWrites).toHaveBeenCalledOnce();
        const manifestRef = manifestWrites.mock.calls[0]![0].manifestRef;
        expect(manifestRef).not.toBe(original);
        expect(placements.get(SESSION_ID)?.workspaceBaseManifestRef).toBe(
          accepted ? manifestRef : original,
        );
        if (accepted) {
          await f.expectSettled();
        } else {
          await f.expectUnaccepted({
            repositoryWorkspaceId: f.repository.workspaceId,
            stagedResultRef: expect.any(String),
          });
        }
        const checkpoint = await readArtifact(f.repository.workspaceId, file);
        expect(checkpoint.preview).toEqual(new Uint8Array(Buffer.from(bytes)));
      },
    };
  }

  it.each(
    (["file", "native-incognito"] as const).flatMap((storage) =>
      (["healthy", "revoked"] as const).map((authority) => ({ storage, authority })),
    ),
  )(
    "checks $storage repository editor $authority authority at native commit",
    async ({ storage, authority }) => {
      const f = await editorFixture(storage === "native-incognito");
      const editorBytes = "editor bytes retained for authorized recovery\n";
      let revoked = false;
      let commitSql: string[] | undefined;
      let liveSql: string[] | undefined;
      const sql = observeHostDataSql((query) => liveSql?.push(query));
      const admission = probe.admission(operationAdmission, (request, grant, admit) => {
        const input = f.manifestWrites.mock.calls[0]?.[0];
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
          revoked = authority === "revoked";
          liveSql = commitSql ??= [];
          try {
            admit(request, grant);
          } finally {
            liveSql = undefined;
          }
          return;
        }
        admit(request, grant);
      });
      try {
        const saving = f.save("editor.txt", editorBytes, () => {
          if (revoked) {
            throw new Error("repository editor authority closed");
          }
        });
        if (authority === "revoked") {
          await expect(saving).rejects.toThrow("repository editor authority closed");
        } else {
          await expect(saving).resolves.toBe("saved");
        }
        expect(commitSql).toEqual([]);
        expect(revoked).toBe(authority === "revoked");
        await f.expectSave("editor.txt", editorBytes, authority === "healthy");
      } finally {
        sql.restore();
        admission.mockRestore();
        f.manifestWrites.mockRestore();
      }
    },
  );

  it("fences queued manifests after session rebinding", async ({ signal }) => {
    const f = await editorFixture(true);
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
    const predecessorRequests = new WeakMap<object, Slot>();
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
        const command = readCommand(job.request);
        if (
          command?.type === "repositoryWorkspaces.get" &&
          isRecord(command.input) &&
          command.input.workspaceId === f.repository.workspaceId
        ) {
          predecessorRequests.set(job.request, slot);
        }
        return dispatch(slot, job, onRejected);
      });
    const replies = vi
      .spyOn(brokerReply, "receiveSqliteWorkerReply")
      .mockImplementation((slot, reply, owner) => {
        if (
          holding &&
          !heldSlot &&
          slot.current &&
          predecessorRequests.has(slot.current.request) &&
          reply.ok &&
          !reply.transfer &&
          !reply.input
        ) {
          heldSlot = predecessorRequests.get(slot.current.request);
          deliver = () => receive(slot, reply, owner);
          predecessorHeld.resolve();
          if (signal.aborted) {
            release();
          }
          return;
        }
        receive(slot, reply, owner);
      });
    const operations = probe.command(stateWorker, (command, executeOptions, scope) => {
      const pending = scope.execute(command, executeOptions);
      if (command.type === "placementTurns.updateWorkspaceBaseManifest") {
        manifestQueued.resolve();
      }
      return pending;
    });
    f.manifestWrites.mockImplementation(async (...args) => {
      holding = true;
      predecessor = f.store.get(f.repository.workspaceId);
      void predecessor.catch(predecessorHeld.reject);
      await predecessorHeld.promise;
      return f.updateManifest(...args);
    });
    const saving = f.save("queued-editor.txt", editorBytes);
    void saving.catch(() => {});
    try {
      await Promise.race([
        manifestQueued.promise,
        saving.then(() => {
          throw new Error("Editor save completed without queueing its manifest");
        }),
      ]);
      expect(
        heldSlot?.queue.some(
          (job) => readCommand(job.request)?.type === "placementTurns.updateWorkspaceBaseManifest",
        ),
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
      await f.expectSave("queued-editor.txt", editorBytes);
    } finally {
      release();
      await Promise.allSettled([saving, ...(predecessor ? [predecessor] : [])]);
      signal.removeEventListener("abort", release);
      f.manifestWrites.mockRestore();
      operations.mockRestore();
      replies.mockRestore();
      dispatches.mockRestore();
    }
  });
});
