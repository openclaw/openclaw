import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { appendSessionManagerActor } from "../agents/sessions/session-manager-actor-append.js";
import { SqliteBoardStore } from "../boards/sqlite-board-store.js";
import { getRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import { bindSessionTranscriptStoreScope } from "../config/sessions/session-accessor.transcript-target.js";
import type { SessionActor } from "../config/sessions/session-actor-contract.js";
import { withSessionActor } from "../config/sessions/session-actor-scope.js";
import { buildRestartRecoveryExpectedState } from "../config/sessions/session-transcript-turn-state.js";
import type { InternalSessionEntry as Entry } from "../config/sessions/types.js";
import { patchSessionEntry as patchSdkSessionEntry } from "../plugin-sdk/session-store-runtime.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import * as rowFixture from "./session-row-projection.read-fixture.test-support.js";
import * as transcriptBackfill from "./session-row-transcript-backfill.js";

// Hold GatewayScheduler timeouts so WAL maintenance stays outside the request SQL budget.
beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }));
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const authority = { assertCurrent() {}, authorize() {} };
type Scope = { agentId: string; sessionKey: string };
async function withActorRow(
  name: string,
  run: (actor: SessionActor, entry: Entry, scope: Scope) => Promise<void>,
) {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    setRuntimeConfigSnapshot({});
    const scope = { agentId: "main", sessionKey: `agent:main:${name}` };
    const entry = { sessionId: name, lifecycleRevision: name, updatedAt: 1 };
    replaceSessionEntrySync(scope, entry);
    const exercised = await withSessionActor(
      scope,
      { assertCurrent() {}, assertReadable() {} },
      async (actor) => {
        await actor.read(authority);
        await run(actor, entry, scope);
        return true;
      },
    );
    expect(exercised).toBe(true);
  });
}

async function actorProjection(scope: Scope) {
  const cfg = getRuntimeConfigSnapshot()!;
  const reads: string[][] = [];
  rowFixture.watchRowFacts((owner) => (input) => {
    reads.push([...input.sessionKeys]);
    return owner.readRowFacts(input);
  });
  const projection = await rowFixture.createTestProjection({ cfg, modelCatalog: [] });
  return Object.assign(projection, {
    cfg,
    reads,
    query: { agentId: scope.agentId, key: scope.sessionKey },
  });
}

it("reuses actor row facts after metadata writes and refreshes Board presence after a write", async () => {
  await withActorRow("actor-row-facts", async (_actor, { sessionId }, scope) => {
    const updateLabel = (label: string, updatedAt: number) =>
      patchSdkSessionEntry({
        ...scope,
        skipMaintenance: true,
        update: () => ({ updatedAt, label }),
      });
    await updateLabel("Committed metadata", 2);
    using _ = rowFixture.holdForeground();
    using projection = await actorProjection(scope);
    const { reads, query } = projection;
    const expectRow = async (label: string, hasBoard: boolean) => {
      await projection.ensureMaterialized();
      expect(projection.snapshot(query).row).toMatchObject({ sessionId, label, hasBoard });
      expect(reads).toEqual(hasBoard ? [[scope.sessionKey]] : []);
    };
    await expectRow("Committed metadata", false);
    const board = new SqliteBoardStore({
      resolveSession: ({ sessionKey }) => ({ agentId: scope.agentId, sessionKey }),
    });
    await board.putWidget({
      sessionKey: scope.sessionKey,
      name: "status",
      content: { kind: "html", html: "<p>Current</p>" },
    });
    await expectRow("Committed metadata", true);
    await updateLabel("Metadata after Board", 3);
    await expectRow("Metadata after Board", true);
  });
});

it("publishes terminal actor recency before another run begins", async () => {
  await withActorRow("actor-terminal-recency", async (actor, entry, scope) => {
    using _ = rowFixture.holdForeground();
    using projection = await actorProjection(scope);
    const { query, reads } = projection;
    await projection.ensureMaterialized();
    expect(projection.snapshot(query).row?.updatedAt).toBe(1);
    await actor.completeTurn(
      {
        commandId: "visible-result",
        phaseId: "terminal",
        bookkeeping: {
          sessionId: entry.sessionId,
          lifecycleRevision: entry.lifecycleRevision ?? null,
          writerRunId: undefined,
          expectedState: buildRestartRecoveryExpectedState(entry),
          lifecycle: { updatedAt: 2 },
        },
      },
      authority,
    );
    await projection.ensureMaterialized();
    expect(projection.snapshot(query).row?.updatedAt).toBe(2);
    expect(reads).toEqual([]);
  });
});

it("publishes user and assistant actor previews without background reads or losing the replica", async () => {
  await withActorRow("actor-preview", async (actor, entry, scope) => {
    const backfill = vi.spyOn(transcriptBackfill, "backfillSessionRowTranscriptFields");
    using release = rowFixture.holdForeground();
    using projection = await actorProjection(scope);
    const { cfg, reads, query } = projection;
    const expectPreview = async (text: string, activeMessageCount: number) => {
      await projection.ensureMaterialized();
      const row = projection.snapshot(query, { includeLastMessage: true }).row;
      expect(row?.lastMessagePreview).toBe(text);
      expect(actor.snapshot(authority)?.transcript).toMatchObject({
        anchorsState: "unavailable",
        projection: { state: { activeMessageCount } },
      });
    };
    await projection.ensureMaterialized();
    await actor.acceptInput(
      {
        commandId: "accepted-input",
        phaseId: "turn",
        expectedState: buildRestartRecoveryExpectedState(entry),
        lifecycle: {},
        turn: {
          ...scope,
          options: {
            expectedSessionId: entry.sessionId,
            sessionFile: "synthetic.jsonl",
            touchSessionEntry: false,
            messages: [
              {
                eventId: "accepted-input",
                message: { role: "user", content: "Accepted question" },
                now: 2,
              },
            ],
          },
        },
      },
      authority,
    );
    await expectPreview("Accepted question", 1);

    await appendSessionManagerActor({
      actor,
      toolResult: false,
      assertCurrent() {},
      append: {
        kind: "message",
        input: {
          scope: bindSessionTranscriptStoreScope({ ...scope, sessionId: entry.sessionId }, cfg),
          cwd: "/synthetic",
          messageJson: JSON.stringify({
            role: "assistant",
            content: "Committed answer",
            timestamp: 3,
          }),
        },
      },
    });
    await expectPreview("Committed answer", 2);
    expect(reads).toEqual([]);

    release();
    await nextTurn();
    expect(backfill).not.toHaveBeenCalled();
  });
});
