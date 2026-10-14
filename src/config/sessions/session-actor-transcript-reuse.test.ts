import { expect, it, vi } from "vitest";
import { readActivitySummarySource } from "../../gateway/session-activity-summary-source.js";
import { readActivitySummaryBatch } from "../../gateway/session-activity-summary-source.worker.js";
import { capturePersistedModelPromptProjection } from "../../sessions/user-turn-transcript-updates.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { SessionActivitySummaryBatchResult } from "./activity-summary-source.types.js";
import { applySessionEntryLifecycleMutation } from "./session-accessor.sqlite-projection.js";
import { readTranscriptEventRows } from "./session-accessor.sqlite-read.js";
import { rewriteTranscriptEventRowsExact } from "./session-accessor.sqlite-transcript-write.js";
import { replaceTranscriptEvents } from "./session-accessor.sqlite-transcript-write.test-support.js";
import type { SessionActorAuthority } from "./session-actor-contract.js";
import { createDurableSessionActorFactory } from "./session-actor-durable.js";
import { createSessionCompoundWorkerFixture } from "./session-compound-worker.test-support.js";
import { recordSessionParticipantInWorker } from "./session-sharing-store.async.js";
import { readSessionTranscriptAnchorsAsync } from "./session-transcript-anchor-read.js";
import { prepareSessionTranscriptHydration } from "./session-transcript-hydration.js";
import { buildRestartRecoveryExpectedState } from "./session-transcript-turn-state.js";
import { historyLane, targetDiscoveryLane } from "./session-transcript-worker-resources.js";
import { withOwnedSessionTranscriptWrites } from "./transcript-write-context.js";

// mock-isolation: this transport proof does not schedule unrelated maintenance.
vi.mock("./session-accessor.sqlite-maintenance-kick.js", () => ({
  kickSessionEntryMaintenanceAfterWrite() {},
}));
// mock-isolation: Keep background disk-budget eviction out of the fixture's transport proof.
vi.mock("./session-history-eviction.js", () => ({ kickSessionHistoryDiskBudgetMaintenance() {} }));

const authority: SessionActorAuthority = { assertCurrent() {}, authorize() {} };

function summaryFacts(source: SessionActivitySummaryBatchResult) {
  if (!source) {
    throw new Error("Expected an activity summary source");
  }
  return {
    previous: source.previous,
    watermark: source.watermark,
    covered: source.covered,
    omitted: source.omitted,
    totalMessages: source.snapshot.totalMessages,
    activeLeafEntryId: source.snapshot.activeLeafEntryId,
    generation: source.snapshot.snapshot.generation,
    events: source.page.events.map(({ event }) => event),
    scannedMessages: source.page.scannedMessages,
  };
}

