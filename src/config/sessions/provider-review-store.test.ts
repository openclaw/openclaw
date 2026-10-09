import type { DatabaseSync, StatementSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import * as admission from "../../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../../infra/sqlite-worker-owner-probe.test-support.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "../../state/openclaw-agent-db-lifecycle.js";
import { readExistingAgentSchemaMeta } from "../../state/openclaw-agent-db-metadata.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { resolveSessionWorkStartError } from "./lifecycle.js";
import {
  compareSessionProviderReview,
  readSessionProviderReview,
} from "./provider-review-store.js";
import type { SessionProviderReview } from "./provider-review.types.js";
import { retainPreparedSessionSharingFacts } from "./session-accessor.sqlite-entry-cache-publication-state.js";
import {
  readExactSessionEntryRow,
  writeSessionEntry,
} from "./session-accessor.sqlite-entry-store.js";

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
const assertCurrent = () => {};
const original = {
  sessionId: target.sessionId,
  lifecycleRevision: target.lifecycleRevision,
  updatedAt: 1,
};

it("reopens an existing session and preserves its provider pause without a schema migration", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const database = openOpenClawAgentDatabase({ agentId: target.agentId });
    const selectedTarget = { ...target, storePath: database.path };
    const existingEntry = {
      ...original,
      label: "Existing session",
      lastRunId: "previous-run",
    };
    writeSessionEntry(database, target.sessionKey, existingEntry);
    const schema = readExistingAgentSchemaMeta(database.db);
    expect(schema?.schemaVersion).toEqual(expect.any(Number));
    await closeOpenClawAgentDatabaseByPathAsync(database.path, target.agentId);
    expect(database.db.isOpen).toBe(false);

    const existing = await readSessionProviderReview(selectedTarget, assertCurrent);
    expect(existing).toMatchObject(existingEntry);
    expect(existing?.providerReview).toBeUndefined();
    expect(
      resolveSessionWorkStartError(target.sessionKey, existing, {
        expectedSessionId: target.sessionId,
      }),
    ).toBeUndefined();

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
    await compareSessionProviderReview(selectedTarget, {
      expectedReview: undefined,
      nextReview: retainedReview,
      assertCurrent,
    });
    await closeOpenClawAgentDatabaseByPathAsync(database.path, target.agentId);

    const reopened = openOpenClawAgentDatabase({
      agentId: target.agentId,
      path: database.path,
    });
    expect(reopened.db.isOpen).toBe(true);
    expect(readExistingAgentSchemaMeta(reopened.db)).toEqual(schema);
    const persisted = await readSessionProviderReview(selectedTarget, assertCurrent);
    expect(persisted).toMatchObject(existingEntry);
    expect(persisted?.providerReview).toEqual(retainedReview);
    expect(
      resolveSessionWorkStartError(target.sessionKey, persisted, {
        expectedSessionId: target.sessionId,
      }),
    ).toContain("paused as a precaution");
  });
});

