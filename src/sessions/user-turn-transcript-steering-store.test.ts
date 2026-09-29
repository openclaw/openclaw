import { existsSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { readTranscriptRawDelta } from "../config/sessions/session-accessor.sqlite-delta.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.sqlite-entry.js";
import { readActiveTranscriptEntryAnchor } from "../config/sessions/session-accessor.sqlite-transcript-anchor.js";
import { rewriteTranscriptMessageAtAnchor } from "../config/sessions/session-accessor.sqlite-transcript-message-rewrite.js";
import { readTranscriptGenerationInTransaction } from "../config/sessions/session-accessor.sqlite-transcript-state.js";
import {
  appendTranscriptEventSync,
  appendTranscriptMessageSync,
} from "../config/sessions/session-accessor.sqlite-transcript-write.js";
import { markSessionTranscriptIndexDirtyInTransaction } from "../config/sessions/session-transcript-index.js";
import {
  resolveSqliteSessionTranscriptReadFence,
  runWithSessionTranscriptReadFence,
} from "../config/sessions/session-transcript-read-fence.js";
import { withOwnedSessionTranscriptWrites } from "../config/sessions/transcript-write-context.js";
import * as admission from "../infra/sqlite-worker-operation-admission.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../state/openclaw-agent-db.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { runOpenClawAgentWriteAdmission } from "../state/openclaw-agent-write-admission.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { confirmSteeredUserTurnTranscript } from "./user-turn-transcript-steering-store.js";
import type { SteeredUserTurnTranscriptSnapshot } from "./user-turn-transcript-steering.types.js";
import type { PersistedUserTurnMessage } from "./user-turn-transcript.types.js";

const tempDirs = useAutoCleanupTempDirTracker(afterAll);
let count = 0;
beforeAll(() => {
  vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("openclaw-steering-store-"));
});
afterEach(() => {
  vi.restoreAllMocks();
});
afterAll(async () => {
  await closeOpenClawAgentDatabasesAsync();
  await closeStateDatabaseForTest();
  vi.unstubAllEnvs();
});

