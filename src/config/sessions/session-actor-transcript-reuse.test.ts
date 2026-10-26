import { assert, expect, it, vi } from "vitest";
import { readActivitySummarySource } from "../../gateway/session-activity-summary-source.js";
import { readActivitySummaryBatch } from "../../gateway/session-activity-summary-source.worker.js";
import { readSessionTranscriptAccountingAsync } from "../../gateway/session-transcript-readers.js";
import { capturePersistedModelPromptProjection } from "../../sessions/user-turn-transcript-updates.js";
import type { UserTurnTranscriptAdmissionReceipt } from "../../sessions/user-turn-transcript.types.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { captureRuntimeConfigAsyncReader } from "../io.runtime.js";
import { readSessionTranscriptBoundedActiveContextCore } from "./session-accessor.sqlite-active-context.js";
import { applySessionEntryLifecycleMutation } from "./session-accessor.sqlite-projection.js";
import { readTranscriptEventRows } from "./session-accessor.sqlite-read.js";
import { rewriteTranscriptEventRowsExact } from "./session-accessor.sqlite-transcript-write.js";
import { replaceTranscriptEvents } from "./session-accessor.sqlite-transcript-write.test-support.js";
import type { SessionTranscriptTurnMessageAppend } from "./session-accessor.types.js";
import type { SessionActor, SessionActorAuthority } from "./session-actor-contract.js";
import { createSessionActorFactory } from "./session-actor-durable.js";
import { summaryFacts, transcriptTurnCommand } from "./session-actor-transcript.test-support.js";
import { createSessionCompoundWorkerFixture } from "./session-compound-worker.test-support.js";
import { recordSessionParticipantInWorker } from "./session-sharing-store.async.js";
import { readSessionTranscriptAnchorsAsync } from "./session-transcript-anchor-read.js";
import { prepareSessionTranscriptHydration } from "./session-transcript-hydration.js";
import { runWithSessionTranscriptReadFence } from "./session-transcript-read-fence.js";
import { buildRestartRecoveryExpectedState } from "./session-transcript-turn-state.js";
import { historyLane, targetDiscoveryLane } from "./session-transcript-worker-resources.js";
import { messageEvent } from "./transcript-message.test-support.js";
import { withOwnedSessionTranscriptWrites } from "./transcript-write-context.js";

// mock-isolation: this transport proof does not schedule unrelated maintenance.
vi.mock("./session-accessor.sqlite-maintenance-kick.js", () => ({
  kickSessionEntryMaintenanceAfterWrite() {},
}));
// mock-isolation: Keep background disk-budget eviction out of the fixture's transport proof.
vi.mock("./session-history-eviction.js", () => ({ kickSessionHistoryDiskBudgetMaintenance() {} }));

const authority: SessionActorAuthority = { assertCurrent() {}, authorize() {} };

async function acquireActor(
  fixture: ReturnType<typeof createSessionCompoundWorkerFixture>,
  env: NodeJS.ProcessEnv,
) {
  const identity = readOpenClawAgentDatabaseIdentity(fixture.database);
  assert(typeof identity.identity === "string", "Fixture requires durable storage");
  const database = { agentId: "main", path: fixture.database.path, env };
  const actor = await createSessionActorFactory(database).acquire(
    {
      sessionKey: fixture.scope.sessionKey,
      database: {
        kind: "file",
        physicalIdentity: identity.identity,
        birthtime: identity.birthtime,
        nativeLocation: fixture.database.path,
      },
    },
    { assertCurrent() {}, assertReadable() {} },
  );
  assert(!("kind" in actor), "Durable session must be actor-owned");
  return { actor, database };
}

function appendMessage(
  actor: SessionActor,
  scope: { agentId: string; sessionKey: string; sessionId: string },
  eventId: string,
  message: SessionTranscriptTurnMessageAppend["message"],
  now: number,
  commandId = eventId,
) {
  return actor.appendToolResult(
    transcriptTurnCommand(scope, commandId, [{ eventId, message, now }]),
    authority,
  );
}

