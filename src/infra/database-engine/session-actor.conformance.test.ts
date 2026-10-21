import assert from "node:assert/strict";
import { describe, expect, it } from "vitest";
import { appendSessionManagerActor } from "../../agents/sessions/session-manager-actor-append.js";
import {
  appendTranscriptEvent,
  appendTranscriptMessage,
  replaceSessionEntry,
  waitForSessionTranscriptProjection,
} from "../../config/sessions/session-accessor.js";
import { readTranscriptEventRows } from "../../config/sessions/session-accessor.sqlite-read.js";
import type { SessionActorAuthority } from "../../config/sessions/session-actor-contract.js";
import { createSessionActorFactory } from "../../config/sessions/session-actor-durable.js";
import { collectSessionAdmissionReferences } from "../../config/sessions/session-history-eviction-candidates.js";
import { readSessionTranscriptAnchorsAsync } from "../../config/sessions/session-transcript-anchor-read.js";
import { createReadonlySessionHistoryReader } from "../../gateway/session-history-readonly-reader.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import { closeOpenClawAgentDatabases } from "../../state/openclaw-agent-db-lifecycle.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { withEngineStoreAdmission } from "./admission-scope.js";
import {
  mixedAgentConnection,
  mixedAgentPairs,
  useMixedAgentPair,
} from "./mixed-agent.conformance.test-support.js";

const authority: SessionActorAuthority = { assertCurrent() {}, authorize() {} };
const revokeAtCommit = (message: string): SessionActorAuthority => ({
  assertCurrent() {},
  authorize(stage) {
    if (stage === "commit") {
      throw new Error(message);
    }
  },
});
const openMainDatabase = () =>
  withEngineStoreAdmission(() => openOpenClawAgentDatabase({ agentId: "main" }));

