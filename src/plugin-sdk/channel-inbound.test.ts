/**
 * Tests channel inbound context and dispatch helper behavior.
 */
import { afterEach, describe, expect, expectTypeOf, it, onTestFinished, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { readChannelContextAdmissionEvidence } from "../channels/message-access/admission-evidence.js";
import { recordInboundSession } from "../channels/session.js";
import { loadSessionEntry, replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
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
  type BuildChannelInboundEventContextParams,
  type PluginHookChannelSenderContext,
} from "./channel-inbound.js";
import * as channelIngressRuntime from "./channel-ingress-runtime.js";

declare module "./channel-inbound.js" {
  interface PluginHookChannelSenderContext {
    testUnionId?: string;
  }
}

function createInboundParams(
  overrides: Partial<BuildChannelInboundEventContextParams> = {},
): BuildChannelInboundEventContextParams {
  return {
    channel: "test",
    messageId: "msg-1",
    from: "test:user:u1",
    sender: { id: "u1" },
    conversation: {
      kind: "group",
      id: "room-1",
    },
    route: {
      agentId: "main",
      routeSessionKey: "agent:main:test:group:room-1",
    },
    reply: {
      to: "test:room:room-1",
    },
    message: {
      rawBody: "side chatter",
      inboundEventKind: "room_event",
    },
    ...overrides,
  };
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

  it.each(["assembled", "adapter"] as const)(
    "keeps event custody out of %s inbound reply dispatch",
    async (surface) => {
      const callback = vi.fn();
      const replyOptions = {
        isHeartbeat: true,
        internalEventExecution: { onStarted: callback },
        onReplyOperationOwned: callback,
      };
      let dispatched = false;
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
        dispatchReplyWithBufferedBlockDispatcher: async (
          params: Parameters<
            Parameters<
              typeof dispatchChannelInboundReply
            >[0]["dispatchReplyWithBufferedBlockDispatcher"]
          >[0],
        ) => {
          dispatched = true;
          expect(params.replyOptions).not.toHaveProperty("internalEventExecution");
          expect(params.replyOptions).not.toHaveProperty("onReplyOperationOwned");
          expect(params.replyOptions?.isHeartbeat).toBe(true);
          return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
        },
      };
      const result =
        surface === "assembled"
          ? await dispatchChannelInboundReply(turn)
          : await runChannelInboundEvent({
              channel: "test",
              raw: "hello",
              adapter: {
                ingest: () => ({ id: "event-1", rawText: "hello" }),
                resolveTurn: async () => turn,
              },
            });
      expect(result.dispatched).toBe(true);
      expect(dispatched).toBe(true);
      expect(replyOptions.onReplyOperationOwned).toBe(callback);
    },
  );

  it("preserves frozen class adapter receivers while stripping event custody", async () => {
    const calls: string[] = [];
    const callback = vi.fn();
    const replyOptions = {
      isHeartbeat: true,
      internalEventExecution: { onStarted: callback },
      onReplyOperationOwned: callback,
    };
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
      dispatchReplyWithBufferedBlockDispatcher: async (
        params: Parameters<
          Parameters<
            typeof dispatchChannelInboundReply
          >[0]["dispatchReplyWithBufferedBlockDispatcher"]
        >[0],
      ) => {
        calls.push("dispatch");
        expect(params.replyOptions).not.toHaveProperty("internalEventExecution");
        expect(params.replyOptions).not.toHaveProperty("onReplyOperationOwned");
        expect(params.replyOptions?.isHeartbeat).toBe(true);
        return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
      },
    };
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
    expect(calls).toEqual(["ingest", "classify", "preflight", "resolve", "dispatch", "finalize"]);
    expect(replyOptions.internalEventExecution.onStarted).toBe(callback);
    expect(replyOptions.onReplyOperationOwned).toBe(callback);
    expect(callback).not.toHaveBeenCalled();
  });

  it("runs a lifecycle-less prepared turn through the published entry point", async () => {
    const events: string[] = [];
    const result = await runChannelInboundEvent({
      channel: "test",
      raw: { id: "msg-1", text: "hello" },
      adapter: {
        ingest: () => ({ id: "msg-1", rawText: "hello" }),
        resolveTurn: () => {
          const turn = {
            channel: "test",
            routeSessionKey: "agent:main:test:peer",
            storePath: "unused",
            ctxPayload: {
              Body: "hello",
              CommandAuthorized: false,
              SessionKey: "agent:main:test:peer",
            },
            recordInboundSession: async () => {
              events.push("record");
            },
            runDispatch: async () => {
              events.push("dispatch");
              return {
                queuedFinal: true,
                counts: { tool: 0, block: 0, final: 1 },
              };
            },
            runDispatchLifecycle: {
              turnAdoptionLifecycle: undefined,
              onDispatchSkipped: vi.fn(),
            },
          };
          // Model a plugin compiled before the required inbound lifecycle field existed.
          Object.defineProperty(turn, "runDispatchLifecycle", { value: undefined });
          return turn;
        },
      },
    });

    expect(events).toEqual(["record", "dispatch"]);
    expect(result.dispatched).toBe(true);
  });

  it("dispatches a published inbound event before automatic session maintenance", async () => {
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

    const result = await runChannelInboundEvent({
      channel: "test",
      raw: { id: "msg-1", text: "hello" },
      adapter: {
        ingest: () => ({ id: "msg-1", rawText: "hello" }),
        resolveTurn: () => ({
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
        }),
      },
    });

    expect(result.dispatched).toBe(true);
    expect(staleEntryAtDispatch).toMatchObject({ sessionId: "published-inbound-stale" });
    expect(staleEntryAtDispatch?.archivedAt).toBeUndefined();
    await maintenanceCommitted.promise;
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

  it("accepts plugin-augmented hook channel sender fields", () => {
    expectTypeOf<PluginHookChannelSenderContext["testUnionId"]>().toEqualTypeOf<
      string | undefined
    >();
    const sender = {
      id: "u1",
      testUnionId: "union-1",
    } satisfies PluginHookChannelSenderContext;
    expect(sender.testUnionId).toBe("union-1");
    const channelContext = {
      sender: {
        id: "u1",
        testUnionId: "union-1",
      },
    } satisfies NonNullable<BuildChannelInboundEventContextParams["channelContext"]>;
    const ctx = buildChannelInboundEventContext(
      createInboundParams({
        channelContext,
      }),
    );

    expect(ctx.ChannelContext?.sender?.testUnionId).toBe("union-1");
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
      message: {
        rawBody: "hello",
        inboundTurnKind: "user_request",
      },
    });

    expect(ctx.InboundTurnKind).toBe("user_request");
    expect(readChannelContextAdmissionEvidence(ctx)).toBeUndefined();
  });
});
