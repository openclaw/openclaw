import { afterEach, describe, expect, it, vi } from "vitest";
import { heartbeatRunnerTelegramPlugin } from "../../test/helpers/infra/heartbeat-runner-channel-plugins.js";
import type { EmbeddedAgentRunResult } from "../agents/embedded-agent-runner/types.js";
import { GENERIC_EXTERNAL_RUN_FAILURE_TEXT } from "../agents/failover/user-copy.js";
import { dispatchInboundMessageWithDispatcher } from "../auto-reply/dispatch.js";
import { createHeartbeatToolResponsePayload } from "../auto-reply/heartbeat-tool-response.js";
import { DEFAULT_HEARTBEAT_ACK_MAX_CHARS, stripHeartbeatToken } from "../auto-reply/heartbeat.js";
import { setReplyPayloadMetadata, type ReplyPayload } from "../auto-reply/reply-payload.js";
import {
  buildRecoverablePendingFinalDeliveryText,
  normalizePendingFinalRecoveryPayloads,
} from "../auto-reply/reply/pending-final-delivery.js";
import {
  recordReplyOperationAgentTurn,
  resolveReplyOperationRunState,
} from "../auto-reply/reply/reply-operation-run-state.js";
import { createReplyOperation } from "../auto-reply/reply/reply-run-registry.js";
import type { OpenClawConfig } from "../config/config.js";
import {
  listSessionEntriesReadOnly,
  loadExactSessionEntryReadOnly,
  loadSessionEntry,
  patchSessionEntryCore,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../plugins/hook-runner-global.js";
import { addTestHook } from "../plugins/hooks.test-helpers.js";
import { getActivePluginRegistry, setActivePluginRegistry } from "../plugins/runtime.js";
import type { PluginHookReplyDispatchContext } from "../plugins/types.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import { normalizeSessionDeliveryState } from "../utils/delivery-context.shared.js";
import { getLastHeartbeatEvent, resetHeartbeatEventsForTest } from "./heartbeat-events.js";
import { claimHeartbeatOutcomeForRun } from "./heartbeat-outcome-store.js";
import { runHeartbeatOnce, type HeartbeatDeps } from "./heartbeat-runner.js";
import { installHeartbeatRunnerTestRuntime } from "./heartbeat-runner.test-harness.js";
import {
  heartbeatTestConfig,
  readSessionStoreForTest,
  seedMainSessionStore,
  seedSessionStore,
  setHeartbeatAgentTurnStatus,
  type HeartbeatReplySpy,
  withTempHeartbeatSandbox,
  withTempTelegramHeartbeatSandbox,
} from "./heartbeat-runner.test-utils.js";
import { PlatformMessageNotDispatchedError } from "./outbound/deliver-types.js";
import { loadPendingDeliveries } from "./outbound/delivery-queue.test-helpers.js";
import { enqueueSystemEvent, peekSystemEvents, resetSystemEventsForTest } from "./system-events.js";

installHeartbeatRunnerTestRuntime();

type Fixture = {
  cfg: OpenClawConfig;
  send: ReturnType<typeof vi.fn>;
  replySpy: HeartbeatReplySpy;
  storePath: string;
  sessionKey: string;
  now: number;
  previousUpdatedAt: number;
  run: (deps?: Partial<HeartbeatDeps>, reason?: string) => ReturnType<typeof runHeartbeatOnce>;
};

async function withHeartbeat<T>(
  test: (fixture: Fixture) => Promise<T>,
  options: {
    telegram?: boolean;
    showOk?: boolean;
    responsePrefix?: string;
    accountId?: string;
    threadId?: string;
    isolatedSession?: boolean;
    previousActivity?: boolean;
  } = {},
) {
  return withTempHeartbeatSandbox(
    async ({ tmpDir, storePath, replySpy }) => {
      const channel = options.telegram ? "telegram" : "whatsapp";
      const cfg = heartbeatTestConfig(tmpDir, channel, channel, storePath);
      cfg.agents!.defaults!.heartbeat!.accountId = options.accountId;
      cfg.agents!.defaults!.heartbeat!.isolatedSession = options.isolatedSession;
      cfg.channels = {
        [channel]: {
          allowFrom: ["*"],
          heartbeatVisibility: { showOk: options.showOk ?? false },
          responsePrefix: options.responsePrefix,
          ...(options.telegram ? { accounts: { work: { botToken: "test-token" } } } : {}),
        },
      };
      const now = Date.now();
      const previousUpdatedAt = options.previousActivity ? now - 60_000 : now;
      if (options.previousActivity) {
        cfg.messages = { visibleReplies: "automatic" };
      }
      const sessionKey = await seedMainSessionStore(storePath, cfg, {
        updatedAt: previousUpdatedAt,
        lastChannel: channel,
        lastProvider: channel,
        lastTo: options.telegram ? "-1001234567890" : "120363140186826074@g.us",
        lastThreadId: options.threadId,
      });
      const send = vi.fn().mockResolvedValue({ messageId: "m1", toJid: "jid" });
      const run: Fixture["run"] = (deps, reason) =>
        runHeartbeatOnce({
          cfg,
          reason,
          deps: {
            [channel]: send,
            getReplyFromConfig: replySpy,
            getQueueSize: () => 0,
            nowMs: () => (options.previousActivity ? now : 0),
            webAuthExists: async () => true,
            hasActiveWebListener: () => true,
            ...deps,
          },
        });
      return await test({
        cfg,
        send,
        replySpy,
        storePath,
        sessionKey,
        now,
        previousUpdatedAt,
        run,
      });
    },
    { unsetEnvVars: ["TELEGRAM_BOT_TOKEN"] },
  );
}

function enqueueCompletion(sessionKey: string) {
  enqueueSystemEvent("Exec completed (heartbeat-test, code 0) :: uploaded report.txt", {
    sessionKey,
    contextKey: "exec:heartbeat-test",
  });
}

describe("heartbeat acknowledgements", () => {
  it.each<{
    name: string;
    payload: ReplyPayload;
    options?: Parameters<typeof withHeartbeat>[1];
    exec?: boolean;
    sends: number;
    sentText?: string;
  }>([
    {
      name: "canonical NO_REPLY acknowledgement",
      payload: { text: "NO_REPLY" },
      options: { showOk: true },
      sends: 1,
      sentText: "HEARTBEAT_OK",
    },
    {
      name: "complete response prefix",
      payload: { text: "[openclaw] HEARTBEAT_OK all good" },
      options: { telegram: true, responsePrefix: "[openclaw]" },
      sends: 0,
    },
    {
      name: "partial response prefix",
      payload: { text: "History check complete" },
      options: { telegram: true, responsePrefix: "Hi" },
      sends: 1,
      sentText: "History check complete",
    },
    { name: "quiet exec completion", payload: { text: "NO_REPLY" }, exec: true, sends: 0 },
    {
      name: "exec summary with trailing acknowledgement",
      payload: { text: "Command completed: uploaded report.txt\nHEARTBEAT_OK" },
      exec: true,
      sends: 1,
      sentText: "Command completed: uploaded report.txt",
    },
    {
      name: "exec acknowledgement with media",
      payload: {
        text: "HEARTBEAT_OK",
        mediaUrl: "https://example.test/report.png",
        presentation: { blocks: [{ type: "text", text: "Report uploaded." }] },
      },
      exec: true,
      sends: 1,
    },
    {
      name: "explicit Telegram account",
      payload: { text: "Hello from heartbeat" },
      options: { telegram: true, accountId: "work" },
      sends: 1,
      sentText: "Hello from heartbeat",
    },
  ])("applies delivery policy to $name", async ({ payload, options, exec, sends, sentText }) => {
    await withHeartbeat(async ({ send, replySpy, sessionKey, run }) => {
      if (exec) {
        enqueueCompletion(sessionKey);
      }
      replySpy.mockResolvedValue(payload);
      expect((await run({}, exec ? "exec-event" : undefined)).status).toBe("ran");
      expect(send).toHaveBeenCalledTimes(sends);
      if (sentText) {
        expect(send.mock.calls[0]?.slice(0, 2)).toEqual([
          options?.telegram ? "-1001234567890" : "120363140186826074@g.us",
          sentText,
        ]);
      }
      if (options?.accountId) {
        expect(send.mock.calls[0]).toEqual([
          "-1001234567890",
          sentText,
          expect.objectContaining({ accountId: "work", verbose: false }),
        ]);
      }
      if (exec) {
        expect(peekSystemEvents(sessionKey)).toEqual([]);
      }
    }, options);
  });

  it.each(["hook", "delivery", "readiness"] as const)(
    "reports an acknowledgement as silent after %s failure",
    async (failure) => {
      await withHeartbeat(
        async ({ send, replySpy, run }) => {
          if (failure === "hook") {
            const registry = getActivePluginRegistry();
            if (!registry) {
              throw new Error("Expected heartbeat plugin registry");
            }
            addTestHook({
              registry,
              pluginId: "heartbeat-test-suppression",
              hookName: "message_sending",
              handler: () => ({ cancel: true }),
            });
            initializeGlobalHookRunner(registry);
          } else if (failure === "delivery") {
            send.mockRejectedValue(new Error("delivery unavailable"));
          }
          try {
            replySpy.mockResolvedValue({ text: "HEARTBEAT_OK" });
            const deps =
              failure === "readiness"
                ? {
                    webAuthExists: async () => {
                      throw new Error("readiness unavailable");
                    },
                  }
                : undefined;
            expect((await run(deps)).status).toBe("ran");
            expect(send).toHaveBeenCalledTimes(failure === "delivery" ? 1 : 0);
            expect(getLastHeartbeatEvent()).toMatchObject({ status: "ok-token", silent: true });
          } finally {
            if (failure === "hook") {
              resetGlobalHookRunner();
            }
          }
        },
        { telegram: failure === "delivery", showOk: true },
      );
    },
  );

  it("skips the model when visibility disables every output", async () => {
    await withHeartbeat(async ({ cfg, send, replySpy, run }) => {
      cfg.channels!.whatsapp!.heartbeatVisibility = {
        showOk: false,
        showAlerts: false,
        useIndicator: false,
      };
      expect(await run()).toEqual({ status: "skipped", reason: "alerts-disabled" });
      expect(replySpy).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
    });
  });

  it("preserves activity recorded during a quiet heartbeat", async () => {
    await withHeartbeat(async ({ storePath, sessionKey, replySpy, run }) => {
      await seedSessionStore(storePath, sessionKey, {
        ...readSessionStoreForTest(storePath)[sessionKey],
        updatedAt: 1000,
      });
      replySpy.mockImplementationOnce(async () => {
        await seedSessionStore(storePath, sessionKey, {
          ...readSessionStoreForTest(storePath)[sessionKey],
          updatedAt: 2000,
        });
        return { text: "" };
      });
      await run();
      expect(readSessionStoreForTest<{ updatedAt: number }>(storePath)[sessionKey]?.updatedAt).toBe(
        2000,
      );
    });
  });

  it("defers delivery when WhatsApp is not linked", async () => {
    await withHeartbeat(async ({ send, replySpy, run }) => {
      replySpy.mockResolvedValue({ text: "Heartbeat alert" });
      expect(
        await run({ webAuthExists: async () => false, hasActiveWebListener: () => false }),
      ).toMatchObject({ status: "skipped", reason: "channel-not-ready" });
      expect(getLastHeartbeatEvent()).toMatchObject({ reason: "whatsapp-not-linked" });
      expect(send).not.toHaveBeenCalled();
    });
  });
});

const target = "-1001234567890";

async function runCommittedWork(params: {
  result: Partial<EmbeddedAgentRunResult>;
  showOk?: boolean;
  status?: "ok" | "failed" | "cancelled" | "superseded";
  failAfterSettlement?: boolean;
  threadId?: string;
}) {
  return withHeartbeat(
    async ({ cfg, replySpy, send, run }) => {
      cfg.messages = { visibleReplies: "automatic" };
      cfg.channels!.telegram = {
        botToken: "test-token",
        allowFrom: ["*"],
        heartbeat: { showOk: params.showOk ?? false },
      };
      replySpy.mockImplementation(async (_ctx, opts) => {
        const state = resolveReplyOperationRunState(opts);
        if (!state) {
          throw new Error("Heartbeat invocation state missing");
        }
        const owner = createReplyOperation({
          sessionKey: "heartbeat-committed-work",
          sessionId: "heartbeat-committed-work",
          turnKind: "heartbeat",
          resetTriggered: false,
        });
        recordReplyOperationAgentTurn([state], owner, {
          kind: "settled",
          status: "ok",
          result: params.result,
        });
        if (params.failAfterSettlement) {
          recordReplyOperationAgentTurn([state], owner);
        }
        owner.complete();
        if (params.status) {
          setHeartbeatAgentTurnStatus(opts, params.status);
        }
        return { text: "NO_REPLY" };
      });
      const result = await run();
      return { result, event: getLastHeartbeatEvent(), send };
    },
    { telegram: true, threadId: params.threadId },
  );
}

describe("heartbeat committed work bookkeeping", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetHeartbeatEventsForTest();
    resetSystemEventsForTest();
  });

  const sentTarget = { tool: "message", provider: "telegram", to: target, text: "Delivered alert" };

  it.each<{
    name: string;
    params: Parameters<typeof runCommittedWork>[0];
    event: Partial<NonNullable<ReturnType<typeof getLastHeartbeatEvent>>>;
    result?: { status: string; reason?: string };
  }>([
    {
      name: "confirmed media send",
      params: {
        showOk: true,
        result: {
          messagingToolSentTargets: [
            { ...sentTarget, mediaUrls: ["https://example.com/chart.png"] },
          ],
        },
      },
      event: { status: "sent", silent: false, preview: "Delivered alert", hasMedia: true },
    },
    ...[
      { name: "recipient", route: { to: "-1009999999999" } },
      { name: "account", route: { accountId: "other" } },
      { name: "topic", route: { threadId: "8" } },
    ].map(({ name, route }) => ({
      name: `unrelated ${name}`,
      params: {
        threadId: "7",
        result: {
          messagingToolSentTargets: [
            { ...sentTarget, accountId: "default", threadId: "7", ...route },
          ],
        },
      },
      event: { status: "ok-token" as const, silent: true },
    })),
    {
      name: "accepted child",
      params: {
        showOk: true,
        result: {
          acceptedSessionSpawns: [
            {
              runId: "child",
              childSessionKey: "agent:main:subagent:child",
              expectsCompletionMessage: true,
            },
          ],
        },
      },
      event: { status: "skipped", reason: "background-work", silent: true },
    },
    ...(["cancelled", "superseded"] as const).map((status) => ({
      name: status,
      params: { status, result: { messagingToolSentTargets: [sentTarget] } },
      result: {
        status: "skipped",
        reason: status === "cancelled" ? "agent-runner-cancelled" : "preempted",
      },
      event: { status: "skipped" as const },
    })),
    {
      name: "failure after settlement",
      params: { failAfterSettlement: true, result: { messagingToolSentTargets: [sentTarget] } },
      result: { status: "failed" },
      event: { status: "failed", silent: false },
    },
  ])(
    "retains the committed outcome for $name without another acknowledgement",
    async (expected) => {
      const { event, send, result } = await runCommittedWork(expected.params);
      expect(event).toMatchObject(expected.event);
      expect(send).not.toHaveBeenCalled();
      if (expected.result) {
        expect(result).toMatchObject(expected.result);
      }
    },
  );
});

