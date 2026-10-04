import { createHash } from "node:crypto";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { stableStringify } from "@openclaw/normalization-core/stable-stringify";
import { describe, expect, it, vi } from "vitest";
import type { GatewayClientInfo } from "../../../packages/gateway-protocol/src/client-info.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { seedCanonicalAcpSessionMeta } from "../../acp/runtime/session-meta-fixture.test-support.js";
import * as acpReads from "../../acp/runtime/session-meta-readonly.js";
import { buildAgentRunTerminalOutcome } from "../../agents/agent-run-terminal-outcome.js";
import { registerAgentSessionLoopTestLifecycle } from "../../agents/sessions/agent-session-loop-correctness.test-support.js";
import type { dispatchInboundMessage } from "../../auto-reply/dispatch.js";
import { replyRunRegistry } from "../../auto-reply/reply/reply-run-registry.js";
import { getRuntimeConfig } from "../../config/config.js";
import * as sessionAccessor from "../../config/sessions/session-accessor.js";
import {
  appendTranscriptMessageSync,
  listSessionPendingInputs,
  loadSessionEntry,
  loadTranscriptEventsSync,
  patchSessionEntryCore,
  publishTranscriptUpdate,
  replaceSessionEntrySync,
} from "../../config/sessions/session-accessor.js";
import {
  resolveSqliteScope,
  toDatabaseOptions,
} from "../../config/sessions/session-accessor.sqlite-scope.js";
import { rotateAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { initializeGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import { getSessionWorkAdmissionRelease } from "../../sessions/session-lifecycle-admission.js";
import { attachSessionTranscriptRunId } from "../../sessions/transcript-events.js";
import {
  createUserTurnTranscriptRecorder,
  type UserTurnTranscriptRecorder,
} from "../../sessions/user-turn-transcript.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { setDisplayName } from "../../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { createMentionInbox } from "../mention-inbox.js";
import { readMentionInbox, dismissMentionInbox } from "../mention-inbox.test-support.js";
import { refusePendingInputCommit } from "../pending-input-commit.test-support.js";
import { dispatchInboundMessageMock, installGatewayTestHooks } from "../test-helpers.js";
import { getTestPluginRegistry } from "../test-helpers.plugin-registry.js";
import { createWorkerSessionPlacementStore } from "../worker-environments/placement-store.js";
import { useBrowserFollowupFixture } from "./chat-send-pending-inputs.test-support.js";
import type { GatewayClient, RespondFn } from "./types.js";
installGatewayTestHooks();
registerAgentSessionLoopTestLifecycle();
const createBrowserFollowupFixture = useBrowserFollowupFixture();

describe("ordinary chat input admission", () => {
  it("acknowledges staged chat input and joins its terminal disposition without host pending-input writes", async () => {
    const fixture = await createBrowserFollowupFixture();
    let pendingAtAck: ReturnType<typeof listSessionPendingInputs> | undefined;
    const sql = observeHostDataSql();
    try {
      const ack = await fixture.send(
        vi.fn<RespondFn>((ok) => {
          if (ok) {
            pendingAtAck = listSessionPendingInputs(fixture.scope);
          }
        }),
      );
      expect(ack.mock.calls[0]?.[0]).toBe(true);
      expect(await pendingAtAck).toMatchObject({
        items: [{ state: "queued", runId: fixture.params.idempotencyKey }],
      });
      const recorder = await fixture.dispatchedRecorder;
      await recorder.completeProcessingAsync?.(
        buildAgentRunTerminalOutcome({ status: "error", stopReason: "rpc" }),
      );
      recorder.finishPendingInput?.("cancelled");
      expect(() => recorder.withPendingInput?.(() => {})).toThrow("ownership ended");
      await fixture.finishDispatch();
      const writes = sql.queries.filter((query) =>
        /\b(?:insert\s+into|update|delete\s+from)\s+["`]?session_(?:pending_inputs|input_completions)\b/i.test(
          query,
        ),
      );
      expect(writes).toEqual([]);
    } finally {
      sql.restore();
      await fixture.cleanup();
    }
    expect(await listSessionPendingInputs(fixture.scope)).toMatchObject({
      items: [{ state: "cancelled", runId: fixture.params.idempotencyKey }],
    });
  });

  async function createMentionFixture(
    options: { active?: boolean; preserveContent?: boolean } = {},
  ) {
    const fixture = await createBrowserFollowupFixture({ preserveContent: true, ...options });
    const profiles = ["Alice", "Bob", "Carol"].map((name) => {
      const profile = ensureProfileForEmail(`${name.toLowerCase()}@mentions.example.test`);
      setDisplayName(profile.id, name);
      return { profileId: profile.id, displayName: name, hasAvatar: false, updatedAt: 1 };
    });
    const [alice, bob, carol] = profiles;
    if (!alice || !bob || !carol) {
      throw new Error("Mention test profiles were not created");
    }
    fixture.client.authenticatedUserProfile = alice;
    const bobClient = { ...fixture.client, connId: "bob-one", authenticatedUserProfile: bob };
    const carolClient = { ...fixture.client, connId: "carol", authenticatedUserProfile: carol };
    const mentionBroadcast = vi.fn();
    const inbox = createMentionInbox({
      scheduler: createTestGatewayScheduler(),
      gatewayInstanceId: "chat-mention-commit-test",
      getRuntimeConfig,
      getClients: () => [fixture.client, bobClient, carolClient],
      broadcastToConnIds: mentionBroadcast,
    });
    fixture.context.mentionInbox = inbox;
    fixture.params.message = "@Bob could you review this?";
    fixture.params.mentions = [{ profileId: bob.profileId, start: 0, end: 4 }];
    const read = async (client: GatewayClient = bobClient) =>
      (await readMentionInbox(inbox, client)).items;
    return {
      ...fixture,
      bobClient,
      carolClient,
      inbox,
      read,
      mentionBroadcast,
      cleanup: async () => {
        await inbox.dispose();
        await fixture.cleanup();
      },
    };
  }

  it("creates recipient-only mentions at original message commit, never at the queued ACK", async () => {
    const fixture = await createMentionFixture();
    try {
      const ack = await fixture.send();
      expect(ack).toHaveBeenCalledWith(
        true,
        expect.objectContaining({ status: "started" }),
        undefined,
        expect.anything(),
      );
      expect(await fixture.read()).toEqual([]);
      const recorder = await fixture.dispatchedRecorder;
      const sql = observeHostDataSql();
      let committed: Awaited<ReturnType<typeof recorder.persistApproved>>;
      try {
        committed = await recorder.persistApproved();
        await fixture.read();
        expect(
          sql.calls
            .flatMap((call) => call.mock.calls)
            .filter((args) =>
              args.some(
                (value) => typeof value === "string" && value.startsWith("notifications.mentions."),
              ),
            ),
        ).toEqual([]);
        expect(
          sql.queries.filter((query) =>
            /\b(?:insert\s+into|update|delete\s+from)\s+["`]?session_nodes\b/i.test(query),
          ),
        ).toEqual([]);
      } finally {
        sql.restore();
      }
      expect(committed?.appended).toBe(true);
      expect(
        loadSessionEntry(fixture.scope)?.profileInvolvement?.profiles[
          fixture.bobClient.authenticatedUserProfile.profileId
        ],
      ).toMatchObject({ hidden: false, lastMention: { sequence: expect.any(Number) } });
      expect(await fixture.read()).toMatchObject([
        {
          messageId: committed?.messageId,
          senderProfileId: fixture.client.authenticatedUserProfile?.profileId,
          excerpt: fixture.params.message,
        },
      ]);
      expect(await fixture.read(fixture.client)).toEqual([]);
      expect(await fixture.read(fixture.carolClient)).toEqual([]);
      const id = (await fixture.read())[0]?.id;
      expect(id).toBeDefined();
      await dismissMentionInbox(fixture.inbox, fixture.bobClient, id ? [id] : []);
      await recorder.persistApproved();
      await fixture.send();
      expect(await fixture.read()).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  });

  it("includes an idle first commit in the Inbox before ACK without waiting for the agent", async () => {
    const fixture = await createMentionFixture({ active: false });
    let atAck = 0;
    try {
      const ack = await fixture.send(
        vi.fn((ok) => {
          if (ok) {
            atAck = fixture.mentionBroadcast.mock.calls.filter(
              ([event, , recipients]) => event === "mentions.changed" && recipients.has("bob-one"),
            ).length;
          }
        }),
      );
      expect(ack).toHaveBeenCalledWith(
        true,
        expect.objectContaining({ status: "started", messageSeq: 2 }),
        undefined,
        expect.anything(),
      );
      expect(atAck).toBe(1);
      await fixture.finishDispatch();
      expect(await fixture.read()).toHaveLength(1);
    } finally {
      await fixture.cleanup();
    }
  });

  it("does not notify when approval replaces the selected token", async () => {
    const fixture = await createMentionFixture({ preserveContent: false });
    try {
      await fixture.send();
      const recorder = await fixture.dispatchedRecorder;
      const committed = await recorder.persistApproved();
      expect(committed?.message.content).toBe(fixture.approvedContent);
      expect(committed?.message["__openclaw"]?.humanMentions).toBeUndefined();
      expect(await fixture.read()).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  });

  it.each(["retained", "expired"] as const)(
    "rejects changed recipients with %s RAM identity while preserving the queued original",
    async (identity) => {
      const fixture = await createMentionFixture();
      try {
        await fixture.send();
        const recorder = await fixture.dispatchedRecorder;
        if (identity === "expired") {
          fixture.context.dedupe.clear();
        }
        fixture.params.mentions = [
          { profileId: fixture.carolClient.authenticatedUserProfile.profileId, start: 0, end: 4 },
        ];
        const originalRead = sessionAccessor.readSessionSubmittedInput;
        const comparisonSql: string[] = [];
        const read = vi
          .spyOn(sessionAccessor, "readSessionSubmittedInput")
          .mockImplementation(async (...args) => {
            const sql = observeHostDataSql();
            try {
              return await originalRead(...args);
            } finally {
              comparisonSql.push(...sql.queries);
              sql.restore();
            }
          });
        try {
          const replay = await fixture.send();
          expect(replay).toHaveBeenCalledWith(
            false,
            undefined,
            expect.objectContaining({ details: { reason: "chat-request-conflict" } }),
          );
          expect(read).toHaveBeenCalledTimes(identity === "expired" ? 1 : 0);
          expect(comparisonSql).toEqual([]);
        } finally {
          read.mockRestore();
        }
        await recorder.persistApproved();
        expect(await fixture.read()).toHaveLength(1);
        expect(await fixture.read(fixture.carolClient)).toEqual([]);
      } finally {
        await fixture.cleanup();
      }
    },
  );

  it("retains pending-input custody while retrying a transient post-ACK projection failure", async () => {
    const fixture = await createBrowserFollowupFixture({ transientProjectionFailures: 1 });
    try {
      const ack = await fixture.send();
      expect(ack).toHaveBeenCalledWith(
        true,
        expect.objectContaining({ status: "started" }),
        undefined,
        expect.anything(),
      );
      await vi.waitFor(() => expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(2));
      const accepted = await listSessionPendingInputs(fixture.scope);
      const reconnect = await fixture.send();
      expect(reconnect).toHaveBeenCalledWith(
        true,
        expect.objectContaining({ runId: fixture.params.idempotencyKey, status: "in_flight" }),
        undefined,
        expect.objectContaining({ cached: true }),
      );
      expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(2);
      expect(await listSessionPendingInputs(fixture.scope)).toMatchObject({
        total: 1,
        items: [{ state: "queued", runId: fixture.params.idempotencyKey }],
      });
      expect(await listSessionPendingInputs(fixture.scope)).toEqual(accepted);
      expect(fixture.beforeApprove).toHaveBeenCalledOnce();
      expect(loadTranscriptEventsSync(fixture.scope)).toEqual(fixture.activeTranscript);
      expect(fixture.context.removeChatRun).not.toHaveBeenCalled();
      expect(fixture.context.broadcast).not.toHaveBeenCalledWith(
        "chat",
        expect.objectContaining({ runId: fixture.params.idempotencyKey, state: "error" }),
        expect.anything(),
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it.each([
    { id: "openclaw-control-ui", mode: "webchat", displayName: "Web" },
    { id: "cli", mode: "cli", displayName: "CLI" },
    { id: "openclaw-macos", mode: "ui", displayName: "macOS" },
    { id: "gateway-client", mode: "backend", displayName: "Automation" },
  ] satisfies Array<Pick<GatewayClientInfo, "id" | "mode" | "displayName">>)(
    "stages the approved $id follow-up and its source before ACK without changing the active transcript",
    async (clientInfo) => {
      const fixture = await createBrowserFollowupFixture();
      fixture.client.connect.client = { ...fixture.client.connect.client, ...clientInfo };
      fixture.params.queueMode = "followup";
      const profile = ensureProfileForEmail("alice@example.test");
      fixture.client.authenticatedUserProfile = {
        profileId: profile.id,
        displayName: "Alice",
        hasAvatar: false,
        updatedAt: 1,
      };
      const clone = vi.spyOn(globalThis, "structuredClone");
      const { scope, params, approvedContent, activeTranscript } = fixture;
      const readPending = () =>
        Promise.allSettled([listSessionPendingInputs(scope)]).then(([result]) => result);
      let transcriptAtAck: ReturnType<typeof loadTranscriptEventsSync> | undefined;
      let pendingAtAck: ReturnType<typeof readPending> | undefined;
      let pendingAtNotification: ReturnType<typeof readPending> | undefined;
      fixture.context.getSessionEventSubscriberConnIds = () => new Set(["observer"]);
      vi.spyOn(fixture.context, "broadcastToConnIds").mockImplementation((event, payload) => {
        if (event === "sessions.changed" && isRecord(payload) && payload.reason === "send") {
          pendingAtNotification = readPending();
        }
      });
      const respond = vi.fn<RespondFn>((ok) => {
        if (ok) {
          transcriptAtAck = loadTranscriptEventsSync(scope);
          pendingAtAck = readPending();
        }
      });
      try {
        expect(replyRunRegistry.isActive(scope.sessionKey)).toBe(true);
        expect(
          replyRunRegistry.resolveCurrentMessageInjectionTarget(scope.sessionKey),
        ).toBeUndefined();
        await fixture.send(respond);
        expect(respond).toHaveBeenCalledWith(
          true,
          expect.objectContaining({ runId: params.idempotencyKey, status: "started" }),
          undefined,
          expect.anything(),
        );
        expect(respond.mock.calls[0]?.[1]).not.toHaveProperty("messageSeq");
        expect(transcriptAtAck).toEqual(activeTranscript);
        expect(await pendingAtAck).toMatchObject({
          status: "fulfilled",
          value: {
            total: 1,
            items: [
              {
                state: "queued",
                runId: params.idempotencyKey,
                message: {
                  role: "user",
                  content: approvedContent,
                  idempotencyKey: `${params.idempotencyKey}:user`,
                  __openclaw: {
                    senderId: profile.id,
                    senderIdentity: { type: "profile", id: profile.id },
                    transport: { clients: [clientInfo] },
                  },
                },
              },
            ],
          },
        });
        expect(await pendingAtNotification).toEqual(await pendingAtAck);
        const recorder = await fixture.dispatchedRecorder;
        const committed = await recorder.persistApproved();
        expect(committed?.message["__openclaw"]).toMatchObject({
          senderIdentity: { type: "profile", id: profile.id },
          transport: { clients: [clientInfo] },
        });
        // Initial resolution detaches the store; custody needs only the current target binding.
        expect(
          clone.mock.calls.filter(
            ([entry]) => isRecord(entry) && entry.sessionId === "unrelated-browser-session",
          ).length,
        ).toBeLessThanOrEqual(1);
      } finally {
        clone.mockRestore();
        await Promise.allSettled([pendingAtAck, pendingAtNotification]);
        await fixture.cleanup();
      }
    },
  );

  it("keeps internal system inputs outside ordinary pending-message custody", async () => {
    const fixture = await createBrowserFollowupFixture();
    fixture.client.connect.client = { id: "cli", mode: "cli", version: "test", platform: "test" };
    fixture.params.systemInputProvenance = {
      kind: "internal_system",
      sourceTool: "system_fixture",
    };
    try {
      const ack = await fixture.send();
      expect(ack.mock.calls[0]?.[0]).toBe(true);
      expect(await listSessionPendingInputs(fixture.scope)).toEqual({ items: [], total: 0 });
      const recorder = await fixture.dispatchedRecorder;
      expect((await recorder.resolveMessage())?.["__openclaw"]?.transport).toBeUndefined();
    } finally {
      await fixture.cleanup();
    }
  });

  it.each([{ acp: false }, { acp: true }, { acp: true, restart: true }])(
    "keeps idle input custody with its runtime (%j)",
    async ({ acp, restart }) => {
      const fixture = await createBrowserFollowupFixture({ active: false });
      if (acp) {
        seedCanonicalAcpSessionMeta({
          sessionKey: fixture.scope.sessionKey,
          sessionId: fixture.scope.sessionId,
          meta: {
            backend: "acpx",
            agent: "main",
            runtimeSessionName: "idle-custody",
            mode: "persistent",
            state: "idle",
            lastActivityAt: 1,
          },
        });
      }
      const clone = vi.spyOn(globalThis, "structuredClone");
      const read = acpReads.readAcpSessionMetaForEntries;
      const restarting = restart
        ? vi
            .spyOn(acpReads, "readAcpSessionMetaForEntries")
            .mockImplementationOnce(async (...args) => {
              const result = await read(...args);
              rotateAgentEventLifecycleGeneration();
              return result;
            })
        : undefined;
      let transcriptAtAck: ReturnType<typeof loadTranscriptEventsSync> | undefined;
      const respond = vi.fn<RespondFn>((ok) => {
        if (ok) {
          transcriptAtAck = loadTranscriptEventsSync(fixture.scope);
        }
      });
      try {
        await fixture.send(respond);
        if (restart) {
          expect(respond).toHaveBeenCalledOnce();
          expect(respond).not.toHaveBeenCalledWith(
            true,
            expect.objectContaining({ status: "started" }),
            undefined,
            expect.anything(),
          );
          expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
          expect(await listSessionPendingInputs(fixture.scope)).toEqual({ items: [], total: 0 });
          expect(loadTranscriptEventsSync(fixture.scope)).toEqual(fixture.activeTranscript);
          return;
        }
        expect(respond).toHaveBeenCalledWith(
          true,
          expect.objectContaining({ status: "started", ...(acp ? {} : { messageSeq: 2 }) }),
          undefined,
          expect.anything(),
        );
        if (acp) {
          expect(transcriptAtAck).toEqual(fixture.activeTranscript);
          expect(await listSessionPendingInputs(fixture.scope)).toMatchObject({ total: 1 });
          expect(loadSessionEntry(fixture.scope)).not.toHaveProperty("acp");
        } else {
          expect(transcriptAtAck).toHaveLength(fixture.activeTranscript.length + 1);
          expect(transcriptAtAck?.at(-1)).toMatchObject({
            message: {
              role: "user",
              content: fixture.params.message,
              idempotencyKey: `${fixture.params.idempotencyKey}:user`,
            },
          });
          expect(await listSessionPendingInputs(fixture.scope)).toEqual({ items: [], total: 0 });
        }
        expect(
          clone.mock.calls.filter(
            ([entry]) => isRecord(entry) && entry.sessionId === "unrelated-browser-session",
          ).length,
        ).toBeLessThanOrEqual(1);
      } finally {
        restarting?.mockRestore();
        clone.mockRestore();
        await fixture.cleanup();
      }
    },
  );

  it.each(["worker-turn", "remote-exec"] as const)(
    "holds an idle %s browser input in custody while its workspace is syncing",
    async (executionMode) => {
      const fixture = await createBrowserFollowupFixture({ active: false });
      const placements = createWorkerSessionPlacementStore();
      const requested = await placements.startDispatch({ ...fixture.scope, executionMode });
      const provisioning = await placements.transition({
        sessionId: fixture.scope.sessionId,
        from: "requested",
        to: "provisioning",
        expectedGeneration: requested.generation,
        patch: { environmentId: "setup-environment" },
      });
      await placements.transition({
        sessionId: fixture.scope.sessionId,
        from: "provisioning",
        to: "syncing",
        expectedGeneration: provisioning.generation,
        patch: { workerBundleHash: "a".repeat(64) },
      });
      fixture.context.workerSessionPlacementService = placements;
      try {
        const respond = await fixture.send();
        expect(respond).toHaveBeenCalledWith(
          true,
          expect.objectContaining({ status: "started" }),
          undefined,
          expect.anything(),
        );
        expect(respond.mock.calls[0]?.[1]).not.toHaveProperty("messageSeq");
        expect(loadTranscriptEventsSync(fixture.scope)).toEqual(fixture.activeTranscript);
        expect(await listSessionPendingInputs(fixture.scope)).toMatchObject({
          total: 1,
          items: [{ state: "queued", runId: fixture.params.idempotencyKey }],
        });
      } finally {
        await fixture.cleanup();
      }
    },
  );

  it("retries a failed custody write with the same request identity without acknowledging lost input", async () => {
    const fixture = await createBrowserFollowupFixture();
    const refusal = refusePendingInputCommit({
      operation: "stage",
      message: "custody unavailable",
      sessionId: fixture.scope.sessionId,
      runId: fixture.params.idempotencyKey,
    });
    try {
      const rejected = await fixture.send();
      expect(rejected).toHaveBeenCalledWith(
        false,
        expect.objectContaining({ status: "error" }),
        expect.objectContaining({ message: expect.stringContaining("custody unavailable") }),
        expect.anything(),
      );
      expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
      expect(loadTranscriptEventsSync(fixture.scope)).toEqual(fixture.activeTranscript);
      expect(await listSessionPendingInputs(fixture.scope)).toEqual({ items: [], total: 0 });
      expect(fixture.context.chatAbortControllers.has(fixture.params.idempotencyKey)).toBe(false);
      await getSessionWorkAdmissionRelease({
        scope: fixture.scope.storePath,
        identities: [fixture.scope.sessionKey, fixture.scope.sessionId],
      });

      refusal.mockRestore();
      const retried = await fixture.send();
      expect(retried).toHaveBeenCalledWith(
        true,
        expect.objectContaining({ runId: fixture.params.idempotencyKey, status: "started" }),
        undefined,
        expect.anything(),
      );
      expect(await listSessionPendingInputs(fixture.scope)).toMatchObject({
        total: 1,
        items: [{ state: "queued", message: { content: fixture.approvedContent } }],
      });
      expect(loadTranscriptEventsSync(fixture.scope)).toEqual(fixture.activeTranscript);
    } finally {
      refusal.mockRestore();
      await fixture.cleanup();
    }
  });

  it.each(["cancellation", "lifecycle rotation", "session replacement"] as const)(
    "revalidates %s after message approval before committing custody",
    async (change) => {
      const fixture = await createBrowserFollowupFixture();
      fixture.beforeApprove.mockImplementation(() => {
        if (change === "lifecycle rotation") {
          rotateAgentEventLifecycleGeneration();
          return;
        }
        if (change === "session replacement") {
          replaceSessionEntrySync(fixture.scope, {
            sessionId: "successor-session",
            updatedAt: Date.now(),
          });
          return;
        }
        const active = fixture.context.chatAbortControllers.get(fixture.params.idempotencyKey);
        if (!active) {
          throw new Error("Expected the browser admission to own its cancellation controller");
        }
        active.abortStopReason = "rpc";
        active.controller.abort();
      });
      try {
        const respond = await fixture.send();
        expect(fixture.beforeApprove).toHaveBeenCalledOnce();
        expect(respond).toHaveBeenCalledOnce();
        expect(respond).not.toHaveBeenCalledWith(
          true,
          expect.objectContaining({ status: "started" }),
          undefined,
          expect.anything(),
        );
        expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
        expect(await listSessionPendingInputs(fixture.scope)).toEqual({ items: [], total: 0 });
        expect(loadTranscriptEventsSync(fixture.scope)).toEqual(fixture.activeTranscript);
        if (change === "session replacement") {
          expect(loadSessionEntry(fixture.scope)?.sessionId).toBe("successor-session");
          expect(
            loadTranscriptEventsSync({ ...fixture.scope, sessionId: "successor-session" }),
          ).toEqual([]);
        }
        expect(fixture.context.chatAbortControllers.has(fixture.params.idempotencyKey)).toBe(false);
      } finally {
        await fixture.cleanup();
      }
    },
  );

  it("does not execute a consumed collected source when retried after the session becomes idle", async () => {
    const fixture = await createBrowserFollowupFixture();
    try {
      await fixture.send();
      expect((await listSessionPendingInputs(fixture.scope)).total).toBe(1);
      const source = await fixture.dispatchedRecorder;
      const aggregate = createUserTurnTranscriptRecorder({
        input: {
          text: "Collected follow-up already accepted for execution.",
          idempotencyKey: "collected-follow-up:user",
          timestamp: Date.now(),
        },
        pendingInputSources: [source],
        target: () => ({
          ...fixture.scope,
          sessionEntry: loadSessionEntry(fixture.scope),
          expectedSessionId: fixture.scope.sessionId,
        }),
      });
      await aggregate.persistApproved();
      const consumedTranscript = loadTranscriptEventsSync(fixture.scope);
      expect(consumedTranscript).toHaveLength(fixture.activeTranscript.length + 1);
      expect(await listSessionPendingInputs(fixture.scope)).toEqual({ items: [], total: 0 });
      await fixture.finishDispatch();
      await patchSessionEntryCore(fixture.scope, () => ({ status: "done" }));
      const registry = getTestPluginRegistry();
      registry.typedHooks = registry.typedHooks.filter(
        (hook) => hook.pluginId !== "approved-input-fixture",
      );
      initializeGlobalHookRunner(registry);
      // Exercise durable replay detection after the transient ACK cache is gone.
      fixture.context.dedupe.clear();
      dispatchInboundMessageMock.mockClear();
      const retried = await fixture.send();
      expect(retried).toHaveBeenCalledWith(
        true,
        { runId: fixture.params.idempotencyKey, status: "ok" },
        undefined,
        expect.objectContaining({ cached: true }),
      );
      expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
      expect(fixture.beforeApprove).toHaveBeenCalledOnce();
      expect(loadTranscriptEventsSync(fixture.scope)).toEqual(consumedTranscript);
      expect(await listSessionPendingInputs(fixture.scope)).toEqual({ items: [], total: 0 });
    } finally {
      await fixture.cleanup();
    }
  });

  it.each(
    ["consumed", "changed-payload", "interrupted"].flatMap((disposition) =>
      [false, true].map((recordedClient) => ({ disposition, recordedClient })),
    ),
  )(
    "preserves legacy collected-input replay without adopting old custody ($disposition, recordedClient=$recordedClient)",
    async ({ disposition, recordedClient }) => {
      const fixture = await createBrowserFollowupFixture({ preserveContent: true });
      const profile = ensureProfileForEmail("legacy-input@example.test");
      fixture.client.authenticatedUserProfile = {
        profileId: profile.id,
        displayName: "Legacy input author",
        hasAvatar: false,
        updatedAt: 1,
      };
      try {
        const originalAck = await fixture.send();
        expect(originalAck.mock.calls[0]?.[0]).toBe(true);
        let source: UserTurnTranscriptRecorder | undefined;
        void fixture.dispatchedRecorder.then((recorder) => {
          source = recorder;
        });
        await vi.waitFor(() => expect(source).toBeDefined(), { timeout: 5_000 });
        if (!source) {
          throw new Error("Expected the original accepted input recorder");
        }
        const message = source.getPendingInputMessage?.();
        if (!message) {
          throw new Error("Expected the approved original source before collection");
        }
        if (disposition !== "interrupted") {
          const aggregate = createUserTurnTranscriptRecorder({
            input: {
              text: "Collected follow-up already accepted for execution.",
              idempotencyKey: "legacy-collected-follow-up:user",
              timestamp: Date.now(),
            },
            pendingInputSources: [source],
            target: () => ({
              ...fixture.scope,
              sessionEntry: loadSessionEntry(fixture.scope),
              expectedSessionId: fixture.scope.sessionId,
            }),
          });
          await aggregate.persistApproved();
        }
        rotateAgentEventLifecycleGeneration();
        await fixture.finishDispatch();
        await patchSessionEntryCore(fixture.scope, () => ({ status: "done" }));
        const legacyMessage = structuredClone(message);
        if (!recordedClient) {
          // Shipped Gateway receipts predate transport.clients. Seed only after
          // collection, whose live owner still requires its exact accepted bytes.
          delete legacyMessage["__openclaw"]?.transport;
        }
        const { timestamp: _timestamp, ...stableMessage } = legacyMessage;
        const legacyHash = createHash("sha256")
          .update(stableStringify(stableMessage))
          .digest("hex");
        const database = openOpenClawAgentDatabase(
          toDatabaseOptions(resolveSqliteScope(fixture.scope)),
        );
        const seeded = database.db
          .prepare(
            "UPDATE session_pending_inputs SET request_hash = ?, message_json = ? WHERE session_key = ? AND session_id = ? AND run_id = ?",
          )
          .run(
            legacyHash,
            JSON.stringify(legacyMessage),
            fixture.scope.sessionKey,
            fixture.scope.sessionId,
            fixture.params.idempotencyKey,
          );
        expect(seeded.changes).toBe(1);
        const transcript = loadTranscriptEventsSync(fixture.scope);
        fixture.context.dedupe.clear();
        dispatchInboundMessageMock.mockClear();
        if (disposition === "changed-payload") {
          fixture.params.message += " Changed request.";
        }

        const retried = await fixture.send();
        if (disposition === "consumed") {
          expect(retried).toHaveBeenCalledWith(
            true,
            { runId: fixture.params.idempotencyKey, status: "ok" },
            undefined,
            expect.objectContaining({ cached: true }),
          );
        } else {
          expect(retried.mock.calls[0]?.[0]).toBe(false);
        }
        expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
        expect(fixture.beforeApprove).toHaveBeenCalledOnce();
        expect(loadTranscriptEventsSync(fixture.scope)).toEqual(transcript);
        expect((await listSessionPendingInputs(fixture.scope)).total).toBe(
          disposition === "interrupted" ? 1 : 0,
        );
      } finally {
        await fixture.cleanup();
      }
    },
  );

  it.each([false, true])(
    "re-admits an unconsumed browser input after restart with fresh custody (attachment: %s)",
    async (attachment) => {
      const fixture = await createBrowserFollowupFixture({ preserveContent: true });
      const resumedRelease = createDeferred();
      let resumedRecorder: UserTurnTranscriptRecorder | undefined;
      const profile = ensureProfileForEmail("restart-input@example.test");
      fixture.client.authenticatedUserProfile = {
        profileId: profile.id,
        displayName: "Input author",
        hasAvatar: false,
        updatedAt: 1,
      };
      if (!attachment) {
        delete fixture.params.sessionId;
      }
      if (attachment) {
        fixture.params.attachments = [
          {
            type: "file",
            mimeType: "text/plain",
            fileName: "review.txt",
            content: Buffer.from("Keep these exact attachment bytes.").toString("base64"),
          },
        ];
      }
      try {
        const originalAck = await fixture.send();
        expect(originalAck).toHaveBeenCalledWith(
          true,
          expect.objectContaining({ status: "started" }),
          undefined,
          expect.anything(),
        );
        const originalRecorder = await fixture.dispatchedRecorder;
        const original = (await listSessionPendingInputs(fixture.scope)).items[0];
        expect(original).toBeDefined();
        rotateAgentEventLifecycleGeneration();
        await fixture.finishDispatch();
        expect((await listSessionPendingInputs(fixture.scope)).items).toEqual([
          { ...original, state: "interrupted" },
        ]);
        expect(loadTranscriptEventsSync(fixture.scope)).toEqual(fixture.activeTranscript);
        fixture.context.dedupe.clear();
        await patchSessionEntryCore(fixture.scope, () => ({ status: "done" }));
        dispatchInboundMessageMock.mockImplementation(async (options: unknown) => {
          const { replyOptions } = options as Parameters<typeof dispatchInboundMessage>[0];
          if (replyOptions?.userTurnTranscriptRecorder) {
            resumedRecorder = replyOptions.userTurnTranscriptRecorder;
          }
          await resumedRelease.promise;
          return {};
        });

        // Exercise the actual browser reconnect envelope through request normalization.
        Object.assign(fixture.params, {
          sessionId: fixture.scope.sessionId,
          __controlUiReconnectResume: true,
        });
        const ack = await fixture.send();
        expect(ack).toHaveBeenCalledWith(
          true,
          expect.objectContaining({ status: "started", runId: fixture.params.idempotencyKey }),
          undefined,
          expect.anything(),
        );
        await vi.waitFor(() => expect(resumedRecorder).toBeDefined(), { timeout: 5_000 });
        if (!resumedRecorder) {
          throw new Error("Fresh input admission did not dispatch its recorder");
        }
        const resumed = resumedRecorder;
        expect((await listSessionPendingInputs(fixture.scope)).items).toEqual([
          { ...original, state: "queued" },
        ]);
        expect(() => originalRecorder.withPendingInput?.(() => {})).toThrow("ownership ended");
        const committed = await resumed.persistApproved();
        expect(committed).toMatchObject({ appended: true, messageId: original?.id });
        expect(committed?.message).toEqual(original?.message);
        expect(fixture.beforeApprove).toHaveBeenCalledOnce();
        expect((await listSessionPendingInputs(fixture.scope)).items).toEqual([]);
      } finally {
        resumedRelease.resolve();
        await fixture.cleanup();
      }
    },
  );

  it.each(["sender", "payload", "cancelled", "same-generation"] as const)(
    "does not recover pending input when its %s prevents fresh admission",
    async (change) => {
      const fixture = await createMentionFixture({ preserveContent: true });
      try {
        const originalAck = await fixture.send();
        expect(originalAck.mock.calls[0]?.[0]).toBe(true);
        const recorder = await fixture.dispatchedRecorder;
        const original = (await listSessionPendingInputs(fixture.scope)).items[0];
        expect(original).toBeDefined();
        if (change === "cancelled" || change === "same-generation") {
          recorder?.finishPendingInput?.(change === "cancelled" ? "cancelled" : "interrupted");
        }
        if (change !== "same-generation") {
          rotateAgentEventLifecycleGeneration();
        }
        await fixture.finishDispatch();
        fixture.context.dedupe.clear();
        dispatchInboundMessageMock.mockClear();
        await patchSessionEntryCore(fixture.scope, () => ({ status: "done" }));
        if (change === "sender") {
          fixture.client.authenticatedUserProfile = fixture.bobClient.authenticatedUserProfile;
        } else if (change === "payload") {
          fixture.params.message += " Changed request.";
        }
        const rejected = await fixture.send();
        expect(rejected.mock.calls[0]?.[0]).toBe(false);
        expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
        expect((await listSessionPendingInputs(fixture.scope)).items).toEqual([
          { ...original, state: change === "cancelled" ? "cancelled" : "interrupted" },
        ]);
        expect(loadTranscriptEventsSync(fixture.scope)).toEqual(fixture.activeTranscript);
      } finally {
        await fixture.cleanup();
      }
    },
  );

  it.each(["webchat", "queued-webchat", "external"] as const)(
    "keeps committed history delivery with the %s source owner",
    async (route) => {
      const fixture = await createBrowserFollowupFixture({ active: false });
      const entered = createDeferred<Parameters<typeof dispatchInboundMessage>[0]>();
      const release = createDeferred();
      let settleQueued: (() => void) | undefined;
      if (route === "external") {
        fixture.params.originatingChannel = "discord";
        fixture.params.originatingTo = "channel:synthetic";
        fixture.params.deliver = true;
      }
      dispatchInboundMessageMock.mockImplementation(async (dispatchParams: unknown) => {
        const options = dispatchParams as Parameters<typeof dispatchInboundMessage>[0];
        if (route === "queued-webchat") {
          // The queue retains cancellation/admission after the initial dispatch unwinds.
          options.replyOptions?.turnAdoptionLifecycle?.onDeferred?.();
          settleQueued = options.replyOptions?.turnAdoptionLifecycle?.onSettled;
        }
        entered.resolve(options);
        if (route !== "queued-webchat") {
          await release.promise;
        }
        return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
      });
      try {
        const ack = await fixture.send();
        expect(ack.mock.calls[0]?.[0]).toBe(true);
        const { replyOptions } = await entered.promise;
        if (route === "queued-webchat") {
          await vi.waitFor(() =>
            expect(fixture.context.chatAbortControllers.has(fixture.params.idempotencyKey)).toBe(
              false,
            ),
          );
        }
        await replyOptions?.userTurnTranscriptRecorder?.persistApproved();
        await replyOptions?.onAgentRunStart?.(fixture.params.idempotencyKey);
        const message = attachSessionTranscriptRunId(
          {
            role: "assistant",
            content: [
              {
                type: "text",
                text: "The synthetic fixture is ready.",
                textSignature: JSON.stringify({
                  v: 1,
                  id: "receipt-answer",
                  phase: "final_answer",
                }),
              },
              { type: "toolCall", id: "inspect", name: "read", arguments: {} },
            ],
            stopReason: "toolUse",
          },
          fixture.params.idempotencyKey,
        );
        const appended = appendTranscriptMessageSync(fixture.scope, {
          eventId: "route-answer",
          message,
        });
        if (!appended?.ok) {
          throw new Error("Expected committed route fixture answer");
        }
        await publishTranscriptUpdate(fixture.scope, { message, messageId: "route-answer" });
        expect((await replyOptions?.resolveReplyDelivery?.()) ?? "missing").toBe(
          route === "external" ? "missing" : "delivered",
        );
        if (route === "queued-webchat") {
          settleQueued?.();
          expect(await replyOptions?.resolveReplyDelivery?.()).toBe("missing");
        }
      } finally {
        settleQueued?.();
        release.resolve();
        await fixture.cleanup();
      }
    },
  );
});
