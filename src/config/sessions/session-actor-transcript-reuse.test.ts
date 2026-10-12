import { expect, it, vi } from "vitest";
import { readActivitySummarySource } from "../../gateway/session-activity-summary-source.js";
import { capturePersistedModelPromptProjection } from "../../sessions/user-turn-transcript-updates.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
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

it("retains durable transcript reads across prompt capture and bookkeeping but refreshes body rewrites and resets", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const fixture = createSessionCompoundWorkerFixture();
    const scope = { ...fixture.scope, env };
    const answer = {
      type: "message",
      id: "answer",
      parentId: "question",
      message: { role: "assistant", content: "Original answer" },
    };
    const events = [
      { type: "session", id: scope.sessionId, version: 3, cwd: "/synthetic" },
      {
        type: "message",
        id: "question",
        parentId: null,
        message: { role: "user", content: "Original question" },
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
          const previousSeq = actor.snapshot(authority)!.transcript.version.rawSeq!;
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
            expect(actor.snapshot(authority)).toBeUndefined();
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

          const row = readTranscriptEventRows(fixture.database, scope.sessionId)[2]!;
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
