import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SqliteBoardStore } from "../boards/sqlite-board-store.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import { withSessionActor } from "../config/sessions/session-actor-scope.js";
import * as history from "../config/sessions/session-transcript-worker-runtime.js";
import { patchSessionEntry as patchSdkSessionEntry } from "../plugin-sdk/session-store-runtime.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { retainSessionListForegroundWork } from "./session-projection-work.js";
import { createSessionRowProjection } from "./session-row-projection.js";

// Hold GatewayScheduler timeouts so WAL maintenance stays outside the request SQL budget.
beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }));
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function observeRowFacts(
  wrap: (
    owner: history.SessionHistoryWorkerDatabase,
  ) => history.SessionHistoryWorkerDatabase["readRowFacts"],
  once = false,
) {
  const readDatabases = history.withSessionHistoryWorkerDatabases;
  const observe: typeof readDatabases = (databases, consume, lane) =>
    readDatabases(
      databases,
      (owners) =>
        consume(
          owners.map((owner) => ({
            ...owner,
            readRowFacts: wrap(owner),
          })),
        ),
      lane,
    );
  const spy = vi.spyOn(history, "withSessionHistoryWorkerDatabases");
  return once ? spy.mockImplementationOnce(observe) : spy.mockImplementation(observe);
}

it("reuses actor row facts after metadata writes and refreshes Board presence after a write", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const scope = { agentId: "main", sessionKey: "agent:main:actor-row-facts" };
    const entry = {
      sessionId: "actor-row-facts",
      lifecycleRevision: "actor-row-lifecycle",
      updatedAt: 1,
      label: "Initial",
      skillsSnapshot: { prompt: "Saved actor instructions", skills: [] },
    };
    replaceSessionEntrySync(scope, entry);
    const authority = { assertCurrent() {}, authorize() {} };
    const exercised = await withSessionActor(
      scope,
      { assertCurrent() {}, assertReadable() {} },
      async (actor) => {
        await actor.read(authority);
        const updateLabel = (label: string, updatedAt: number) =>
          patchSdkSessionEntry({
            ...scope,
            skipMaintenance: true,
            update: () => ({ updatedAt, label }),
          });
        await updateLabel("Committed metadata", 2);
        const reads: string[][] = [];
        observeRowFacts((owner) => (input) => {
          reads.push([...input.sessionKeys]);
          return owner.readRowFacts(input);
        });
        const release = retainSessionListForegroundWork();
        const projection = await createSessionRowProjection({ cfg: {}, modelCatalog: [] });
        const query = { agentId: scope.agentId, key: scope.sessionKey };
        try {
          await projection.ensureMaterialized();
          expect(projection.snapshot(query).row).toMatchObject({
            sessionId: entry.sessionId,
            label: "Committed metadata",
            hasBoard: false,
          });
          expect(projection.describe(query)?.retainedDatabaseFacts?.entry).not.toHaveProperty(
            "skillsSnapshot",
          );
          expect(reads).toEqual([]);

          const board = new SqliteBoardStore({
            resolveSession: ({ sessionKey }) => ({ agentId: scope.agentId, sessionKey }),
          });
          await board.putWidget({
            sessionKey: scope.sessionKey,
            name: "status",
            content: { kind: "html", html: "<p>Current</p>" },
          });
          await projection.ensureMaterialized();
          expect(projection.snapshot(query).row).toMatchObject({
            hasBoard: true,
            label: "Committed metadata",
          });
          expect(reads).toEqual([[scope.sessionKey]]);
          await updateLabel("Metadata after Board", 3);
          await projection.ensureMaterialized();
          expect(projection.snapshot(query).row).toMatchObject({
            hasBoard: true,
            label: "Metadata after Board",
          });
          expect(reads).toEqual([[scope.sessionKey]]);
        } finally {
          projection.dispose();
          release();
        }
        return true;
      },
    );
    expect(exercised).toBe(true);
  });
});
