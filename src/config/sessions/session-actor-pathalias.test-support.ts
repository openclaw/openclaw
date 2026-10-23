import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, vi } from "vitest";
import { readActivitySummarySource } from "../../gateway/session-activity-summary-source.js";
import { readSessionTranscriptAccountingAsync } from "../../gateway/session-transcript-readers.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db-contract.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import { upsertSessionEntryCore } from "./session-accessor.sqlite-entry.js";
import { appendTranscriptMessage } from "./session-accessor.sqlite-transcript-write.js";
import { captureDurableSessionActor } from "./session-actor-durable.js";
import { readSessionActorProjectionReceipt } from "./session-actor-replica.js";
import { prepareSessionTranscriptHydration } from "./session-transcript-hydration.js";
import {
  readSessionTranscriptProjectionReceipt,
  withSessionTranscriptProjectionReceipt,
} from "./session-transcript-projection-facts-scope.js";
import { historyLane } from "./session-transcript-worker-resources.js";
import { withOwnedSessionTranscriptWrites } from "./transcript-write-context.js";

export async function createAliasedSessionStateRoot(
  root: string,
  stateDir = path.join(root, "state"),
) {
  await fs.mkdir(stateDir, { recursive: true });
  const alias = path.join(root, "state-alias");
  await fs.symlink(
    await fs.realpath(stateDir),
    alias,
    process.platform === "win32" ? "junction" : "dir",
  );
  return alias;
}

/** Exercise the same admitted-alias contract against SQLite and PostgreSQL owners. */
export async function assertSessionActorPathAliasReuse(
  database: OpenClawAgentDatabase,
  otherDatabase: OpenClawAgentDatabase,
  env: NodeJS.ProcessEnv = process.env,
) {
  const sessionKey = "agent:main:pathalias";
  const sessionId = "pathalias-transcript";
  const scope = { agentId: database.agentId, storePath: database.path, sessionKey, sessionId, env };
  const otherScope = { ...scope, agentId: otherDatabase.agentId, storePath: otherDatabase.path };
  const identity = readOpenClawAgentDatabaseIdentity(database);
  assert.notEqual(database.path, identity.canonicalPath, "The configured store must use its alias");
  const canonicalScope = { ...scope, storePath: identity.canonicalPath };
  await upsertSessionEntryCore(scope, { sessionId, updatedAt: 1 });
  await appendTranscriptMessage(scope, {
    eventId: "question",
    message: { role: "user", content: "Aliased question" },
    now: 1,
  });
  await appendTranscriptMessage(scope, {
    eventId: "answer",
    message: { role: "assistant", content: "Aliased answer", usage: { input: 20, output: 3 } },
    now: 2,
  });
  await upsertSessionEntryCore(otherScope, { sessionId, updatedAt: 1 });
  await appendTranscriptMessage(otherScope, {
    eventId: "other-question",
    message: { role: "user", content: "Different database" },
    now: 1,
  });

  const authority = { assertCurrent() {}, assertReadable() {}, authorize() {} };
  const actorDatabase = { agentId: database.agentId, path: database.path, env };
  const actor = captureDurableSessionActor({
    database: actorDatabase,
    target: {
      sessionKey,
      database: {
        kind: "file",
        physicalIdentity: identity.identity,
        birthtime: identity.birthtime,
        nativeLocation: identity.canonicalPath,
      },
    },
    lifetime: authority,
  });
  const historyReads = vi.spyOn(historyLane.pool, "run");
  const accountingOptions = { includeByteSize: true, includeUsage: true, includeTurnTaint: true };
  try {
    await actor.read(authority);
    await withOwnedSessionTranscriptWrites(
      {
        sessionTarget: scope,
        sessionActor: { actor, database: actorDatabase },
        withTranscriptWrite: async (write) => write(),
      },
      async () => {
        const hydration = prepareSessionTranscriptHydration(scope, {
          maxBytes: 1024 * 1024,
          maxEvents: 100,
        });
        assert(hydration.readCohort);
        await hydration.readCohort({ sessionKey, entryIds: ["question"] }, (prepared) => {
          expect(prepared.snapshot.events).toEqual(
            expect.arrayContaining([expect.objectContaining({ id: "question" })]),
          );
        });

        for (const current of [canonicalScope, scope]) {
          historyReads.mockClear();
          expect(
            await readSessionTranscriptAccountingAsync(current, accountingOptions),
          ).toMatchObject({
            eventCount: 2,
            usage: { promptTokens: 20, outputTokens: 3, trailingMessages: [] },
          });
          expect(
            (await readActivitySummarySource({ scope: current, assertCurrent() {} }))?.notes,
          ).toEqual(["user: Aliased question", "assistant: Aliased answer"]);
          expect(historyReads, `Warm reads through ${current.storePath}`).not.toHaveBeenCalled();
          const receipt = readSessionActorProjectionReceipt({
            path: current.storePath,
            sessionKey,
            sessionId,
          });
          assert(receipt, "An admitted alias must select the actor projection receipt");
          withSessionTranscriptProjectionReceipt(receipt, () => {
            for (const spelling of [database.path, identity.canonicalPath]) {
              expect(
                readSessionTranscriptProjectionReceipt({ ...database, path: spelling }, sessionId),
              ).toMatchObject({ contextStats: { eventCount: 2 } });
            }
            expect(
              readSessionTranscriptProjectionReceipt(otherDatabase, sessionId),
            ).toBeUndefined();
          });
        }

        historyReads.mockClear();
        expect(
          readSessionActorProjectionReceipt({ path: otherDatabase.path, sessionKey, sessionId }),
        ).toBeUndefined();
        expect(
          await readSessionTranscriptAccountingAsync(otherScope, accountingOptions),
        ).toMatchObject({ eventCount: 1 });
        expect(
          (await readActivitySummarySource({ scope: otherScope, assertCurrent() {} }))?.notes,
        ).toEqual(["user: Different database"]);
        expect(historyReads).toHaveBeenCalled();

        expect(
          (
            await actor.appendToolResult(
              {
                commandId: "pathalias-next-question",
                phaseId: "turn",
                turn: {
                  agentId: database.agentId,
                  sessionKey,
                  options: {
                    expectedSessionId: sessionId,
                    sessionFile: "synthetic.jsonl",
                    messages: [
                      {
                        eventId: "next-question",
                        message: { role: "user", content: "Next question" },
                        now: 3,
                      },
                    ],
                  },
                },
              },
              authority,
            )
          ).kind,
        ).toBe("committed");
        historyReads.mockClear();
        expect(await readSessionTranscriptAccountingAsync(scope, accountingOptions)).toMatchObject({
          eventCount: 3,
          usage: {
            trailingMessages: [expect.objectContaining({ role: "user", content: "Next question" })],
          },
        });
        expect((await readActivitySummarySource({ scope, assertCurrent() {} }))?.notes).toEqual([
          "user: Aliased question",
          "assistant: Aliased answer",
          "user: Next question",
        ]);
        expect(historyReads).not.toHaveBeenCalled();
      },
    );
  } finally {
    historyReads.mockRestore();
    await actor.release();
  }
}
