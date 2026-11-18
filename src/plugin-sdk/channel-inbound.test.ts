import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { withinTest } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { readChannelContextAdmissionEvidence } from "../channels/message-access/admission-evidence.js";
import { recordInboundSession } from "../channels/session.js";
import { loadSessionEntry, replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import { registerSessionMaintenancePreserveKeysProvider } from "../config/sessions/store-maintenance-preserve.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { createDeferredCore } from "../shared/deferred.js";
import { hasOpenClawAgentDatabaseAsyncResources } from "../state/openclaw-agent-db-resources.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import {
  buildChannelInboundEventContext,
  buildChannelTurnContext,
  dispatchChannelInboundReply,
  runChannelInboundEvent,
  type AssembledInboundReply,
  type BuildChannelInboundEventContextParams,
  type ChannelInboundEventRunnerParams,
} from "./channel-inbound.js";
import * as channelIngressRuntime from "./channel-ingress-runtime.js";

function runInbound(
  resolveTurn: ChannelInboundEventRunnerParams<string>["adapter"]["resolveTurn"],
) {
  return runChannelInboundEvent({
    channel: "test",
    raw: "hello",
    adapter: { ingest: () => ({ id: "msg-1", rawText: "hello" }), resolveTurn },
  });
}

function createInboundParams(
  overrides: Partial<BuildChannelInboundEventContextParams> = {},
): BuildChannelInboundEventContextParams {
  return {
    channel: "test",
    messageId: "msg-1",
    from: "test:user:u1",
    sender: { id: "u1" },
    conversation: { kind: "group", id: "room-1" },
    route: { agentId: "main", routeSessionKey: "agent:main:test:group:room-1" },
    reply: { to: "test:room:room-1" },
    message: { rawBody: "side chatter", inboundEventKind: "room_event" },
    ...overrides,
  };
}

function replyFixture() {
  const callback = vi.fn();
  const replyOptions = {
    disableTools: true,
    internalEventExecution: { onStarted: callback },
    onReplyOperationOwned: callback,
  };
  const dispatch = vi.fn<AssembledInboundReply["dispatchReplyWithBufferedBlockDispatcher"]>(
    async ({ replyOptions: options }) => {
      expect(options).not.toHaveProperty("internalEventExecution");
      expect(options).not.toHaveProperty("onReplyOperationOwned");
      expect(options?.disableTools).toBe(true);
      return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
    },
  );
  const turn = {
    cfg: {},
    channel: "test",
    agentId: "main",
    routeSessionKey: "agent:main:test:peer",
    storePath: "unused",
    ctxPayload: { Body: "hello", CommandAuthorized: false },
    recordInboundSession: async () => {},
    delivery: { deliver: async () => {} },
    replyOptions,
    dispatchReplyWithBufferedBlockDispatcher: dispatch,
  } satisfies AssembledInboundReply;
  return { turn, callback, dispatch, replyOptions };
}