describe("heartbeat pending-final delivery ownership", () => {
  afterEach(() => {
    resetHeartbeatEventsForTest();
    resetSystemEventsForTest();
  });

  function readEntry(storePath: string, sessionKey: string) {
    return readSessionStoreForTest<SessionEntry>(storePath)[sessionKey];
  }

  // Seed producer-owned custody; the real transport and finalizer must settle it.
  async function prepareFinal(storePath: string, sessionKey: string, payload: ReplyPayload) {
    const entry = loadSessionEntry({ storePath, sessionKey });
    if (!entry) {
      throw new Error("Expected heartbeat execution session");
    }
    const intentId = "heartbeat-intent";
    const deliveryId = "heartbeat-delivery";
    const recoveryText = buildRecoverablePendingFinalDeliveryText(
      normalizePendingFinalRecoveryPayloads([payload]),
    );
    const stripped = stripHeartbeatToken(recoveryText ?? "", {
      mode: "heartbeat",
      maxAckChars: DEFAULT_HEARTBEAT_ACK_MAX_CHARS,
    });
    const pendingText = stripped.shouldSkip ? "" : stripped.text;
    await patchSessionEntryCore(
      { storePath, sessionKey },
      () => ({
        pendingFinalDelivery: {
          ...(pendingText
            ? { kind: "replayable" as const, text: pendingText }
            : { kind: "transport-only" as const }),
          createdAt: Date.now(),
          intentId,
          deliveries: [{ id: deliveryId, state: "prepared" }],
        },
      }),
      { preserveActivity: true },
    );
    return setReplyPayloadMetadata(payload, {
      pendingFinalDeliveryCompletion: {
        deliveryId,
        intentId,
        sessionId: entry.sessionId,
        sessionKey,
        storePath,
      },
    });
  }

  it.each([
    {
      name: "plain reply",
      payload: { text: "Heartbeat update." },
      visibleText: "Heartbeat update.",
    },
    {
      name: "visible tool reply",
      payload: createHeartbeatToolResponsePayload({
        outcome: "needs_attention",
        notify: true,
        summary: "Build blocked.",
        notificationText: "Build needs credentials.",
      }),
      visibleText: "Build needs credentials.",
    },
    { name: "acknowledgement", payload: { text: "HEARTBEAT_OK" }, visibleText: undefined },
    {
      name: "quiet tool reply",
      payload: createHeartbeatToolResponsePayload({
        outcome: "no_change",
        notify: false,
        summary: "Nothing needs attention.",
      }),
      visibleText: undefined,
    },
  ])(
    "settles an isolated $name without clearing the base user's pending final",
    async ({ payload, visibleText }) => {
      await withHeartbeat(
        async ({ storePath, replySpy, sessionKey, send, now, previousUpdatedAt, run }) => {
          const unrelatedFinal = {
            kind: "replayable" as const,
            text: "User final awaiting confirmation",
            createdAt: now,
            intentId: "base-user-intent",
            deliveries: [{ id: "base-user-delivery", state: "unknown" as const }],
          };
          let executionKey = "";
          replySpy.mockImplementation(async (ctx) => {
            executionKey = ctx.SessionKey!;
            await patchSessionEntryCore(
              { storePath, sessionKey },
              () => ({ pendingFinalDelivery: unrelatedFinal }),
              { preserveActivity: true },
            );
            return prepareFinal(storePath, executionKey, payload);
          });
          expect((await run()).status).toBe("ran");
          expect(send).toHaveBeenCalledTimes(visibleText ? 1 : 0);
          if (visibleText) {
            expect(send.mock.calls[0]?.[1]).toBe(visibleText);
          }
          expect(executionKey).not.toBe(sessionKey);
          expect(readEntry(storePath, executionKey)?.pendingFinalDelivery).toBeUndefined();
          const baseEntry = readEntry(storePath, sessionKey);
          expect(baseEntry?.lastHeartbeatText).toBe(visibleText);
          expect(baseEntry?.lastHeartbeatSentAt).toBe(visibleText ? now : undefined);
          expect(baseEntry).toMatchObject({
            updatedAt: previousUpdatedAt,
            pendingFinalDelivery: unrelatedFinal,
          });
        },
        { telegram: true, previousActivity: true, isolatedSession: true },
      );
    },
  );

  it("preserves an unowned duplicate final even when its timestamp matches the run", async () => {
    await withHeartbeat(
      async ({ storePath, replySpy, sessionKey, send, now, previousUpdatedAt, run }) => {
        const body = "Recurring heartbeat status line.";
        const pendingFinalDelivery = {
          kind: "replayable" as const,
          text: "A different final still awaiting delivery",
          createdAt: now,
          intentId: "unowned-intent",
          deliveries: [{ id: "unowned-delivery", state: "unknown" as const }],
        };
        await patchSessionEntryCore(
          { storePath, sessionKey },
          () => ({ lastHeartbeatText: body, lastHeartbeatSentAt: previousUpdatedAt }),
          { preserveActivity: true },
        );
        replySpy.mockImplementation(async () => {
          await patchSessionEntryCore({ storePath, sessionKey }, () => ({ pendingFinalDelivery }), {
            preserveActivity: true,
          });
          return { text: body };
        });
        expect((await run()).status).toBe("ran");
        expect(send).not.toHaveBeenCalled();
        expect(readEntry(storePath, sessionKey)).toMatchObject({
          pendingFinalDelivery,
          lastHeartbeatText: body,
          updatedAt: previousUpdatedAt,
        });
      },
      { telegram: true, previousActivity: true },
    );
  });
});

