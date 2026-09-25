import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { HEARTBEAT_PROMPT } from "../../auto-reply/heartbeat.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import {
  appendTranscriptEvent,
  appendTranscriptMessage,
  deleteSessionEntryLifecycle,
  forkSessionEntryFromParentTarget,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { TASK_ARCHIVE_RECORD_CAPACITY_ERROR } from "../../config/sessions/session-accessor.sqlite-archive-stream.js";
import * as sessionHistory from "../../config/sessions/session-history.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { recordGatewaySessionRunFailure } from "../../sessions/session-run-error.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { markTaskTerminalById } from "../../tasks/runtime-internal.js";
import { createTaskFixture } from "../../tasks/task-registry.test-support.js";
import { createHistoryReadContext } from "./chat-history.test-helpers.js";
import { withHistoryState } from "./task-history.test-support.js";
import { identifiedClient, runTaskHandler } from "./tasks.test-helpers.js";
const requesterSessionKey = "agent:main:dashboard:task-parent";
describe("archived tasks.history", () => {
  it("preserves heartbeat boundaries across bounded hidden and recovered context", async () => {
    await withHistoryState(async () => {
      const context = await createHistoryReadContext();
      for (const variant of ["pair", "hidden-gap", "recovered-error"] as const) {
        const scope = {
          agentId: "main",
          sessionKey: `agent:main:subagent:heartbeat-${variant}`,
          sessionId: `heartbeat-${variant}`,
        };
        const runId = `heartbeat-${variant}-run`;
        await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
        const hidden =
          variant === "pair"
            ? []
            : Array.from({ length: 4 }, () => ({
                role: "assistant",
                content: "Hidden heartbeat activity",
                display: false,
              }));
        const failure =
          variant === "recovered-error"
            ? [
                {
                  role: "assistant",
                  content: [],
                  stopReason: "error",
                  errorMessage: "Synthetic recovered heartbeat failure",
                  __openclaw: { runId },
                },
              ]
            : [];
        for (const [index, message] of [
          { role: "user", content: HEARTBEAT_PROMPT },
          { role: "assistant", content: "HEARTBEAT_OK" },
          ...hidden,
          ...failure,
          {
            role: "assistant",
            content: "Synthetic heartbeat alert",
            stopReason: "stop",
            __openclaw: { runId },
          },
        ].entries()) {
          await appendTranscriptMessage(scope, { eventId: `${variant}-${index}`, message });
        }
        const task = createTaskFixture("subagent", {
          requesterSessionKey,
          ownerKey: requesterSessionKey,
          childSessionKey: scope.sessionKey,
          agentId: "main",
          runId,
          task: "Inspect synthetic heartbeat history",
        });
        markTaskTerminalById({ taskId: task.taskId, status: "succeeded", endedAt: 2 });
        const expected = [
          { content: "Synthetic heartbeat alert", __openclaw: { turnBoundary: true } },
        ];
        const live = await runTaskHandler(
          "tasks.history",
          { taskId: task.taskId },
          {},
          null,
          context,
        );
        expect(live.payload?.messages).toMatchObject(expected);
        await deleteSessionEntryLifecycle({
          agentId: "main",
          storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
          target: { canonicalKey: scope.sessionKey, storeKeys: [scope.sessionKey] },
          archiveTranscript: true,
          expectedSessionId: scope.sessionId,
        });
        const latest = await runTaskHandler(
          "tasks.history",
          { taskId: task.taskId, limit: 1 },
          {},
          null,
          context,
        );
        expect(latest.calls[0]?.[0]).toBe(true);
        expect.soft(latest.payload?.messages, variant).toMatchObject(expected);
        if (variant === "recovered-error") {
          const older = await runTaskHandler(
            "tasks.history",
            {
              taskId: task.taskId,
              limit: 1,
              cursor: expectDefined(latest.payload?.nextCursor, "Expected the older error page"),
            },
            {},
            null,
            context,
          );
          expect(older.calls[0]?.[0]).toBe(true);
          expect(older.payload?.messages).toEqual([]);
        }
      }
    });
  });

  it("drops inherited announce pairs after a real child fork and cleanup", async () => {
    await withHistoryState(async () => {
      const storePath = resolveSessionStorePathCore(undefined, { agentId: "main" });
      const parent = {
        agentId: "main",
        sessionKey: requesterSessionKey,
        sessionId: "announce-parent",
        storePath,
      };
      const childKey = "agent:main:subagent:announce-child";
      const runId = "announce-child-run";
      await upsertSessionEntryCore(parent, { sessionId: parent.sessionId, updatedAt: 1 });
      for (const [index, message] of [
        {
          role: "user",
          content: "Earlier synthetic child finished",
          provenance: { kind: "inter_session", sourceTool: "subagent_announce" },
        },
        { role: "assistant", content: "Stale inherited acknowledgement" },
      ].entries()) {
        await appendTranscriptMessage(parent, {
          eventId: `old-announce-${index}`,
          now: 1_000 + index,
          message,
        });
      }
      const fork = await forkSessionEntryFromParentTarget({
        agentId: "main",
        storePath,
        parentTarget: { canonicalKey: parent.sessionKey, storeKeys: [parent.sessionKey] },
        sessionTarget: { canonicalKey: childKey, storeKeys: [childKey] },
        fallbackEntry: { sessionId: "pending-announce-child", updatedAt: 1 },
      });
      expect(fork.status).toBe("forked");
      if (fork.status !== "forked") {
        throw new Error("Synthetic child did not fork");
      }
      const scope = {
        agentId: "main",
        sessionKey: childKey,
        sessionId: fork.sessionEntry.sessionId,
        storePath,
      };
      for (const [index, message] of [
        {
          role: "user",
          content: "Current synthetic child finished",
          provenance: { kind: "inter_session", sourceTool: "subagent_announce" },
        },
        { role: "assistant", content: "Current acknowledgement", __openclaw: { runId } },
      ].entries()) {
        await appendTranscriptMessage(scope, { eventId: `current-announce-${index}`, message });
      }
      const task = createTaskFixture("subagent", {
        requesterSessionKey,
        ownerKey: requesterSessionKey,
        childSessionKey: childKey,
        agentId: "main",
        runId,
        task: "Inspect synthetic fork history",
      });
      markTaskTerminalById({ taskId: task.taskId, status: "succeeded", endedAt: 2 });
      const context = await createHistoryReadContext();
      const live = await runTaskHandler(
        "tasks.history",
        { taskId: task.taskId },
        {},
        null,
        context,
      );
      expect(live.payload?.messages).toMatchObject([{ content: "Current acknowledgement" }]);
      await deleteSessionEntryLifecycle({
        agentId: "main",
        storePath,
        target: { canonicalKey: childKey, storeKeys: [childKey] },
        archiveTranscript: true,
        expectedSessionId: scope.sessionId,
      });
      const archived = await runTaskHandler(
        "tasks.history",
        { taskId: task.taskId },
        {},
        null,
        context,
      );
      expect(archived.calls[0]?.[0]).toBe(true);
      expect(archived.payload?.messages).toMatchObject([{ content: "Current acknowledgement" }]);
    });
  });

  it("keeps coordination outputs hidden across archived pages until human steering", async () => {
    await withHistoryState(async () => {
      const scope = {
        agentId: "main",
        sessionKey: "agent:main:subagent:coordination-history",
        sessionId: "coordination-history",
      };
      const runId = "coordination-history-run";
      await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      for (const [index, message] of [
        {
          role: "user",
          content: "Synthetic internal handoff",
          idempotencyKey: `${runId}:user`,
          provenance: {
            kind: "inter_session",
            sourceTool: "sessions_send",
            sourceSessionKey: "agent:main:subagent:coordination-sender",
          },
        },
        { role: "assistant", content: "Synthetic internal acknowledgement", __openclaw: { runId } },
        {
          role: "user",
          content: "Now show the report",
          __openclaw: { steerTargetRunId: runId },
        },
        { role: "assistant", content: "Visible report", __openclaw: { runId } },
        {
          role: "user",
          content: "Synthetic follow-up handoff",
          idempotencyKey: "coordination-followup:user",
          __openclaw: { steerTargetRunId: runId },
          provenance: {
            kind: "inter_session",
            sourceTool: "sessions_send",
            sourceRole: "subagent",
          },
        },
        { role: "assistant", content: "Updated report", __openclaw: { runId } },
      ].entries()) {
        await appendTranscriptMessage(scope, { eventId: `coordination-${index}`, message });
      }
      const task = createTaskFixture("subagent", {
        requesterSessionKey,
        ownerKey: requesterSessionKey,
        childSessionKey: scope.sessionKey,
        agentId: "main",
        runId,
        task: "Inspect synthetic coordination history",
      });
      markTaskTerminalById({ taskId: task.taskId, status: "succeeded", endedAt: 2 });
      const context = await createHistoryReadContext();
      const live = await runTaskHandler(
        "tasks.history",
        { taskId: task.taskId },
        {},
        null,
        context,
      );
      expect(live.payload?.messages).toMatchObject([
        { content: "Now show the report" },
        { content: "Visible report" },
        { content: "Updated report" },
      ]);
      await deleteSessionEntryLifecycle({
        agentId: "main",
        storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
        target: { canonicalKey: scope.sessionKey, storeKeys: [scope.sessionKey] },
        archiveTranscript: true,
        expectedSessionId: scope.sessionId,
      });
      const latest = await runTaskHandler(
        "tasks.history",
        { taskId: task.taskId, limit: 2 },
        {},
        null,
        context,
      );
      expect(latest.calls[0]?.[0]).toBe(true);
      expect(latest.payload?.messages).toMatchObject([{ content: "Updated report" }]);
      let cursor: string | undefined;
      for (const expected of [
        [{ content: "Updated report" }],
        [],
        [{ content: "Visible report" }],
        [{ content: "Now show the report" }],
        [],
        [],
      ]) {
        const page = await runTaskHandler(
          "tasks.history",
          { taskId: task.taskId, limit: 1, ...(cursor ? { cursor } : {}) },
          {},
          null,
          context,
        );
        expect(page.calls[0]?.[0]).toBe(true);
        expect(page.payload?.messages).toMatchObject(expected);
        cursor = page.payload?.nextCursor;
      }
      expect(cursor).toBeUndefined();
    });
  });

  it("reads a failed run receipt after cleanup before any assistant reply", async () => {
    await withHistoryState(async () => {
      const scope = {
        agentId: "main",
        sessionKey: "agent:main:subagent:failed-before-reply",
        sessionId: "failed-before-reply",
        storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
      };
      const runId = "failed-before-reply-run";
      await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      await appendTranscriptMessage(scope, {
        eventId: "failed-request",
        message: { role: "user", content: "Inspect the synthetic report" },
      });
      await recordGatewaySessionRunFailure({
        target: scope,
        runId,
        error: "Synthetic pre-reply failure",
      });
      const task = createTaskFixture("subagent", {
        requesterSessionKey,
        ownerKey: requesterSessionKey,
        childSessionKey: scope.sessionKey,
        agentId: "main",
        runId,
        task: "Inspect synthetic report",
      });
      markTaskTerminalById({ taskId: task.taskId, status: "failed", endedAt: 2 });
      await deleteSessionEntryLifecycle({
        agentId: "main",
        storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
        target: { canonicalKey: scope.sessionKey, storeKeys: [scope.sessionKey] },
        archiveTranscript: true,
        expectedSessionId: scope.sessionId,
      });
      const result = await runTaskHandler(
        "tasks.history",
        { taskId: task.taskId },
        {},
        null,
        await createHistoryReadContext(),
      );
      expect(result.calls[0]?.[0]).toBe(true);
      expect(result.payload?.messages).toMatchObject([
        { role: "user", content: "Inspect the synthetic report" },
        {
          role: "custom",
          customType: "run-failed-before-reply",
          content: "This turn ended before a reply: Synthetic pre-reply failure",
          __openclaw: { runId },
        },
      ]);
      expect(result.payload?.messages?.[1]).not.toHaveProperty("details");
    });
  });

  it("keeps recovered errors hidden across archived page boundaries", async () => {
    await withHistoryState(async () => {
      const scope = {
        agentId: "main",
        sessionKey: "agent:main:subagent:recovered",
        sessionId: "recovered",
      };
      const runId = "recovered-run";
      await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      for (const [index, message] of [
        { role: "user", content: "Inspect the synthetic report" },
        {
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage: "Synthetic provider failure",
          __openclaw: { runId },
        },
        {
          role: "assistant",
          content: "Recovered answer",
          stopReason: "stop",
          __openclaw: { runId },
        },
      ].entries()) {
        await appendTranscriptMessage(scope, { eventId: `recovery-${index}`, message });
      }
      const task = createTaskFixture("subagent", {
        requesterSessionKey,
        ownerKey: requesterSessionKey,
        childSessionKey: scope.sessionKey,
        agentId: "main",
        runId,
        task: "Inspect synthetic report",
      });
      markTaskTerminalById({ taskId: task.taskId, status: "succeeded", endedAt: 2 });
      await deleteSessionEntryLifecycle({
        agentId: "main",
        storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
        target: { canonicalKey: scope.sessionKey, storeKeys: [scope.sessionKey] },
        archiveTranscript: true,
        expectedSessionId: scope.sessionId,
      });
      const context = await createHistoryReadContext();
      const latest = await runTaskHandler(
        "tasks.history",
        { taskId: task.taskId, limit: 1 },
        {},
        null,
        context,
      );
      expect(latest.payload?.messages).toMatchObject([{ content: "Recovered answer" }]);
      const older = await runTaskHandler(
        "tasks.history",
        {
          taskId: task.taskId,
          limit: 1,
          cursor: expectDefined(latest.payload?.nextCursor, "recovered task cursor"),
        },
        {},
        null,
        context,
      );
      expect(older.calls[0]?.[0]).toBe(true);
      expect(older.payload?.messages).toEqual([]);
      const first = await runTaskHandler(
        "tasks.history",
        {
          taskId: task.taskId,
          limit: 1,
          cursor: expectDefined(older.payload?.nextCursor, "older request cursor"),
        },
        {},
        null,
        context,
      );
      expect(first.payload?.messages).toMatchObject([{ content: "Inspect the synthetic report" }]);
      expect(first.payload?.nextCursor).toBeUndefined();
    });
  });

  it("reads and pages a completed subagent transcript after delete cleanup", async () => {
    await withHistoryState(async () => {
      const scope = {
        agentId: "main",
        sessionKey: "agent:main:subagent:archived-child",
        sessionId: "archived-child",
      };
      const runId = "archived-child-run";
      await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      const contents = ["First retained message", "Second retained message", "Final result"];
      for (const [index, content] of contents.entries()) {
        const message = {
          role: "assistant",
          content: [
            { type: "text", text: content, thinkingSignature: "synthetic-private-signature" },
          ],
          stopReason: "stop",
          __openclaw: { runId },
        };
        // Opaque stored metadata must not shrink final verification's page budget.
        await appendTranscriptMessage(scope, {
          eventId: `retained-${index}`,
          message: index === 2 ? { ...message, opaque: "x".repeat(2 * 1024 * 1024) } : message,
        });
      }

      await appendTranscriptMessage(scope, {
        eventId: "abandoned",
        parentId: "retained-0",
        message: {
          role: "assistant",
          content: "Abandoned branch",
          __openclaw: { runId: "abandoned-run" },
        },
      });
      await appendTranscriptEvent(scope, {
        type: "leaf",
        id: "restore-result",
        parentId: "abandoned",
        targetId: "retained-2",
      });
      const task = createTaskFixture("subagent", {
        requesterSessionKey,
        ownerKey: requesterSessionKey,
        childSessionKey: scope.sessionKey,
        agentId: "main",
        runId,
        task: "Inspect synthetic files",
      });
      markTaskTerminalById({ taskId: task.taskId, status: "succeeded", endedAt: 2 });
      const viewer = ensureProfileForEmail("archive-viewer@example.test");
      const kept = await runTaskHandler(
        "tasks.history",
        { taskId: task.taskId },
        {},
        identifiedClient(["operator.read"], viewer.id),
        await createHistoryReadContext(),
      );
      expect(kept.calls[0]?.[0]).toBe(true);
      expect(JSON.stringify(kept.payload?.messages)).toContain("First retained message");
      const removed = await deleteSessionEntryLifecycle({
        agentId: "main",
        storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
        target: { canonicalKey: scope.sessionKey, storeKeys: [scope.sessionKey] },
        archiveTranscript: true,
        expectedSessionId: scope.sessionId,
      });
      expect(removed.deleted).toBe(true);
      let config: OpenClawConfig = {};
      const context = await createHistoryReadContext({ getRuntimeConfig: () => config });
      const first = await runTaskHandler(
        "tasks.history",
        { taskId: task.taskId, limit: 2 },
        {},
        null,
        context,
      );
      expect(first.calls[0]?.[0]).toBe(true);
      const expectedMessages = [
        { content: [{ type: "text", text: "Second retained message" }] },
        { content: [{ type: "text", text: "[chat.history omitted: message too large]" }] },
      ];
      expect(first.payload?.messages).toMatchObject(expectedMessages);
      expect(JSON.stringify(first.payload)).not.toContain("synthetic-private-signature");
      const cursor = expectDefined(
        first.payload?.nextCursor,
        "older archived child history cursor",
      );
      const second = await runTaskHandler(
        "tasks.history",
        { taskId: task.taskId, limit: 2, cursor },
        {},
        null,
        context,
      );
      expect(second.payload?.messages).toMatchObject([
        { content: [{ type: "text", text: "First retained message" }] },
      ]);
      expect(second.payload?.nextCursor).toBeUndefined();

      const successor = { ...scope, sessionId: "successor" };
      await upsertSessionEntryCore(successor, { sessionId: successor.sessionId, updatedAt: 3 });
      await appendTranscriptMessage(successor, {
        eventId: "successor-result",
        message: {
          role: "assistant",
          content: "Unrelated live successor",
          __openclaw: { runId: "successor-run" },
        },
      });
      const abandonedTask = createTaskFixture("subagent", {
        requesterSessionKey,
        ownerKey: requesterSessionKey,
        childSessionKey: scope.sessionKey,
        agentId: "main",
        runId: "abandoned-run",
        task: "Abandoned inspection",
      });
      markTaskTerminalById({ taskId: abandonedTask.taskId, status: "succeeded", endedAt: 2 });
      const unavailable = await runTaskHandler(
        "tasks.history",
        { taskId: abandonedTask.taskId },
        {},
        null,
        context,
      );
      expect(unavailable.calls).toHaveLength(1);
      expect(unavailable.calls[0]).toMatchObject([false, undefined, { code: "UNAVAILABLE" }]);
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: requesterSessionKey },
        {
          sessionId: "archive-parent",
          updatedAt: 1,
          visibility: "shared",
          createdActor: { type: "human", source: "profile", id: "another-owner" },
        },
      );
      const verify = sessionHistory.verifySessionTranscriptArchivePageBindingReadOnly;
      const admin = identifiedClient(["operator.admin"], viewer.id);
      const allowed = await runTaskHandler(
        "tasks.history",
        { taskId: task.taskId, limit: 2 },
        {},
        admin,
        context,
      );
      expect(allowed.calls[0]?.[0]).toBe(true);
      expect(allowed.payload?.messages).toMatchObject(expectedMessages);
      const archiveRead = vi.spyOn(sessionHistory, "readSessionTaskArchivePageReadOnly");
      try {
        const denied = await runTaskHandler(
          "tasks.history",
          { taskId: task.taskId, cursor },
          {},
          identifiedClient(["operator.read"], viewer.id),
          context,
        );
        expect(denied.calls[0]).toMatchObject([false, undefined, { code: "UNAVAILABLE" }]);
        expect(archiveRead).not.toHaveBeenCalled();
      } finally {
        archiveRead.mockRestore();
      }
      for (const change of ["requester", "archive", "store"] as const) {
        config = {
          gateway: {
            roles: {
              default: "reader",
              definitions: {
                reader: { agents: "*", scopes: ["operator.read"], sessions: { others: "view" } },
              },
            },
          },
        };
        admin.connect.scopes = ["operator.admin"];
        const held = vi
          .spyOn(sessionHistory, "verifySessionTranscriptArchivePageBindingReadOnly")
          .mockImplementationOnce(async (...args) => {
            await verify(...args);
            if (change === "requester") {
              admin.connect.scopes = ["operator.read"];
              config.gateway!.roles!.definitions.reader!.sessions = { others: "none" };
            } else if (change === "archive") {
              admin.connect.scopes = ["operator.read"];
            } else {
              config.session = { store: "changed-archive-store.sqlite" };
            }
          });
        try {
          const revoked = await runTaskHandler(
            "tasks.history",
            { taskId: task.taskId },
            config,
            admin,
            context,
          );
          expect(held).toHaveBeenCalledOnce();
          expect(revoked.calls).toHaveLength(1);
          expect(revoked.calls[0]).toMatchObject([false, undefined, { code: "UNAVAILABLE" }]);
        } finally {
          held.mockRestore();
        }
      }
      config = {};
      admin.connect.scopes = ["operator.admin"];
      const capacity = vi
        .spyOn(sessionHistory, "readSessionTaskArchivePageReadOnly")
        .mockRejectedValueOnce(new Error(TASK_ARCHIVE_RECORD_CAPACITY_ERROR));
      try {
        const capacityUnavailable = await runTaskHandler(
          "tasks.history",
          { taskId: task.taskId },
          {},
          admin,
          context,
        );
        expect(capacity).toHaveBeenCalledOnce();
        expect(capacityUnavailable.calls[0]).toMatchObject([
          false,
          undefined,
          {
            code: "UNAVAILABLE",
            retryable: false,
            details: { code: "TASK_HISTORY_PREVIEW_CAPACITY" },
            message: expect.stringContaining("retained transcript record exceeds the 8 MiB limit"),
          },
        ]);
        expect(capacityUnavailable.calls[0]?.[2]?.message).toContain("Refreshing will not help");
      } finally {
        capacity.mockRestore();
      }
    });
  });
});
