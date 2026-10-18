import type { DatabaseSync, StatementSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import * as admission from "../../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../../infra/sqlite-worker-owner-probe.test-support.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "../../state/openclaw-agent-db-lifecycle.js";
import { readExistingAgentSchemaMeta } from "../../state/openclaw-agent-db-metadata.js";
import { openOpenClawAgentDatabase as openDatabase } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { resolveSessionWorkStartError as workStartError } from "./lifecycle.js";
import {
  compareSessionProviderReview,
  readSessionProviderReview as readReview,
  type SessionProviderReviewTarget as Target,
} from "./provider-review-store.js";
import type { SessionProviderReview } from "./provider-review.types.js";
import { retainPreparedSessionSharingFacts } from "./session-accessor.sqlite-entry-cache-publication-state.js";
import {
  readExactSessionEntryRow as readRow,
  writeSessionEntry as writeEntry,
} from "./session-accessor.sqlite-entry-store.js";
import type { SessionEntry } from "./types.js";

const target = {
  agentId: "main",
  sessionKey: "agent:main:cron:provider-review",
  sessionId: "review-session",
  lifecycleRevision: "generation-1",
};
const review: SessionProviderReview = {
  id: "review-1",
  sessionId: target.sessionId,
  runId: "refused-run",
  provider: "openai",
  model: "test-model",
  runtimeId: "codex",
};
const assertAuthority = () => {};
const original = {
  sessionId: target.sessionId,
  lifecycleRevision: target.lifecycleRevision,
  updatedAt: 1,
};

function compare(
  selected: Target,
  nextReview: SessionProviderReview | undefined,
  expectedReview?: SessionProviderReview,
  assertCurrent = assertAuthority,
) {
  return compareSessionProviderReview(selected, { expectedReview, nextReview, assertCurrent });
}

function pauseError(entry: SessionEntry | undefined) {
  return workStartError(target.sessionKey, entry, { expectedSessionId: target.sessionId });
}

function withStore(
  options: { entry?: SessionEntry; shared?: boolean },
  run: (db: ReturnType<typeof openDatabase>, selected: Target) => Promise<void>,
) {
  return withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const database = openDatabase({
      agentId: target.agentId,
      ...(options.shared ? { path: state.statePath("shared-review.sqlite") } : {}),
    });
    writeEntry(database, target.sessionKey, options.entry ?? original, {
      providerReviewMutation: Boolean(options.entry?.providerReview),
    });
    await run(database, { ...target, storePath: database.path });
  });
}

it("reopens an existing session and preserves its provider pause without a schema migration", async () => {
  const existingEntry = { ...original, label: "Existing session", lastRunId: "previous-run" };
  await withStore({ entry: existingEntry }, async (database, selectedTarget) => {
    const schema = readExistingAgentSchemaMeta(database.db);
    expect(schema?.schemaVersion).toEqual(expect.any(Number));
    await closeOpenClawAgentDatabaseByPathAsync(database.path, target.agentId);
    expect(database.db.isOpen).toBe(false);

    const existing = await readReview(selectedTarget, assertAuthority);
    expect(existing).toMatchObject(existingEntry);
    expect([existing?.providerReview, pauseError(existing)]).toEqual([undefined, undefined]);

    const retainedReview: SessionProviderReview = {
      ...review,
      api: "openai-chatgpt-responses",
      nativeThreadId: "review-thread",
      nativeTurnId: "review-turn",
      review: {
        explanation: "Inspect the selected operation.\nKeep the original findings intact.",
        continuation: { message: "Continue only within the selected project." },
        errorType: "misalignment_policy_violation",
      },
    };
    await compare(selectedTarget, retainedReview);
    await closeOpenClawAgentDatabaseByPathAsync(database.path, target.agentId);

    const reopened = openDatabase({ agentId: target.agentId, path: database.path });
    expect(reopened.db.isOpen).toBe(true);
    expect(readExistingAgentSchemaMeta(reopened.db)).toEqual(schema);
    const persisted = await readReview(selectedTarget, assertAuthority);
    expect(persisted).toMatchObject(existingEntry);
    expect(persisted?.providerReview).toEqual(retainedReview);
    expect(pauseError(persisted)).toContain("paused as a precaution");
  });
});