describe("runHeartbeatOnce failure delivery", () => {
  afterEach(() => {
    resetHeartbeatEventsForTest();
    resetSystemEventsForTest();
  });

  function expectTelegramSend(send: ReturnType<typeof vi.fn>, text: string) {
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]?.slice(0, 2)).toEqual(["-1001234567890", text]);
  }

  it.each([
    {
      name: "clears an exact pending-final warning after delivering it",
      sibling: false,
      failure: "none",
      notify: true,
    },
    {
      name: "retains queued custody after a proven no-send failure",
      sibling: false,
      failure: "not-sent",
      notify: true,
    },
    {
      name: "retains durable queue custody and ambiguity after a transport failure",
      sibling: false,
      failure: "ambiguous",
      notify: true,
    },
    {
      name: "suppresses a quiet warning without retiring unrelated pending content",
      sibling: true,
      failure: "none",
      notify: false,
    },
    {
      name: "retires a quiet warning so recovery cannot deliver it later",
      sibling: false,
      failure: "none",
      notify: false,
    },
  ])("$name", async ({ sibling, failure, notify }) => {
    const fail = failure !== "none";
    await withHeartbeat(
      async ({ storePath, replySpy, sessionKey, send: sendTelegram, run }) => {
        const warning = "⚠️ Message failed";
        const pendingText = sibling ? `Original exec completion\n\n${warning}` : warning;
        replySpy.mockImplementation(async () => {
          const entry = readSessionStoreForTest<SessionEntry>(storePath)[sessionKey];
          if (!entry) {
            throw new Error("Expected heartbeat execution session");
          }
          await patchSessionEntryCore(
            { storePath, sessionKey },
            () => ({
              pendingFinalDelivery: {
                kind: "replayable",
                text: pendingText,
                createdAt: Date.now(),
                intentId: "warning-intent",
                deliveries: [
                  ...(sibling ? [{ id: "original-delivery", state: "prepared" as const }] : []),
                  { id: "warning-delivery", state: "prepared" },
                ],
              },
            }),
            { preserveActivity: true },
          );
          const metadata = { heartbeatTerminalToolFailure: { toolName: "message" } };
          const replies = [
            setReplyPayloadMetadata(
              createHeartbeatToolResponsePayload({
                outcome: fail ? "blocked" : "no_change",
                notify,
                summary: "Message delivery was denied.",
              }),
              metadata,
            ),
            setReplyPayloadMetadata({ text: warning, isError: true }, metadata),
          ];
          setReplyPayloadMetadata(replies[1]!, {
            pendingFinalDeliveryCompletion: {
              deliveryId: "warning-delivery",
              intentId: "warning-intent",
              sessionId: entry.sessionId,
              sessionKey,
              storePath,
            },
          });
          return replies;
        });
        if (fail) {
          sendTelegram.mockRejectedValue(
            failure === "not-sent"
              ? new PlatformMessageNotDispatchedError("channel unavailable before dispatch", {
                  cause: new Error("offline"),
                })
              : new Error("channel send result unavailable"),
          );
        }

        await expect(run()).resolves.toEqual({
          status: "failed",
          reason: "agent-tool-failure",
        });

        const sessionStore = readSessionStoreForTest<SessionEntry>(storePath);
        if (notify) {
          expectTelegramSend(sendTelegram, warning);
        } else {
          expect(sendTelegram).not.toHaveBeenCalled();
          expect(await loadPendingDeliveries()).toHaveLength(0);
        }
        if (fail) {
          expect(sessionStore[sessionKey]?.pendingFinalDelivery).toMatchObject({
            intentId: "warning-intent",
            deliveries: [{ id: "warning-delivery", state: "queued" }],
          });
          const queued = await loadPendingDeliveries();
          expect(queued).toHaveLength(1);
          expect(queued[0]?.deliveryCompletion).toMatchObject({
            kind: "pending-final",
            deliveryId: "warning-delivery",
            intentId: "warning-intent",
            sessionKey,
            storePath,
          });
          expect(queued[0]?.recoveryState).toBe(
            failure === "not-sent" ? undefined : "send_attempt_started",
          );
          expect(getLastHeartbeatEvent()).toMatchObject({
            status: "failed",
            reason: "agent-tool-failure",
            silent: true,
          });
        } else if (sibling) {
          expect(sessionStore[sessionKey]?.pendingFinalDelivery).toMatchObject({
            kind: "replayable",
            text: pendingText,
            deliveries: [
              { id: "original-delivery", state: "prepared" },
              { id: "warning-delivery", state: "suppressed" },
            ],
          });
        } else {
          expect(sessionStore[sessionKey]?.pendingFinalDelivery).toBeUndefined();
        }
      },
      { telegram: true },
    );
  });

  it.each(["agent-runner-failure"] as const)(
    "preserves %s when channel readiness throws",
    async (reason) => {
      await withHeartbeat(
        async ({ replySpy, send: sendTelegram, run }) => {
          setActivePluginRegistry(
            createTestRegistry([
              {
                pluginId: "telegram",
                source: "test",
                plugin: {
                  ...heartbeatRunnerTelegramPlugin,
                  heartbeat: {
                    checkReady: async () => {
                      throw new Error("readiness probe failed");
                    },
                  },
                },
              },
            ]),
          );
          replySpy.mockImplementation(async (_ctx, options) => {
            setHeartbeatAgentTurnStatus(options, "failed");
            return { text: GENERIC_EXTERNAL_RUN_FAILURE_TEXT, isError: true };
          });
          expect(await run()).toEqual({
            status: "failed",
            reason,
          });
          expect(sendTelegram).not.toHaveBeenCalled();
          expect(getLastHeartbeatEvent()).toMatchObject({ status: "failed", reason, silent: true });
        },
        { telegram: true },
      );
    },
  );

  it("preserves media when delivering a plain terminal failure reply", async () => {
    await withHeartbeat(
      async ({ replySpy, send: sendTelegram, run }) => {
        const mediaUrl = "https://example.test/failure.png";
        replySpy.mockResolvedValue(
          setReplyPayloadMetadata(
            { text: "Message delivery failed.", mediaUrl },
            { heartbeatTerminalToolFailure: { toolName: "message" } },
          ),
        );

        await expect(run()).resolves.toEqual({
          status: "failed",
          reason: "agent-tool-failure",
        });
        expect(sendTelegram).toHaveBeenCalledOnce();
        expect(sendTelegram.mock.calls[0]?.[2]).toMatchObject({ mediaUrl });
      },
      { telegram: true },
    );
  });
});