it("reuses durable summaries and accounting while refreshing transcript writes and resets", () =>
  withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    await captureRuntimeConfigAsyncReader()();
    const fixture = createSessionCompoundWorkerFixture();
    const scope = { ...fixture.scope, env };
    const answer = messageEvent("answer", "initial-runtime", {
      role: "assistant",
      content: "Original answer",
      usage: { input: 200, output: 7 },
    });
    const events = [
      { type: "session", id: scope.sessionId, version: 3, cwd: "/synthetic" },
      {
        type: "custom",
        id: "initial-model",
        parentId: null,
        customType: "model-snapshot",
        data: { provider: "synthetic", modelApi: "test-api", modelId: "first-model", timestamp: 1 },
      },
      messageEvent("question", "initial-model", { role: "user", content: "Original question" }),
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
    const { actor, database } = await acquireActor(fixture, env);
    const historyReads = vi.spyOn(historyLane.pool, "run");
    const discoveryReads = vi.spyOn(targetDiscoveryLane.pool, "run");
    const clearReads = () => {
      historyReads.mockClear();
      discoveryReads.mockClear();
    };
    const expectResident = () => {
      expect(historyReads).not.toHaveBeenCalled();
      expect(discoveryReads).not.toHaveBeenCalled();
    };
    const accountingOptions = { includeByteSize: true, includeUsage: true, includeTurnTaint: true };
    const initialAccounting = {
      byteSize: events
        .slice(1)
        .reduce((bytes, event) => bytes + Buffer.byteLength(JSON.stringify(event)) + 1, 0),
      eventCount: 4,
      turnTainted: false,
      usage: { promptTokens: 200, outputTokens: 7, trailingMessages: [] },
    };
    try {
      expect(await readSessionTranscriptAccountingAsync(scope, accountingOptions)).toEqual(
        initialAccounting,
      );
      expect(historyReads).toHaveBeenCalled();
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
          assert(hydration.readCohort, "Expected bounded transcript cohort reader");
          await hydration.readCohort(
            { sessionKey: scope.sessionKey, entryIds: ["question"] },
            (prepared) => {
              assert(prepared.kind === "bounded", "Expected bounded transcript hydration");
              expect(prepared.snapshot.events).toEqual(events);
              expect(prepared.transcript?.anchors.map((anchor) => anchor.entryId)).toEqual([
                "question",
              ]);
            },
          );
          clearReads();
          const seeded = await readSessionTranscriptAnchorsAsync(scope, {
            entryIds: ["question"],
          });
          expect(seeded.anchors.map((anchor) => anchor.entryId)).toEqual(["question"]);
          expectResident();
          const uncovered = await readSessionTranscriptAnchorsAsync(scope, {
            entryIds: ["answer"],
          });
          expect(uncovered.anchors.map((anchor) => anchor.entryId)).toEqual(["answer"]);
          expect(historyReads).toHaveBeenCalled();
          clearReads();
          const initial = await readActivitySummarySource({ scope, assertCurrent() {} });
          expect(summaryFacts(initial)).toEqual(summaryFacts(cold));
          expect(initial?.notes).toEqual(cold?.notes);
          expect(await readSessionTranscriptAccountingAsync(scope, accountingOptions)).toEqual(
            initialAccounting,
          );
          expectResident();
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
          const appended = await appendMessage(
            actor,
            scope,
            "next-question",
            userMessage,
            4,
            "next-turn",
          );
          expect(appended.kind).toBe("committed");
          assert(appended.kind === "committed", "Expected a committed user append");
          const userAnchor = appended.receipt.transcript.appendedMessages.find(
            (message) => message.messageId === "next-question",
          )?.anchor;
          assert(userAnchor, "User append omitted its committed anchor");
          clearReads();
          expect(
            (await readSessionTranscriptAnchorsAsync(scope, { entryIds: ["next-question"] }))
              .anchors,
          ).toContainEqual(userAnchor);
          expectResident();
          const accounting = await readSessionTranscriptAccountingAsync(scope, accountingOptions);
          expect(accounting.usage).toEqual({
            promptTokens: 200,
            outputTokens: 7,
            trailingMessages: [userMessage],
          });
          const trailing = accounting.usage?.trailingMessages[0];
          if (trailing?.role === "user") {
            trailing.content = "caller-owned copy";
          }
          expect(
            (await readSessionTranscriptAccountingAsync(scope, accountingOptions)).usage
              ?.trailingMessages,
          ).toEqual([userMessage]);
          expect(
            await readSessionTranscriptAccountingAsync(scope, {
              ...accountingOptions,
              includeByteSize: false,
              usageEventLimit: 0,
            }),
          ).toEqual({ usage: undefined, turnTainted: false });
          expect(historyReads).not.toHaveBeenCalled();
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
          clearReads();
          expect(
            (await readSessionTranscriptAnchorsAsync(scope, { entryIds: ["next-question"] }))
              .anchors,
          ).toContainEqual(userAnchor);
          expectResident();
          expect(
            (
              await appendMessage(
                actor,
                scope,
                "next-answer",
                {
                  role: "assistant",
                  content: "Next answer",
                  usage: { input: 500, output: 11 },
                  __openclaw: { turnTainted: true },
                },
                5,
              )
            ).kind,
          ).toBe("committed");
          clearReads();
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
          expectResident();
          clearReads();
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
          const completedAccounting = await readSessionTranscriptAccountingAsync(
            scope,
            accountingOptions,
          );
          expect(completedAccounting).toMatchObject({
            eventCount: 8,
            turnTainted: true,
            usage: { promptTokens: 500, outputTokens: 11, trailingMessages: [] },
          });
          expectResident();
          expect(
            await runWithSessionTranscriptReadFence(
              { ...userAnchor, logicalTurnId: "next-turn", role: "user" },
              () => readSessionTranscriptAccountingAsync(scope, accountingOptions),
            ),
          ).toEqual(completedAccounting);
          expect(historyReads).toHaveBeenCalled();
          historyReads.mockClear();
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
          const rewrittenAnchors = await readSessionTranscriptAnchorsAsync(scope, {
            entryIds: ["next-question"],
          });
          expect(rewrittenAnchors.anchors).toHaveLength(1);
          expect(rewrittenAnchors.anchors[0]).toMatchObject({ entryId: "next-question" });
          expect(rewrittenAnchors.anchors[0]?.generation).not.toBe(userAnchor.generation);
          expect(historyReads).toHaveBeenCalled();
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
  }));