it.each(["default", "shared"] as const)(
  "publishes %s review admission facts without caller-thread SQLite",
  async (store) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const database = openOpenClawAgentDatabase({
        agentId: target.agentId,
        ...(store === "shared" ? { path: state.statePath("shared-review.sqlite") } : {}),
      });
      const selectedTarget = { ...target, storePath: database.path };
      writeSessionEntry(database, target.sessionKey, original);
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
      const statementPrototype: StatementSync = Object.getPrototypeOf(
        database.db.prepare("SELECT 1"),
      );
      const databasePrototype: DatabaseSync = Object.getPrototypeOf(database.db);
      const methods = [
        vi.spyOn(statementPrototype, "all"),
        vi.spyOn(statementPrototype, "get"),
        vi.spyOn(statementPrototype, "iterate"),
        vi.spyOn(statementPrototype, "run"),
        vi.spyOn(databasePrototype, "exec"),
      ];
      try {
        expect(await readSessionProviderReview(selectedTarget, assertCurrent)).toMatchObject(
          original,
        );
        expect(
          await compareSessionProviderReview(selectedTarget, {
            expectedReview: undefined,
            nextReview: review,
            assertCurrent,
          }),
        ).toMatchObject({ ...original, providerReview: review });
        expect(sharing.readCurrent()?.entry?.providerReview).toEqual(review);
        expect(
          resolveSessionWorkStartError(target.sessionKey, sharing.readCurrent()?.entry, {
            expectedSessionId: target.sessionId,
          }),
        ).toContain("paused as a precaution");
        const newer = { ...review, id: "review-2" };
        await compareSessionProviderReview(selectedTarget, {
          expectedReview: review,
          nextReview: newer,
          assertCurrent,
        });
        expect(sharing.readCurrent()?.entry?.providerReview).toEqual(newer);
        for (const stale of [review, { ...newer, runId: "changed-run" }]) {
          await expect(
            compareSessionProviderReview(selectedTarget, {
              expectedReview: stale,
              nextReview: undefined,
              assertCurrent,
            }),
          ).rejects.toThrow("Provider review changed");
          expect(sharing.readCurrent()?.entry?.providerReview).toEqual(newer);
        }
        for (const staleTarget of [
          { ...selectedTarget, sessionId: "old-session" },
          { ...selectedTarget, lifecycleRevision: "old-generation" },
          { ...selectedTarget, lifecycleRevision: undefined },
        ]) {
          expect(await readSessionProviderReview(staleTarget, assertCurrent)).toBeUndefined();
          await expect(
            compareSessionProviderReview(staleTarget, {
              expectedReview: newer,
              nextReview: undefined,
              assertCurrent,
            }),
          ).rejects.toThrow("Provider review changed");
          expect(sharing.readCurrent()?.entry?.providerReview).toEqual(newer);
        }
        expect(
          (await readSessionProviderReview(selectedTarget, assertCurrent))?.providerReview,
        ).toEqual(newer);
        expect(
          (
            await compareSessionProviderReview(selectedTarget, {
              expectedReview: newer,
              nextReview: undefined,
              assertCurrent,
            })
          ).providerReview,
        ).toBeUndefined();
        expect(sharing.readCurrent()?.entry).toMatchObject(original);
        expect(sharing.readCurrent()?.entry?.providerReview).toBeUndefined();
        expect(
          resolveSessionWorkStartError(target.sessionKey, sharing.readCurrent()?.entry, {
            expectedSessionId: target.sessionId,
          }),
        ).toBeUndefined();
        for (const method of methods) {
          expect(method).not.toHaveBeenCalled();
        }
      } finally {
        sharing.release();
        for (const method of methods) {
          method.mockRestore();
        }
      }
    });
  },
);

it("rolls back a clear when current authority is revoked at commit", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const database = openOpenClawAgentDatabase({ agentId: target.agentId });
    writeSessionEntry(
      database,
      target.sessionKey,
      {
        ...original,
        providerReview: review,
      },
      { providerReviewMutation: true },
    );
    let current = true;
    const admitted = probe.admission(admission, (request, grant, callback) => {
      if (request.stage === "commit") {
        current = false;
      }
      return callback(request, grant);
    });
    try {
      await expect(
        compareSessionProviderReview(target, {
          expectedReview: review,
          nextReview: undefined,
          assertCurrent() {
            if (!current) {
              throw new Error("Review authority revoked");
            }
          },
        }),
      ).rejects.toThrow("Review authority revoked");
      expect(current).toBe(false);
      expect(readExactSessionEntryRow(database, target.sessionKey)?.entry.providerReview).toEqual(
        review,
      );
    } finally {
      admitted.mockRestore();
    }
  });
});

it("preserves a current review through stale bookkeeping and drops it on lifecycle replacement", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const database = openOpenClawAgentDatabase({ agentId: target.agentId });
    writeSessionEntry(
      database,
      target.sessionKey,
      { ...original, providerReview: review },
      {
        providerReviewMutation: true,
      },
    );
    const stale = { ...original, updatedAt: 2, providerReview: undefined };
    expect(writeSessionEntry(database, target.sessionKey, stale).providerReview).toEqual(review);
    expect(
      writeSessionEntry(database, target.sessionKey, {
        ...original,
        lifecycleRevision: "generation-2",
        providerReview: review,
      }).providerReview,
    ).toBeUndefined();
  });
});