it("reuses durable summaries across model and runtime metadata while refreshing body rewrites and resets", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const fixture = createSessionCompoundWorkerFixture();
    const scope = { ...fixture.scope, env };
    const answer = {
      type: "message",
      id: "answer",
      parentId: "initial-runtime",
      message: { role: "assistant", content: "Original answer" },
    };
    const events = [
      { type: "session", id: scope.sessionId, version: 3, cwd: "/synthetic" },
      {
        type: "custom",
        id: "initial-model",
        parentId: null,
        customType: "model-snapshot",
        data: { provider: "synthetic", modelApi: "test-api", modelId: "first-model", timestamp: 1 },
      },
      {
        type: "message",
        id: "question",
        parentId: "initial-model",
        message: { role: "user", content: "Original question" },
      },
      {
        type: "custom_message",
        id: "initial-runtime",
        parentId: "question",
        customType: "openclaw.runtime-context",
        content: "Initial runtime",
        display: false,
        details: { source: "openclaw-runtime-context", runtimeContextCarrier: true },
      },
      answer,
    ];
    await replaceTranscriptEvents(scope, events);
    const identity = readOpenClawAgentDatabaseIdentity(fixture.database);
    if (typeof identity.identity !== "string") {
      throw new Error("Fixture requires durable storage");
    }
    const database = { agentId: "main", path: fixture.database.path, env };
    const actor = await createDurableSessionActorFactory(database).acquire(
      {
        sessionKey: scope.sessionKey,
        database: {
          kind: "file",
          physicalIdentity: identity.identity,
          birthtime: identity.birthtime,
          nativeLocation: fixture.database.path,
        },
      },
      { assertCurrent() {}, assertReadable() {} },
    );
    if ("kind" in actor) {
      throw new Error("Durable session must be actor-owned");
    }
    const historyReads = vi.spyOn(historyLane.pool, "run");
    const discoveryReads = vi.spyOn(targetDiscoveryLane.pool, "run");
    try {
      const cold = await readActivitySummarySource({ scope, assertCurrent() {} });
      expect(cold?.notes).toEqual(["user: Original question", "assistant: Original answer"]);
      expect(summaryFacts(cold)).toEqual(summaryFacts(readActivitySummaryBatch({ scope })));
      expect(historyReads).toHaveBeenCalled();
      await actor.read(authority);
      await withOwnedSessionTranscriptWrites(
        {
          sessionTarget: scope,
          sessionActor: { actor, database },
          withTranscriptWrite: async (write) => write(),
        },
        async () => {
          const hydration = prepareSessionTranscriptHydration(scope, {
            maxBytes: 1024 * 1024,
            maxEvents: 100,
          });
          expect((await hydration.read()).snapshot.events).toEqual(events);
          historyReads.mockClear();
          discoveryReads.mockClear();
          const initial = await readActivitySummarySource({ scope, assertCurrent() {} });
          expect(summaryFacts(initial)).toEqual(summaryFacts(cold));
          expect(initial?.notes).toEqual(cold?.notes);
          expect(historyReads).not.toHaveBeenCalled();
          expect(discoveryReads).not.toHaveBeenCalled();
          const previousSeq = actor.snapshot(authority)!.transcript.version.rawSeq!;
          const metadata = [
            {
              type: "custom",
              id: "switched-model",
              parentId: "answer",
              customType: "model-snapshot",
              data: {
                provider: "synthetic",
                modelApi: "test-api",
                modelId: "second-model",
                timestamp: 2,
              },
            },
            {
              type: "custom_message",
              id: "updated-runtime",
              parentId: "switched-model",
              customType: "openclaw.system-update",
              content: "Updated runtime",
              display: false,
              details: { kind: "runtime-context", turnScoped: true },
            },
          ];
          for (const event of metadata) {
            const appendedMetadata = await actor.appendTranscriptEvent(
              {
                commandId: event.id,
                phaseId: "turn",
                sessionId: scope.sessionId,
                lifecycleRevision: actor.snapshot(authority)!.entry!.lifecycleRevision ?? null,
                eventJson: JSON.stringify(event),
              },
              authority,
            );
            expect(appendedMetadata.kind).toBe("committed");
          }
          const userMessage = { role: "user" as const, content: "Next question", timestamp: 4 };
          const appended = await actor.appendToolResult(
            {
              commandId: "next-turn",
              phaseId: "turn",
              turn: {
                agentId: scope.agentId,
                sessionKey: scope.sessionKey,
                options: {
                  expectedSessionId: scope.sessionId,
                  sessionFile: "synthetic.jsonl",
                  messages: [
                    {
                      eventId: "next-question",
                      message: userMessage,
                      now: 4,
                    },
                  ],
                },
              },
            },
            authority,
          );
          expect(appended.kind).toBe("committed");
          const userAnchor = actor
            .snapshot(authority)!
            .transcript.anchors.find((anchor) => anchor.entryId === "next-question")!;
          const committed = vi.fn();
          const captured = await capturePersistedModelPromptProjection({
            admission: { ...userAnchor, logicalTurnId: "next-turn", role: "user" },
            message: userMessage,
            text: "Next question",
            assertCurrent() {},
            assertWritable() {},
            onCommitted: committed,
          });
          expect(committed).toHaveBeenCalledWith(
            expect.objectContaining({ generation: userAnchor.generation }),
            expect.objectContaining({
              __openclaw: { modelPromptProjection: { version: 1, text: "Next question" } },
            }),
          );
          expect(actor.snapshot(authority)?.transcript.anchors).toContainEqual(userAnchor);
          expect(
            (
              await actor.appendToolResult(
                {
                  commandId: "next-answer",
                  phaseId: "turn",
                  turn: {
                    agentId: scope.agentId,
                    sessionKey: scope.sessionKey,
                    options: {
                      expectedSessionId: scope.sessionId,
                      sessionFile: "synthetic.jsonl",
                      messages: [
                        {
                          eventId: "next-answer",
                          message: { role: "assistant", content: "Next answer" },
                          now: 5,
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
          discoveryReads.mockClear();
          const anchors = await readSessionTranscriptAnchorsAsync(scope, {
            entryIds: ["next-question", "next-answer"],
            afterSeq: previousSeq,
            includeWatermark: true,
          });
          expect(anchors.anchors.map((anchor) => anchor.entryId)).toEqual([
            "next-question",
            "next-answer",
          ]);
          expect(anchors.tail?.entries.map((entry) => entry.entryId)).toEqual([
            "next-question",
            "next-answer",
          ]);
          const summary = await readActivitySummarySource({ scope, assertCurrent() {} });
          expect(summaryFacts(summary)).toEqual(summaryFacts(readActivitySummaryBatch({ scope })));
          expect(summary?.snapshot.totalMessages).toBe(4);
          expect(summary?.notes).toEqual([
            "user: Original question",
            "assistant: Original answer",
            "user: Next question",
            "assistant: Next answer",
          ]);
          expect(summary?.snapshot.activeLeafEntryId).toBe("next-answer");
          expect(summary?.page.events).toContainEqual({
            event: expect.objectContaining({ id: "next-question", message: captured }),
          });
          expect(summary?.page.events.at(-1)?.event).toMatchObject({
            id: "next-answer",
            message: { content: "Next answer" },
          });
          expect((await hydration.read()).snapshot.events).toContainEqual(
            expect.objectContaining({ id: "next-question", message: captured }),
          );
          expect(historyReads).not.toHaveBeenCalled();
          expect(discoveryReads).not.toHaveBeenCalled();
          const updateMetadata = (label: string) =>
            applySessionEntryLifecycleMutation({
              ...scope,
              skipMaintenance: true,
              upserts: [
                {
                  sessionKey: scope.sessionKey,
                  buildEntry: ({ currentEntry }) => ({ ...currentEntry!, label }),
                },
              ],
            });
          await updateMetadata("next turn");
          expect(actor.snapshot(authority)?.entry?.label).toBe("next turn");
          historyReads.mockClear();
          const warm = await hydration.read();
          expect(warm.snapshot.events).toMatchObject([
            ...events,
            ...metadata,
            { id: "next-question", message: { role: "user", content: "Next question" } },
            { id: "next-answer", message: { role: "assistant", content: "Next answer" } },
          ]);
          expect(historyReads).not.toHaveBeenCalled();

          const expectedState = buildRestartRecoveryExpectedState(
            actor.snapshot(authority)!.entry!,
          );
          const recordAndAdopt = async (contributionCount: number) => {
            await expect(
              recordSessionParticipantInWorker(scope, {
                identity: { type: "agent", id: "helper" },
                sessionAgentId: scope.agentId,
                promptedAt: 10 + contributionCount,
              }),
            ).resolves.toBe(contributionCount === 1 ? "inserted" : "updated");
            const adopted = await actor.adoptRun(
              {
                commandId: `participant-${contributionCount}`,
                phaseId: "turn",
                sessionId: scope.sessionId,
                expectedState,
                lifecycle: {},
                runId: `participant-${contributionCount}`,
              },
              authority,
            );
            expect(adopted.kind).toBe("committed");
            expect(actor.snapshot(authority)?.participants).toEqual([
              {
                identity: { type: "agent", id: "helper" },
                contributionCount,
                firstPromptedAt: 11,
                lastPromptedAt: 10 + contributionCount,
              },
            ]);
          };
          for (const contributionCount of [1, 2]) {
            await recordAndAdopt(contributionCount);
            historyReads.mockClear();
            expect((await hydration.read()).snapshot.events).toEqual(warm.snapshot.events);
            expect(historyReads).not.toHaveBeenCalled();
          }

          const row = readTranscriptEventRows(fixture.database, scope.sessionId).find(
            (candidate) => JSON.parse(candidate.eventJson).id === answer.id,
          )!;
          const rewrittenAnswer = {
            ...answer,
            message: { role: "assistant", content: "Corrected answer" },
          };
          await expect(
            rewriteTranscriptEventRowsExact(scope, {
              expectedGeneration: warm.snapshot.version.generation,
              rows: [{ seq: row.seq, expectedEventJson: row.eventJson, event: rewrittenAnswer }],
            }),
          ).resolves.not.toBeNull();
          await updateMetadata("after rewrite");
          expect(actor.snapshot(authority)).toBeUndefined();
          await recordAndAdopt(3);
          historyReads.mockClear();
          const rewrittenSummary = await readActivitySummarySource({ scope, assertCurrent() {} });
          expect(summaryFacts(rewrittenSummary)).toEqual(
            summaryFacts(readActivitySummaryBatch({ scope })),
          );
          expect(rewrittenSummary?.notes).toEqual([
            "user: Original question",
            "assistant: Corrected answer",
            "user: Next question",
            "assistant: Next answer",
          ]);
          expect(historyReads).toHaveBeenCalled();
          historyReads.mockClear();
          const refreshed = await hydration.read();
          expect(refreshed.snapshot.events).toContainEqual(rewrittenAnswer);
          expect(refreshed.snapshot.events).not.toContainEqual(answer);
          expect(historyReads).toHaveBeenCalled();

          await applySessionEntryLifecycleMutation({
            ...scope,
            skipMaintenance: true,
            upserts: [
              {
                sessionKey: scope.sessionKey,
                buildEntry: ({ currentEntry }) => ({ ...currentEntry!, label: "after reset" }),
                resetBoundary: {
                  context: "clear",
                  reason: "reset",
                  boundaryId: "reset-boundary",
                  cwd: "/synthetic",
                },
              },
            ],
          });
          expect(actor.snapshot(authority)).toBeUndefined();
          await actor.read(authority);
          historyReads.mockClear();
          const reset = await hydration.read();
          expect(reset.snapshot.events).toContainEqual(
            expect.objectContaining({ type: "reset", id: "reset-boundary", reason: "reset" }),
          );
          expect(historyReads).toHaveBeenCalled();
        },
      );
    } finally {
      historyReads.mockRestore();
      discoveryReads.mockRestore();
      await actor.release();
    }
  });
});