it.each(["default", "shared"] as const)(
  "publishes %s review admission facts without caller-thread SQLite",
  async (store) => {
    await withStore({ shared: store === "shared" }, async (database, selectedTarget) => {
      const databaseIdentity = readOpenClawAgentDatabaseIdentity(database).identity;
      if (typeof databaseIdentity !== "string") {
        throw new Error("Expected a durable provider-review store");
      }
      const sharing = retainPreparedSessionSharingFacts({
        databaseIdentity: `file:${databaseIdentity}`,
        sessionKey: target.sessionKey,
        entry: original,
        membership: new Set(),
      });
      const entry = () => sharing.readCurrent()?.entry;
      const statement: StatementSync = Object.getPrototypeOf(database.db.prepare("SELECT 1"));
      const db: DatabaseSync = Object.getPrototypeOf(database.db);
      const methods = [
        ...(["all", "get", "iterate", "run"] as const).map((method) => vi.spyOn(statement, method)),
        vi.spyOn(db, "exec"),
      ];
      try {
        expect(await readReview(selectedTarget, assertAuthority)).toMatchObject(original);
        expect(await compare(selectedTarget, review)).toMatchObject({
          ...original,
          providerReview: review,
        });
        expect(entry()?.providerReview).toEqual(review);
        expect(pauseError(entry())).toContain("paused as a precaution");
        const newer = { ...review, id: "review-2" };
        await compare(selectedTarget, newer, review);
        expect(entry()?.providerReview).toEqual(newer);
        const rejectStale = async (selected: Target, stale = newer) => {
          await expect(compare(selected, undefined, stale)).rejects.toThrow(
            "Provider review changed",
          );
          expect(entry()?.providerReview).toEqual(newer);
        };
        for (const stale of [review, { ...newer, runId: "changed-run" }]) {
          await rejectStale(selectedTarget, stale);
        }
        for (const staleTarget of [
          { ...selectedTarget, sessionId: "old-session" },
          { ...selectedTarget, lifecycleRevision: "old-generation" },
          { ...selectedTarget, lifecycleRevision: undefined },
        ]) {
          expect(await readReview(staleTarget, assertAuthority)).toBeUndefined();
          await rejectStale(staleTarget);
        }
        expect((await readReview(selectedTarget, assertAuthority))?.providerReview).toEqual(newer);
        expect((await compare(selectedTarget, undefined, newer)).providerReview).toBeUndefined();
        expect(entry()).toMatchObject(original);
        expect([entry()?.providerReview, pauseError(entry())]).toEqual([undefined, undefined]);
        methods.forEach((method) => expect(method).not.toHaveBeenCalled());
      } finally {
        sharing.release();
        methods.forEach((method) => method.mockRestore());
      }
    });
  },
);

it("rolls back a clear when current authority is revoked at commit", async () => {
  await withStore({ entry: { ...original, providerReview: review } }, async (database) => {
    let current = true;
    const admitted = probe.admission(admission, (request, grant, callback) => {
      current = current && request.stage !== "commit";
      return callback(request, grant);
    });
    try {
      await expect(
        compare(target, undefined, review, () => {
          if (!current) {
            throw new Error("Review authority revoked");
          }
        }),
      ).rejects.toThrow("Review authority revoked");
      expect(current).toBe(false);
      expect(readRow(database, target.sessionKey)?.entry.providerReview).toEqual(review);
    } finally {
      admitted.mockRestore();
    }
  });
});

it("preserves a current review through stale bookkeeping and drops it on lifecycle replacement", async () => {
  await withStore({ entry: { ...original, providerReview: review } }, async (database) => {
    const stale = { ...original, updatedAt: 2, providerReview: undefined };
    expect(writeEntry(database, target.sessionKey, stale).providerReview).toEqual(review);
    expect(
      writeEntry(database, target.sessionKey, {
        ...original,
        lifecycleRevision: "generation-2",
        providerReview: review,
      }).providerReview,
    ).toBeUndefined();
  });
});