describe("channel-inbound public helpers", () => {
  const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
    afterEach(async () => {
      // Maintenance admits a reclamation Worker; its lease release must finish in this case.
      await closeOpenClawAgentDatabasesAsync();
      closeOpenClawAgentDatabasesForTest();
      await closeOpenClawStateDatabaseAsync();
      closeOpenClawStateDatabaseForTest();
      cleanup();
      expect(hasOpenClawAgentDatabaseAsyncResources()).toBe(false);
    }),
  );

  it("keeps event custody out of assembled inbound reply dispatch", async () => {
    const { turn, callback, dispatch, replyOptions } = replyFixture();
    const result = await dispatchChannelInboundReply(turn);
    expect(result.dispatched).toBe(true);
    expect(dispatch).toHaveBeenCalledOnce();
    expect(replyOptions.onReplyOperationOwned).toBe(callback);
  });

  it("preserves frozen class adapter receivers while stripping event custody", async () => {
    const calls: string[] = [];
    const { turn, callback, dispatch, replyOptions } = replyFixture();
    const dispatchReply = turn.dispatchReplyWithBufferedBlockDispatcher;
    turn.dispatchReplyWithBufferedBlockDispatcher = vi.fn(async (params) => {
      calls.push("dispatch");
      return dispatchReply(params);
    });
    class Adapter {
      #turn = turn;
      ingest(raw: string) {
        expect(this.#turn).toBe(turn);
        calls.push("ingest");
        return { id: "event-1", rawText: raw };
      }
      classify() {
        expect(this.#turn).toBe(turn);
        calls.push("classify");
        return { kind: "message" as const, canStartAgentTurn: true };
      }
      preflight() {
        expect(this.#turn).toBe(turn);
        calls.push("preflight");
        return { kind: "dispatch" as const };
      }
      resolveTurn() {
        calls.push("resolve");
        return this.#turn;
      }
      onFinalize(result: { dispatched: boolean }) {
        expect(this.#turn).toBe(turn);
        expect(result.dispatched).toBe(true);
        calls.push("finalize");
      }
    }
    const result = await runChannelInboundEvent({
      channel: "test",
      raw: "hello",
      adapter: Object.freeze(new Adapter()),
    });
    expect(result.dispatched).toBe(true);
    expect(dispatch).toHaveBeenCalledOnce();
    expect(calls).toEqual(["ingest", "classify", "preflight", "resolve", "dispatch", "finalize"]);
    expect(replyOptions.internalEventExecution.onStarted).toBe(callback);
    expect(replyOptions.onReplyOperationOwned).toBe(callback);
    expect(callback).not.toHaveBeenCalled();
  });

  it("dispatches a published inbound event without waiting for automatic session maintenance", async ({
    signal,
  }) => {
    const storePath = `${tempDirs.make("openclaw-channel-inbound-maintenance-")}/sessions.json`;
    const staleSessionKey = "agent:main:published-inbound-stale";
    const activeSessionKey = "agent:main:test:peer";
    replaceSessionEntrySync(
      { storePath, sessionKey: staleSessionKey },
      { sessionId: "published-inbound-stale", updatedAt: 1 },
    );
    let staleEntryAtDispatch: ReturnType<typeof loadSessionEntry>;
    const databasePath = resolveSqliteTargetFromSessionStorePath(storePath).path;
    const maintenanceCommitted = createDeferredCore();
    const maintenancePrepared = createDeferredCore();
    const releaseMaintenance = createDeferredCore();
    // Metadata and last-route writes can yield to maintenance. Hold its real preparation
    // so this proves dispatch is independent of completion, not event-loop timing.
    onTestFinished(
      registerSessionMaintenancePreserveKeysProvider(async () => {
        maintenancePrepared.resolve();
        await releaseMaintenance.promise;
        return { capture: () => [], dispose() {} };
      }),
    );
    // Cold Worker startup can exceed a polling deadline; observe its committed row instead.
    onTestFinished(
      sessionChanges.subscribe((change) => {
        if (
          "sessionKey" in change &&
          change.sessionKey === staleSessionKey &&
          change.storePath === databasePath
        ) {
          maintenanceCommitted.resolve();
        }
      }),
    );

    try {
      const result = await withinTest(
        runInbound(() => ({
          channel: "test",
          routeSessionKey: activeSessionKey,
          storePath,
          ctxPayload: {
            Body: "hello",
            CommandAuthorized: false,
            RawBody: "hello",
            CommandBody: "hello",
            From: "test:user:peer",
            To: "test:bot",
            SessionKey: activeSessionKey,
            Provider: "test",
            Surface: "test",
          },
          recordInboundSession,
          afterRecord: () => withinTest(maintenancePrepared.promise, signal),
          record: {
            updateLastRoute: {
              accountId: "default",
              channel: "test",
              sessionKey: activeSessionKey,
              to: "user:peer",
            },
            onRecordError: (error: unknown) => {
              throw error;
            },
          },
          runDispatch: async () => {
            staleEntryAtDispatch = loadSessionEntry({ storePath, sessionKey: staleSessionKey });
            return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
          },
          runDispatchLifecycle: {
            turnAdoptionLifecycle: undefined,
            onDispatchSkipped: vi.fn(),
          },
        })),
        signal,
      );

      expect(result.dispatched).toBe(true);
      expect(staleEntryAtDispatch).toMatchObject({ sessionId: "published-inbound-stale" });
      expect(staleEntryAtDispatch?.archivedAt).toBeUndefined();
    } finally {
      releaseMaintenance.resolve();
    }
    await withinTest(maintenanceCommitted.promise, signal);
    expect(loadSessionEntry({ storePath, sessionKey: staleSessionKey })).toMatchObject({
      sessionId: "published-inbound-stale",
      updatedAt: 1,
      archivedAt: expect.any(Number),
    });
  });

  it("builds inbound event kind into message context", async () => {
    const ctx = buildChannelInboundEventContext(createInboundParams());

    expect(ctx.InboundEventKind).toBe("room_event");
  });

  it("does not expose public participant evidence authority", () => {
    expect(channelIngressRuntime).not.toHaveProperty("createChannelParticipantAdmissionEvidence");
    expect(channelIngressRuntime).not.toHaveProperty("copyChannelParticipantAdmissionEvidence");
  });

  it("keeps public resolver and builder paths non-authoritative", async () => {
    const channelIngress = await channelIngressRuntime.resolveStableChannelMessageIngress({
      channelId: "test",
      accountId: "default",
      subject: { stableId: "u1" },
      conversation: { kind: "group", id: "room-1" },
      dmPolicy: "open",
      groupPolicy: "open",
    });
    const ctx = buildChannelTurnContext({
      ...createInboundParams({ channelIngress }),
      message: { rawBody: "hello", inboundTurnKind: "user_request" },
    });

    expect(ctx.InboundTurnKind).toBe("user_request");
    expect(readChannelContextAdmissionEvidence(ctx)).toBeUndefined();
  });
});
