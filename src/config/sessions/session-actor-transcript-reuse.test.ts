import { assert, expect, it, vi } from "vitest";
import { readSessionTranscriptAccountingAsync } from "../../gateway/session-transcript-readers.js";
import type { UserTurnTranscriptAdmissionReceipt } from "../../sessions/user-turn-transcript.types.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { readSessionTranscriptBoundedActiveContextCore } from "./session-accessor.sqlite-active-context.js";
import { replaceTranscriptEvents } from "./session-accessor.sqlite-transcript-write.test-support.js";
import type { SessionActorAuthority } from "./session-actor-contract.js";
import { createSessionActorFactory } from "./session-actor-durable.js";
import { transcriptTurnCommand } from "./session-actor-transcript.test-support.js";
import { createSessionCompoundWorkerFixture } from "./session-compound-worker.test-support.js";
import { readSessionTranscriptAnchorsAsync } from "./session-transcript-anchor-read.js";
import { prepareSessionTranscriptHydration } from "./session-transcript-hydration.js";
import { runWithSessionTranscriptReadFence } from "./session-transcript-read-fence.js";
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
const header = (id: string) => ({ type: "session", id, version: 3, cwd: "/synthetic" });
const eventWithId = (id: string) => expect.objectContaining({ id });

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

it("slides durable context, anchors and accounting within resident bounds and reloads evicted admissions", () =>
  withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const fixture = createSessionCompoundWorkerFixture();
    const scope = { ...fixture.scope, env };
    const limits = { maxBytes: 4096, maxEvents: 3 };
    const sessionHeader = header(scope.sessionId);
    const events = [
      sessionHeader,
      ...Array.from({ length: 5 }, (_, index) =>
        messageEvent(`old-${index}`, index === 0 ? null : `old-${index - 1}`, {
          role: index % 2 === 0 ? "assistant" : "user",
          content: `Old message ${index}`,
          ...(index === 4 ? { usage: { input: 200, output: 7 } } : {}),
        }),
      ),
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
            const result = await actor.appendToolResult(
              transcriptTurnCommand(scope, id, [
                { eventId: id, message: { role, content }, now: 10 },
              ]),
              authority,
            );
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
            events: [sessionHeader, ...events.slice(3)],
            totalEvents: 6,
            activeLeafEntryId: "old-4",
            truncated: true,
          });
          expect(historyReads).toHaveBeenCalled();
          const hydration = prepareSessionTranscriptHydration(scope, {
            maxBytes: 1024 * 1024,
            maxEvents: 100,
          });
          assert(hydration.readCohort, "Expected bounded transcript cohort reader");
          await hydration.readCohort(
            { sessionKey: scope.sessionKey, entryIds: ["old-4"] },
            (prepared) => {
              expect(prepared.transcript?.anchors.map((anchor) => anchor.entryId)).toEqual([
                "old-4",
              ]);
            },
          );
          const readAnchors = (entryIds: string[]) =>
            readSessionTranscriptAnchorsAsync(scope, { entryIds });
          clearReads();
          expect((await readAnchors(["old-4"])).anchors.map((anchor) => anchor.entryId)).toEqual([
            "old-4",
          ]);
          expectResident();
          expect((await readAnchors(["old-0"])).anchors.map((anchor) => anchor.entryId)).toEqual([
            "old-0",
          ]);
          expect(historyReads).toHaveBeenCalled();
          clearReads();
          const accountingOptions = {
            includeByteSize: true,
            includeUsage: true,
            includeTurnTaint: true,
          };
          const readAccounting = () =>
            readSessionTranscriptAccountingAsync(scope, accountingOptions);
          const accounting = await readAccounting();
          expect(accounting.usage).toMatchObject({
            promptTokens: 200,
            outputTokens: 7,
            trailingMessages: [{ role: "user", content: "First input" }],
          });
          const expectedUsage = structuredClone(accounting.usage);
          const trailing = accounting.usage?.trailingMessages[0];
          if (trailing?.role === "user") {
            trailing.content = "caller-owned copy";
          }
          expect((await readAccounting()).usage).toEqual(expectedUsage);
          expect(
            await readSessionTranscriptAccountingAsync(scope, {
              ...accountingOptions,
              includeByteSize: false,
              usageEventLimit: 0,
            }),
          ).toEqual({ usage: undefined, turnTainted: false });
          expectResident();
          const replyAnchor = await append("first-reply", "assistant", "First reply");
          clearReads();
          expect((await readAnchors(["first-reply"])).anchors).toContainEqual(replyAnchor);
          expectResident();
          const current = await read();

          // An input larger than the read limit must not displace its pre-input history.
          const oversized = await admit("oversized-input", "x".repeat(8192));
          historyReads.mockClear();
          expect(await read(oversized)).toMatchObject({ events: current.events, totalEvents: 8 });
          expect(await read()).toMatchObject({
            events: [sessionHeader],
            totalEvents: 8,
            truncated: true,
          });
          expect(historyReads).not.toHaveBeenCalled();
          await append("after-oversized", "assistant", "Visible reply after large input");

          // A still larger input exceeds resident slack; its old fence needs canonical storage.
          const evicted = await admit("evicting-input", "y".repeat(600 * 1024));
          historyReads.mockClear();
          expect(await read()).toMatchObject({
            events: [sessionHeader],
            totalEvents: 10,
            truncated: true,
          });
          expect(historyReads).not.toHaveBeenCalled();
          expect(await read(evicted)).toMatchObject({
            events: [sessionHeader, eventWithId("after-oversized")],
            totalEvents: 10,
            activeLeafEntryId: "after-oversized",
          });
          expect(historyReads).toHaveBeenCalled();
        },
      );
    } finally {
      historyReads.mockRestore();
      discoveryReads.mockRestore();
      await actor.release();
    }
  }));