function fixture(incognito = false) {
  const sessionId = "steer-" + ++count;
  const database = openOpenClawAgentDatabase({
    agentId: "main",
    ...(incognito ? { path: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main" }) } : {}),
  });
  const scope = {
    agentId: "main",
    sessionId,
    sessionKey: "agent:main:" + sessionId,
    storePath: database.path,
  };
  const entry = {
    sessionId,
    updatedAt: 1,
    lifecycleRevision: "lifecycle",
    activeWriterRunId: "run-A",
  };
  replaceSessionEntrySync(scope, entry);
  const append = (id: string): SteeredUserTurnTranscriptSnapshot => {
    const message: PersistedUserTurnMessage = {
      role: "user",
      content: id,
      timestamp: 1,
      idempotencyKey: sessionId + ":" + id,
      __openclaw: { keep: "untouched" },
    };
    const result = appendTranscriptMessageSync(scope, { eventId: id, message });
    if (!result.ok || !result.value) {
      throw new Error("fixture append refused");
    }
    const anchor = readActiveTranscriptEntryAnchor({ ...scope, entryId: id });
    if (!anchor) {
      throw new Error("fixture anchor absent");
    }
    return {
      admission: { ...anchor, role: "user", logicalTurnId: id },
      message: result.value.message,
    };
  };
  const A = append("A");
  const B = append("B");
  const target = { ...scope, expectedLifecycleRevision: "lifecycle", expectedWriterRunId: "run-A" };
  const input = {
    source: B,
    continuation: A,
    target,
    targetRunId: "run-A",
    assertCurrent: () => undefined,
  };
  const fence = (snapshot: SteeredUserTurnTranscriptSnapshot) =>
    runWithSessionTranscriptReadFence(snapshot.admission, () =>
      resolveSqliteSessionTranscriptReadFence({ database, ...scope }),
    );
  return { database, scope, entry, append, A, B, target, input, fence };
}

describe("committed steering receipt storage", () => {
  it("carries unchanged A through batched B confirmations, never preserving the old generation", async () => {
    const f = fixture();
    const C = f.append("C");
    f.append("later");
    const before = structuredClone(f.A);
    const raw = readTranscriptRawDelta(f.scope);
    if (raw.kind !== "page") {
      throw new Error("fixture raw cursor absent");
    }
    let installed = false;
    const first = await confirmSteeredUserTurnTranscript({
      ...f.input,
      onCommitted(result) {
        f.A.admission = { ...f.A.admission, generation: result.generation };
        installed = true;
      },
    });
    expect(installed).toBe(true);
    expect(first.changed).toBe(true);
    expect(readTranscriptRawDelta(f.scope, { cursor: raw.cursor })).toMatchObject({
      kind: "reset",
      reason: "generation_mismatch",
    });
    expect(first.generation).not.toBe(before.admission.generation);
    expect(first.message).toEqual({
      ...f.B.message,
      __openclaw: { keep: "untouched", steerTargetRunId: "run-A" },
    });
    expect(() => f.fence(before)).toThrow("identity changed");
    expect(f.fence(f.A)?.beforeRawSeq).toBe(before.admission.rawSeq);
    expect(f.A).toEqual({
      ...before,
      admission: { ...before.admission, generation: first.generation },
    });
    const second = await confirmSteeredUserTurnTranscript({
      ...f.input,
      source: C,
      continuation: f.A,
    });
    expect(second.generation).not.toBe(first.generation);
    f.A.admission = { ...f.A.admission, generation: second.generation };
    expect(f.fence(f.A)?.beforeRawSeq).toBe(before.admission.rawSeq);
    const noOp = await confirmSteeredUserTurnTranscript({
      ...f.input,
      source: {
        message: second.message,
        admission: { ...C.admission, generation: second.generation },
      },
      continuation: f.A,
    });
    expect(noOp).toEqual({ ...second, changed: false });
  });

  it("uses the sole process-held incognito owner without creating a durable database", async () => {
    const f = fixture(true);
    const result = await confirmSteeredUserTurnTranscript(f.input);
    expect(result.changed).toBe(true);
    expect(f.database.db.location()).toBe(null);
    expect(existsSync(f.scope.storePath)).toBe(false);
    f.A.admission = { ...f.A.admission, generation: result.generation };
    expect(f.fence(f.A)).toBeDefined();
  });

  it("does not issue Gateway-thread SQL during the durable operation", async () => {
    const f = fixture();
    const statement: StatementSync = Object.getPrototypeOf(f.database.db.prepare("SELECT 1"));
    const database: DatabaseSync = Object.getPrototypeOf(f.database.db);
    const spies = [
      vi.spyOn(statement, "all"),
      vi.spyOn(statement, "get"),
      vi.spyOn(statement, "iterate"),
      vi.spyOn(statement, "run"),
      vi.spyOn(database, "exec"),
    ];
    await confirmSteeredUserTurnTranscript(f.input);
    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
    }
  });

  it.each([
    "generation",
    "restored",
    "A",
    "B",
    "parent",
    "position",
    "dirty",
    "session",
    "writer",
    "lifecycle",
    "reset",
    "branch",
  ] as const)("refuses changed %s authority without callback", async (kind) => {
    const f = fixture();
    if (kind === "generation" || kind === "restored") {
      await rewriteTranscriptMessageAtAnchor(f.A.admission, () => ({
        ...f.A.message,
        content: "changed",
      }));
      if (kind === "restored") {
        await rewriteTranscriptMessageAtAnchor(f.A.admission, () => f.A.message);
      }
    } else if (kind === "A" || kind === "B") {
      // Simulates tampered private custody even when the durable generation is unchanged.
      f[kind].message = { ...f[kind].message, content: "changed" };
    } else if (kind === "parent") {
      f.B.admission = { ...f.B.admission, effectiveParentId: "other" };
    } else if (kind === "position") {
      f.B.admission = { ...f.B.admission, activeMessagePosition: 77 };
    } else if (kind === "dirty") {
      runOpenClawAgentWriteTransaction(
        (db) => markSessionTranscriptIndexDirtyInTransaction(db.db, f.scope.sessionId),
        { agentId: "main" },
      );
    } else if (kind === "branch") {
      appendTranscriptEventSync(f.scope, {
        type: "leaf",
        id: "leaf",
        parentId: "B",
        targetId: "A",
      });
    } else if (kind === "reset") {
      appendTranscriptEventSync(f.scope, {
        type: "reset",
        id: "reset",
        parentId: "B",
        timestamp: "2026-09-28T00:00:00Z",
        reason: "new",
      });
    } else {
      replaceSessionEntrySync(f.scope, {
        ...f.entry,
        ...(kind === "session"
          ? { sessionId: "replacement" }
          : kind === "writer"
            ? { activeWriterRunId: "other" }
            : { lifecycleRevision: "other" }),
      });
    }
    const committed = vi.fn();
    await expect(
      confirmSteeredUserTurnTranscript({ ...f.input, onCommitted: committed }),
    ).rejects.toThrow();
    expect(committed).not.toHaveBeenCalled();
  });

  it.each(["abort", "authority"] as const)(
    "rolls back %s loss at commit admission",
    async (kind) => {
      const f = fixture();
      const controller = new AbortController();
      let live = true;
      const create = admission.createSqliteWorkerOperationAdmission;
      let commitRequests = 0;
      vi.spyOn(admission, "createSqliteWorkerOperationAdmission").mockImplementation(
        (admit, attachment) =>
          create((request, grant) => {
            if (request.stage === "commit") {
              commitRequests++;
              if (kind === "abort") {
                controller.abort(new Error("cancelled at commit"));
              } else {
                live = false;
              }
            }
            admit(request, grant);
          }, attachment),
      );
      const committed = vi.fn();
      await expect(
        confirmSteeredUserTurnTranscript({
          ...f.input,
          signal: controller.signal,
          assertCurrent() {
            if (!live) {
              throw new Error("authority lost");
            }
          },
          onCommitted: committed,
        }),
      ).rejects.toThrow();
      expect(commitRequests).toBe(1);
      expect(committed).not.toHaveBeenCalled();
      expect(readTranscriptGenerationInTransaction(f.database, f.scope.sessionId)).toBe(
        f.A.admission.generation,
      );
      expect(f.fence(f.A)).toBeDefined();
    },
  );

  it("retains FIFO admission and refuses cancellation while queued", async () => {
    const f = fixture();
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const holder = runOpenClawAgentWriteAdmission({ agentId: "main" }, async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    const controller = new AbortController();
    const committed = vi.fn();
    const pending = confirmSteeredUserTurnTranscript({
      ...f.input,
      signal: controller.signal,
      onCommitted: committed,
    });
    const refused = expect(pending).rejects.toThrow();
    controller.abort();
    release.resolve();
    await holder;
    await refused;
    expect(committed).not.toHaveBeenCalled();
    expect(readTranscriptGenerationInTransaction(f.database, f.scope.sessionId)).toBe(
      f.A.admission.generation,
    );
  });

  it("retains a writer's logical store alias while committing the receipt's physical target", async () => {
    const f = fixture();
    const target = {
      ...f.target,
      storePath: path.join(
        path.dirname(path.dirname(f.scope.storePath)),
        "sessions",
        "sessions.json",
      ),
    };
    let checks = 0;
    const result = await withOwnedSessionTranscriptWrites(
      {
        sessionTarget: target,
        assertCommitAllowed: () => {
          checks++;
        },
        withTranscriptWrite: async (run) => await run(),
      },
      () => confirmSteeredUserTurnTranscript({ ...f.input, target }),
    );
    expect(result.changed).toBe(true);
    expect(checks).toBeGreaterThan(1);
  });

  it("installs its committed generation before cleanup or a queued follower", async () => {
    const f = fixture();
    const create = admission.createSqliteWorkerOperationAdmission;
    const stages: string[] = [];
    let committed = false;
    vi.spyOn(admission, "createSqliteWorkerOperationAdmission").mockImplementation(
      (admit, attachment) =>
        create((request, grant) => {
          if (committed && request.stage === "prepare") {
            stages.push("cleanup");
          }
          admit(request, grant);
        }, attachment),
    );
    let follower: Promise<void> | undefined;
    await confirmSteeredUserTurnTranscript({
      ...f.input,
      onCommitted(result) {
        committed = true;
        stages.push("installed");
        f.A.admission = { ...f.A.admission, generation: result.generation };
        follower = runOpenClawAgentWriteAdmission({ agentId: "main" }, () => {
          stages.push("follower");
          expect(f.fence(f.A)).toBeDefined();
        });
      },
    });
    await follower;
    expect(stages[0]).toBe("installed");
    expect(stages).toContain("cleanup");
    expect(stages.at(-1)).toBe("follower");
  });

  it("refuses a database owner retired while queued, without adopting its replacement", async () => {
    const f = fixture();
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const holder = runOpenClawAgentWriteAdmission({ agentId: "main" }, async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    const committed = vi.fn();
    const pending = confirmSteeredUserTurnTranscript({ ...f.input, onCommitted: committed });
    const refused = expect(pending).rejects.toThrow();
    const retiring = closeOpenClawAgentDatabasesAsync();
    release.resolve();
    await holder;
    await refused;
    await retiring;
    expect(committed).not.toHaveBeenCalled();
  });

  it("requires source generation when no continuation receipt authorizes its transfer", async () => {
    const f = fixture();
    const C = f.append("C");
    await confirmSteeredUserTurnTranscript(f.input);
    await expect(
      confirmSteeredUserTurnTranscript({ ...f.input, source: C, continuation: undefined }),
    ).rejects.toThrow("admission changed");
  });
});