describe("heartbeat inbound hook boundary", () => {
  afterEach(resetGlobalHookRunner);
  it.each(["before_dispatch", "reply_dispatch"] as const)(
    "keeps %s takeover on user turns and outside monitoring policy",
    async (hookName) => {
      await withTempTelegramHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
        const cfg = heartbeatTestConfig(tmpDir, "telegram", "telegram", storePath);
        cfg.messages = { visibleReplies: "automatic" };
        cfg.channels = { telegram: { enabled: true, botToken: "test", allowFrom: ["owner"] } };
        const sessionKey = await seedMainSessionStore(storePath, cfg, {
          lastChannel: "telegram",
          lastProvider: "telegram",
          lastTo: "owner",
        });
        const registry = getActivePluginRegistry();
        if (!registry) {
          throw new Error("Expected channel registry");
        }
        const handler =
          hookName === "before_dispatch"
            ? vi.fn(async () => ({ handled: true, text: "Channel takeover" }))
            : vi.fn(async (_event: unknown, context: PluginHookReplyDispatchContext) => {
                context.dispatcher.sendFinalReply({ text: "Channel takeover" });
                return {
                  handled: true,
                  queuedFinal: true,
                  counts: context.dispatcher.getQueuedCounts(),
                };
              });
        addTestHook({
          registry,
          pluginId: "channel-hook-fixture",
          hookName,
          handler,
        });
        initializeGlobalHookRunner(registry);
        replySpy.mockResolvedValue(
          createHeartbeatToolResponsePayload({
            outcome: "no_change",
            notify: false,
            summary: "Nothing to report",
          }),
        );
        const sendTelegram = vi.fn().mockResolvedValue({ messageId: "unexpected-monitor-send" });
        await expect(
          runHeartbeatOnce({
            cfg,
            deps: { getReplyFromConfig: replySpy, telegram: sendTelegram, getQueueSize: () => 0 },
          }),
        ).resolves.toMatchObject({ status: "ran" });
        expect(handler).not.toHaveBeenCalled();
        expect(replySpy).toHaveBeenCalledOnce();
        expect(sendTelegram).not.toHaveBeenCalled();
        replySpy.mockClear();
        const deliver = vi.fn(async () => ({ visibleReplySent: true }));
        await dispatchInboundMessageWithDispatcher({
          cfg,
          ctx: {
            Body: "User request",
            Provider: "telegram",
            Surface: "telegram",
            From: "owner",
            To: "owner",
            OriginatingChannel: "telegram",
            OriginatingTo: "owner",
            SessionKey: sessionKey,
            AgentId: "main",
            ChatType: "direct",
            CommandAuthorized: true,
          },
          replyResolver: replySpy,
          dispatcherOptions: { deliver },
        });
        expect(handler).toHaveBeenCalledOnce();
        expect(replySpy).not.toHaveBeenCalled();
        expect(deliver).toHaveBeenCalledWith(
          expect.objectContaining({ text: "Channel takeover" }),
          expect.anything(),
        );
      });
    },
  );
});