it("slides durable context within its bounds and reloads only when an admission outlives resident coverage", () =>
  withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const fixture = createSessionCompoundWorkerFixture();
    const scope = { ...fixture.scope, env };
    const limits = { maxBytes: 4096, maxEvents: 3 };
    const header = { type: "session", id: scope.sessionId, version: 3, cwd: "/synthetic" };
    const events = [
      header,
      ...Array.from({ length: 5 }, (_, index) =>
        messageEvent(`old-${index}`, index === 0 ? null : `old-${index - 1}`, {
          role: index % 2 === 0 ? "assistant" : "user",
          content: `Old message ${index}`,
        }),
      ),
    ];
    await replaceTranscriptEvents(scope, events);
    const { actor, database } = await acquireActor(fixture, env);
    const historyReads = vi.spyOn(historyLane.pool, "run");
    try {
      await actor.read(authority);
      await withOwnedSessionTranscriptWrites(
        {
          sessionTarget: scope,
          sessionActor: { actor, database },
          withTranscriptWrite: async (write) => write(),
        },
        async () => {
          const append = async (id: string, role: "user" | "assistant", content: string) => {
            const result = await appendMessage(actor, scope, id, { role, content }, 10);
            assert(result.kind === "committed", "Expected a committed transcript append");
            const anchor = result.receipt.transcript.appendedMessages.find(
              (message) => message.messageId === id,
            )?.anchor;
            assert(anchor, "Expected the committed message anchor");
            return anchor;
          };
          const admit = async (
            id: string,
            content: string,
          ): Promise<UserTurnTranscriptAdmissionReceipt> => ({
            ...(await append(id, "user", content)),
            logicalTurnId: id,
            role: "user",
          });
          const read = async (admission?: UserTurnTranscriptAdmissionReceipt) => {
            const actual = await runWithSessionTranscriptReadFence(admission, () =>
              prepareSessionTranscriptHydration(scope, limits).read(),
            );
            expect(actual.kind).toBe("bounded");
            expect(actual.snapshot).toEqual(
              runWithSessionTranscriptReadFence(admission, () =>
                readSessionTranscriptBoundedActiveContextCore(scope, limits),
              ),
            );
            return actual.snapshot;
          };

          // The cold fence excludes the input, but its total already includes that committed row.
          const first = await admit("first-input", "First input");
          historyReads.mockClear();
          const cold = await read(first);
          expect(cold).toMatchObject({
            events: [header, ...events.slice(3)],
            totalEvents: 6,
            activeLeafEntryId: "old-4",
            truncated: true,
          });
          expect(historyReads).toHaveBeenCalled();
          await append("first-reply", "assistant", "First reply");
          const second = await admit("second-input", "Second input");
          await capturePersistedModelPromptProjection({
            admission: second,
            message: { role: "user", content: "Second input", timestamp: 10 },
            text: "Second input",
            assertCurrent() {},
            assertWritable() {},
            onCommitted() {},
          });
          historyReads.mockClear();
          const fenced = await read(second);
          expect(fenced).toMatchObject({
            events: [
              header,
              expect.objectContaining({ id: "old-4" }),
              expect.objectContaining({ id: "first-input" }),
              expect.objectContaining({ id: "first-reply" }),
            ],
            totalEvents: 8,
            activeLeafEntryId: "first-reply",
          });
          expect(fenced).toHaveProperty(
            "parents",
            new Map([
              ["old-4", "old-3"],
              ["first-input", "old-4"],
              ["first-reply", "first-input"],
            ]),
          );
          const current = await read();
          expect(current).toMatchObject({
            events: [
              header,
              expect.objectContaining({ id: "first-input" }),
              expect.objectContaining({ id: "first-reply" }),
              expect.objectContaining({
                id: "second-input",
                message: expect.objectContaining({
                  __openclaw: { modelPromptProjection: { version: 1, text: "Second input" } },
                }),
              }),
            ],
            totalEvents: 8,
          });
          expect(historyReads).not.toHaveBeenCalled();

          // An input larger than the read limit must not displace its pre-input history.
          const oversized = await admit("oversized-input", "x".repeat(8192));
          historyReads.mockClear();
          expect(await read(oversized)).toMatchObject({ events: current.events, totalEvents: 9 });
          expect(await read()).toMatchObject({ events: [header], totalEvents: 9, truncated: true });
          expect(historyReads).not.toHaveBeenCalled();
          await append("after-oversized", "assistant", "Visible reply after large input");

          // A still larger input exceeds resident slack; its old fence needs canonical storage.
          const evicted = await admit("evicting-input", "y".repeat(600 * 1024));
          historyReads.mockClear();
          expect(await read()).toMatchObject({
            events: [header],
            totalEvents: 11,
            truncated: true,
          });
          expect(historyReads).not.toHaveBeenCalled();
          expect(await read(evicted)).toMatchObject({
            events: [header, expect.objectContaining({ id: "after-oversized" })],
            totalEvents: 11,
            activeLeafEntryId: "after-oversized",
          });
          expect(historyReads).toHaveBeenCalled();
        },
      );
    } finally {
      historyReads.mockRestore();
      await actor.release();
    }
  }));