describe
  .skipIf(!mixedAgentConnection)
  .each(mixedAgentPairs.filter(({ stateEngine, agentEngine }) => stateEngine === agentEngine))(
  "$agentEngine durable session actor",
  ({ stateEngine, agentEngine }) => {
    const pair = useMixedAgentPair(stateEngine, agentEngine);

    it("protects admitted session keys and their previous generations during reclamation", async () => {
      const database = openMainDatabase();
      const scope = {
        agentId: "main",
        sessionKey: "agent:main:admitted-é",
        storePath: database.path,
      };
      await replaceSessionEntry(scope, { sessionId: "admitted-old", updatedAt: 1 });
      await replaceSessionEntry(scope, { sessionId: "admitted-current", updatedAt: 2 });
      await replaceSessionEntry(
        { ...scope, sessionKey: "agent:main:unrelated" },
        { sessionId: "unrelated", updatedAt: 3 },
      );
      const protectedIds = withEngineStoreAdmission(() =>
        collectSessionAdmissionReferences({
          database,
          admissionIdentities: [scope.sessionKey, "admitted-by-id"],
        }),
      );
      expect(protectedIds).toEqual(
        new Set([scope.sessionKey, "admitted-by-id", "admitted-old", "admitted-current"]),
      );
    });

    it("reads cold compacted history and retains exact run visibility across a reset", async () => {
      const database = openMainDatabase();
      const scope = {
        agentId: "main",
        sessionKey: "agent:main:cold-history",
        sessionId: "cold-history",
        storePath: database.path,
      };
      const input: Array<[string, string, string, Record<string, unknown>]> = [
        [
          "hidden-input",
          "user",
          "Internal checkpoint",
          {
            idempotencyKey: "worker-run:user",
            provenance: {
              kind: "inter_session",
              sourceTool: "sessions_send",
              sourceRole: "subagent",
            },
          },
        ],
        ["hidden-answer", "assistant", "Internal answer", { __openclaw: { runId: "worker-run" } }],
        ["other-steer", "user", "Another run", { __openclaw: { steerTargetRunId: "other-run" } }],
        ["still-hidden", "assistant", "Still internal", { __openclaw: { runId: "worker-run" } }],
        [
          "human-steer",
          "user",
          "Show progress",
          { __openclaw: { steerTargetRunId: "worker-run" } },
        ],
        [
          "visible-answer",
          "assistant",
          "Visible progress",
          { __openclaw: { runId: "worker-run" } },
        ],
      ];
      await replaceSessionEntry(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      await appendTranscriptEvent(scope, { type: "session", version: 3, id: scope.sessionId });
      for (const [index, [eventId, role, content, extra]] of input.entries()) {
        await appendTranscriptMessage(scope, {
          eventId,
          parentId: input[index - 1]?.[0] ?? null,
          message: { role, content, ...extra },
        });
      }
      for (const type of ["compaction", "reset"] as const) {
        expect(
          await appendTranscriptEvent(scope, {
            type,
            id: type,
            parentId: type === "compaction" ? "visible-answer" : "compaction",
            timestamp: new Date(2).toISOString(),
            firstKeptEntryId: "hidden-input",
            ...(type === "compaction"
              ? { summary: "Compacted checkpoint", tokensBefore: 100 }
              : { reason: "new" }),
          }),
        ).toBe(true);
        await waitForSessionTranscriptProjection(scope);
        withEngineStoreAdmission(() => closeOpenClawAgentDatabases(pair.root));
        await cleanupSessionStateForTest({ stateDir: pair.root });
        withEngineStoreAdmission(() => {
          openOpenClawAgentDatabase({ agentId: "main" });
          const reader = createReadonlySessionHistoryReader({
            transcript: { ...scope, sessionFile: scope.sessionKey },
            database: { agentId: scope.agentId, path: scope.storePath },
            entryValidationKey: scope.sessionKey,
          });
          const page = reader.readHistoryEventPage({ maxMessages: 20, offset: 0 });
          expect(page.events.map(({ event }) => event)).toEqual(
            [...input.map(([id]) => id), type].map((id) => expect.objectContaining({ id })),
          );
          const visibility = reader.subagentCoordination;
          expect(visibility.isSubagentRunMessage("worker-run", 2)).toBe(true);
          expect(visibility.isSubagentRunMessage("worker-run", 4)).toBe(true);
          expect(visibility.isSubagentRunMessage("worker-run", 6)).toBe(false);
          expect(visibility.isSubagentRunMessage("missing-run", 6)).toBe(false);
        });
      }
    });

    it("commits transcript appends and metadata pairs, rolls back refused writes, and reopens", async () => {
      const options = { agentId: "main", env: process.env };
      const sessionKey = "agent:main:actor-conformance";
      const sessionId = "actor-conformance";
      const readRows = () =>
        withEngineStoreAdmission(() =>
          readTranscriptEventRows(openOpenClawAgentDatabase(options), sessionId),
        );
      const acquire = async () => {
        const database = withEngineStoreAdmission(() => openOpenClawAgentDatabase(options));
        const identity = readOpenClawAgentDatabaseIdentity(database);
        assert(typeof identity.identity === "string");
        const actor = await createSessionActorFactory({
          ...options,
          path: database.path,
        }).acquire(
          {
            sessionKey,
            database: {
              kind: "file",
              physicalIdentity: identity.identity,
              birthtime: identity.birthtime,
              nativeLocation: database.path,
            },
          },
          { assertCurrent() {}, assertReadable() {} },
        );
        const scope = { ...options, storePath: database.path, sessionKey, sessionId };
        const append = (input: Parameters<typeof appendSessionManagerActor>[0]["append"]) =>
          appendSessionManagerActor({
            actor,
            toolResult: false,
            assertCurrent() {},
            append: input,
          });
        return {
          actor,
          scope,
          append: (content: string, initialize = false) =>
            append({
              kind: "message",
              input: {
                scope,
                cwd: "/synthetic",
                messageJson: JSON.stringify({ role: "user", content, timestamp: 2 }),
              },
              ...(initialize
                ? { initialization: { scope, entry: { sessionId, updatedAt: 2 } } }
                : {}),
            }),
          appendInitialMetadata: (modelId: string) =>
            append({
              kind: "metadata",
              input: {
                scope,
                initialModel: {
                  type: "model_change",
                  id: modelId,
                  parentId: null,
                  timestamp: "1970-01-01T00:00:00.003Z",
                  provider: "synthetic",
                  modelId: "synthetic-model",
                },
                event: JSON.stringify({
                  type: "thinking_level_change",
                  id: "initial-thinking",
                  parentId: modelId,
                  timestamp: "1970-01-01T00:00:00.003Z",
                  thinkingLevel: "high",
                }),
                options: { appendIntent: "active-branch" },
              },
            }),
        };
      };
      const first = await acquire();
      try {
        const appended = await first.append("first input", true);
        expect(appended.failure).toBeUndefined();
        expect(appended).toMatchObject({
          committed: { kind: "message", value: { snapshot: { ok: true } } },
        });
        const initial = first.actor.snapshot(authority);
        assert(initial);
        expect(initial.entry?.sessionId).toBe(sessionId);
        const patched = await first.actor.patch(
          { commandId: "warm", phaseId: "turn", reducers: [{ kind: "activity", updatedAt: 543 }] },
          authority,
        );
        expect(patched).toMatchObject({
          kind: "committed",
          receipt: { beforeVersion: initial.version },
        });
        const beforeRefusal = first.actor.snapshot(authority);
        assert(beforeRefusal);
        expect(beforeRefusal.entry?.updatedAt).toBe(543);
        expect(
          await first.actor.patch(
            {
              commandId: "refused",
              phaseId: "turn",
              reducers: [{ kind: "activity", updatedAt: 999 }],
            },
            revokeAtCommit("synthetic live authority revocation"),
          ),
        ).toMatchObject({
          kind: "rolled-back",
          error: { message: "synthetic live authority revocation" },
        });
        const afterRefusal = await first.actor.read(authority);
        expect(afterRefusal.entry?.updatedAt).toBe(543);
        // Both engines invalidate attempted-write witnesses, even when the data rolls back.
        expect(afterRefusal.writeToken).not.toBe(beforeRefusal.writeToken);
        expect(afterRefusal.version).not.toEqual(beforeRefusal.version);

        assert(appended.committed.kind === "message");
        assert(appended.committed.value.snapshot.ok);
        const firstMessageId = appended.committed.value.snapshot.value.result?.messageId;
        assert(firstMessageId);
        const metadata = await first.appendInitialMetadata("initial-model");
        expect(metadata.failure).toBeUndefined();
        expect(metadata.committed).toMatchObject({
          kind: "metadata",
          value: {
            initialModelParentId: firstMessageId,
            snapshot: {
              ok: true,
              value: {
                before: afterRefusal.transcript.version,
                result: { appended: true, effectiveParentId: "initial-model" },
              },
            },
          },
        });
        const rowsBeforePartialPair = readRows();
        expect(rowsBeforePartialPair.slice(-2).map((row) => JSON.parse(row.eventJson))).toEqual([
          {
            type: "model_change",
            id: "initial-model",
            parentId: firstMessageId,
            timestamp: "1970-01-01T00:00:00.003Z",
            provider: "synthetic",
            modelId: "synthetic-model",
          },
          {
            type: "thinking_level_change",
            id: "initial-thinking",
            parentId: "initial-model",
            timestamp: "1970-01-01T00:00:00.003Z",
            thinkingLevel: "high",
          },
        ]);
        const beforePartialPair = first.actor.snapshot(authority);
        assert(beforePartialPair);
        await expect(first.appendInitialMetadata("refused-model")).rejects.toThrow(
          "Initial thinking metadata was not persisted: transcript-event-not-appended",
        );
        expect(readRows()).toEqual(rowsBeforePartialPair);
        const afterPartialPair = await first.actor.read(authority);
        expect(afterPartialPair.entry).toEqual(beforePartialPair.entry);
        expect(afterPartialPair.transcript.watermark).toEqual(
          beforePartialPair.transcript.watermark,
        );
        expect(afterPartialPair.pendingInputs).toEqual(beforePartialPair.pendingInputs);

        const anchor = (
          await readSessionTranscriptAnchorsAsync(first.scope, { entryIds: [firstMessageId] })
        ).anchors[0];
        assert(anchor);
        const appendProjection = (text: string, liveAuthority = authority) =>
          first.actor.appendTranscriptEvent(
            {
              commandId: "prompt-carrier",
              phaseId: "turn",
              append: {
                kind: "metadata",
                modelPromptProjection: { anchor, text },
                input: {
                  scope: first.scope,
                  event: JSON.stringify({
                    type: "custom_message",
                    id: "runtime-context",
                    parentId: "initial-thinking",
                    timestamp: "1970-01-01T00:00:00.004Z",
                    customType: "openclaw.runtime-context",
                    content: "Synthetic runtime context",
                    display: false,
                    details: { source: "openclaw-runtime-context", runtimeContextCarrier: true },
                  }),
                  options: { appendIntent: "active-branch" },
                },
              },
            },
            liveAuthority,
          );
        expect(
          await appendProjection(
            "Refused prompt",
            revokeAtCommit("synthetic fused authority revocation"),
          ),
        ).toMatchObject({
          kind: "rolled-back",
          error: { message: "synthetic fused authority revocation" },
        });
        expect(readRows()).toEqual(rowsBeforePartialPair);
        const beforeFusion = await first.actor.read(authority);
        expect(beforeFusion.transcript.version).toEqual(afterPartialPair.transcript.version);
        const fused = await appendProjection("Final transformed input");
        assert(fused.kind === "committed");
        expect(fused.failure).toBeUndefined();
        const transcript = fused.receipt.transcript;
        expect(transcript.before).toEqual(beforeFusion.transcript.version);
        expect(transcript.after.rawSeq).toBe((transcript.before.rawSeq ?? -1) + 1);
        expect(transcript.after.generation).not.toBe(transcript.before.generation);
        expect(transcript.append?.modelPromptProjection?.result.message).toMatchObject({
          role: "user",
          content: "first input",
          __openclaw: { modelPromptProjection: { version: 1, text: "Final transformed input" } },
        });
        expect(transcript.appendedEvents?.map(({ event }) => event)).toMatchObject([
          { id: "runtime-context", parentId: "initial-thinking" },
        ]);
        const finalAuthority = transcript.authorityReceipts?.[0]?.facts.get(sessionKey);
        expect(finalAuthority).toMatchObject({
          kind: "postimage",
          value: { ...transcript.after, leafEventId: "runtime-context" },
        });
        expect(first.actor.snapshot(authority)?.transcript.version).toEqual(transcript.after);
      } finally {
        await first.actor.release();
      }
      withEngineStoreAdmission(() => closeOpenClawAgentDatabases(pair.root));
      await cleanupSessionStateForTest({ stateDir: pair.root });

      const reopened = await acquire();
      try {
        expect((await reopened.actor.read(authority)).entry?.updatedAt).toBe(543);
        expect((await reopened.append("continued input")).failure).toBeUndefined();
        expect(readRows().map((row) => JSON.parse(row.eventJson))).toMatchObject([
          { type: "session", id: sessionId },
          {
            type: "message",
            message: {
              role: "user",
              content: "first input",
              __openclaw: {
                modelPromptProjection: { version: 1, text: "Final transformed input" },
              },
            },
          },
          { type: "model_change", id: "initial-model" },
          { type: "thinking_level_change", id: "initial-thinking", parentId: "initial-model" },
          { type: "custom_message", id: "runtime-context", parentId: "initial-thinking" },
          {
            type: "message",
            parentId: "runtime-context",
            message: { role: "user", content: "continued input" },
          },
        ]);
      } finally {
        await reopened.actor.release();
      }
    });
  },
);