describe("heartbeat next-user outcomes", () => {
  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    resetSystemEventsForTest();
  });

  it.each([
    { sessionKey: "agent:ops:main", runKey: "agent:ops:main:heartbeat", isolatedSession: true },
    { sessionKey: "global", runKey: "global", isolatedSession: false },
  ])(
    "retains the next-user outcome in the owning agent store: $runKey",
    async ({ sessionKey, runKey, isolatedSession }) => {
      await withTempTelegramHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
        const scope = { agentId: "ops", storePath, sessionKey };
        const mainScope = { agentId: "main", storePath };
        const readEntry = (key: string) =>
          loadExactSessionEntryReadOnly({ ...scope, sessionKey: key })?.entry;
        const cfg: OpenClawConfig = {
          agents: {
            entries: { main: {}, ops: {} },
            defaults: {
              workspace: tmpDir,
              heartbeat: {
                every: "5m",
                isolatedSession,
                session: sessionKey,
                target: "telegram",
                to: "12345",
              },
            },
          },
          messages: { visibleReplies: "message_tool" },
          channels: { telegram: { enabled: true, botToken: "test", allowFrom: ["*"] } },
          session: { store: storePath, ...(!isolatedSession ? { scope: "global" } : {}) },
        };
        if (!isolatedSession) {
          await replaceSessionEntry(scope, {
            sessionId: "existing-user-session",
            updatedAt: Date.now(),
          });
        } else {
          expect(readEntry(sessionKey)).toBeUndefined();
        }
        await replaceSessionEntry(
          { ...mainScope, sessionKey: "global" },
          {
            sessionId: "unrelated-main-global",
            updatedAt: Date.now(),
            delivery: normalizeSessionDeliveryState({
              context: { channel: "telegram", to: "-10099999" },
            }),
          },
        );
        const initialMainEntries = listSessionEntriesReadOnly(mainScope);
        const summary = `Quiet work completed in ${runKey}`;
        replySpy.mockResolvedValue(
          createHeartbeatToolResponsePayload({ outcome: "done", notify: false, summary }),
        );
        const sendTelegram = vi.fn();
        expect(
          await runHeartbeatOnce({
            cfg,
            agentId: "ops",
            sessionKey,
            deps: { getReplyFromConfig: replySpy, telegram: sendTelegram, getQueueSize: () => 0 },
          }),
        ).toMatchObject({ status: "ran" });
        expect(sendTelegram).not.toHaveBeenCalled();
        expect(readEntry(sessionKey)?.sessionId).toBeTruthy();
        if (isolatedSession) {
          expect(readEntry(sessionKey)?.sessionId).not.toBe(readEntry(runKey)?.sessionId);
          expect(readEntry(runKey)?.heartbeatIsolatedBaseSessionKey).toBe(sessionKey);
        } else {
          expect(readEntry(sessionKey)?.sessionId).toBe("existing-user-session");
        }
        const params = { ...scope, runId: "first-user-run" };
        expect(await claimHeartbeatOutcomeForRun(params)).toMatchObject({
          sessionKey,
          runSessionKey: runKey,
          summary,
        });
        expect(await claimHeartbeatOutcomeForRun(params)).toBeDefined();
        expect(
          await claimHeartbeatOutcomeForRun({ ...params, runId: "second-user-run" }),
        ).toBeUndefined();
        expect(listSessionEntriesReadOnly(mainScope)).toEqual(initialMainEntries);
      });
    },
  );
});
