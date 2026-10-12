import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { heartbeatRunnerTelegramPlugin } from "../../test/helpers/infra/heartbeat-runner-channel-plugins.js";
import { createHeartbeatToolResponsePayload } from "../auto-reply/heartbeat-tool-response.js";
import { setReplyPayloadMetadata } from "../auto-reply/reply-payload.js";
import type { InternalGetReplyFromConfig } from "../auto-reply/reply/get-reply.types.js";
import { finalizeInboundContext } from "../auto-reply/reply/inbound-context.js";
import { initSessionState } from "../auto-reply/reply/session.js";
import type { OpenClawConfig } from "../config/config.js";
import {
  patchSessionEntryCore,
  replaceSessionEntrySync,
} from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../plugins/hook-runner-global.js";
import { addTestHook } from "../plugins/hooks.test-helpers.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawAgentDatabasesAsync } from "../state/openclaw-agent-db.js";
import { createOutboundTestPlugin, createTestRegistry } from "../test-utils/channel-plugins.js";
import { getLastHeartbeatEvent, resetHeartbeatEventsForTest } from "./heartbeat-events.js";
import * as heartbeatOutcomeStore from "./heartbeat-outcome-store.js";
import { runHeartbeatOnce, type HeartbeatDeps } from "./heartbeat-runner.js";
import { installHeartbeatRunnerTestRuntime } from "./heartbeat-runner.test-harness.js";
import {
  type HeartbeatReplySpy,
  readSessionStoreForTest,
  seedMainSessionStore,
  withTempTelegramHeartbeatSandbox,
} from "./heartbeat-runner.test-utils.js";
import { isRetryableHeartbeatSkipReason } from "./heartbeat-wake.js";
import { resetSystemEventsForTest } from "./system-events.js";

installHeartbeatRunnerTestRuntime();
const TELEGRAM_GROUP = "-1001234567890";
type RunOptions = Omit<Parameters<typeof runHeartbeatOnce>[0], "cfg" | "deps">;
function createCase({
  tmpDir,
  storePath,
  replySpy,
}: {
  tmpDir: string;
  storePath: string;
  replySpy: HeartbeatReplySpy;
}) {
  const cfg: OpenClawConfig = {
    agents: { defaults: { workspace: tmpDir, heartbeat: { every: "5m", target: "telegram" } } },
    messages: { visibleReplies: "automatic" },
    channels: {
      telegram: { botToken: "test-token", allowFrom: ["*"], heartbeat: { showOk: false } },
    },
    session: { store: storePath },
  };
  const sendTelegram = vi.fn().mockResolvedValue({ messageId: "m1" });
  return {
    cfg,
    storePath,
    replySpy,
    sendTelegram,
    seed: (entry: Partial<Parameters<typeof seedMainSessionStore>[2]> = {}) =>
      seedMainSessionStore(storePath, cfg, {
        lastChannel: "telegram",
        lastProvider: "telegram",
        lastTo: TELEGRAM_GROUP,
        ...entry,
      }),
    run: (options: RunOptions = {}, deps: Partial<HeartbeatDeps> = {}) =>
      runHeartbeatOnce({
        cfg,
        ...options,
        deps: {
          telegram: sendTelegram,
          getQueueSize: () => 0,
          nowMs: () => 0,
          getReplyFromConfig: replySpy,
          ...deps,
        },
      }),
    read: (sessionKey: string) =>
      expectDefined(
        readSessionStoreForTest<SessionEntry>(storePath)[sessionKey],
        "heartbeat session",
      ),
  };
}
function heartbeatCase(test: (fixture: ReturnType<typeof createCase>) => Promise<void>) {
  return () => withTempTelegramHeartbeatSandbox((sandbox) => test(createCase(sandbox)));
}
function buttons(label: string, value: string) {
  return { presentation: { blocks: [{ type: "buttons" as const, buttons: [{ label, value }] }] } };
}

describe("runHeartbeatOnce structured heartbeat delivery", () => {
  afterEach(async () => {
    resetGlobalHookRunner();
    await closeOpenClawAgentDatabasesAsync();
    vi.unstubAllEnvs();
    resetHeartbeatEventsForTest();
    resetSystemEventsForTest();
  });

  it.each([false, true])("awaits outcome persistence failures (notify=%s)", async (notify) =>
    heartbeatCase(async ({ cfg, storePath, seed, replySpy, sendTelegram, run }) => {
      cfg.agents!.defaults!.heartbeat!.target = "none";
      const sessionKey = await seed();
      replySpy.mockResolvedValue(
        createHeartbeatToolResponsePayload({
          outcome: notify ? "needs_attention" : "progress",
          notify,
          summary: "Synthetic outcome awaiting persistence",
        }),
      );
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const persist = vi
        .spyOn(heartbeatOutcomeStore, "persistHeartbeatOutcome")
        .mockImplementationOnce(async () => {
          entered.resolve();
          await release.promise;
        });
      const pending = run();
      try {
        await Promise.race([
          entered.promise,
          pending.then(() => {
            throw new Error("heartbeat completed without awaiting persistence");
          }),
        ]);
        release.reject(new Error("outcome storage unavailable"));
        expect(await pending).toMatchObject({ status: "failed" });
        expect(sendTelegram).not.toHaveBeenCalled();
        expect(
          await heartbeatOutcomeStore.claimHeartbeatOutcomeForRun({
            agentId: "main",
            sessionKey,
            storePath,
            runId: "next-user",
          }),
        ).toBeUndefined();
      } finally {
        release.resolve();
        await pending;
        persist.mockRestore();
      }
    })(),
  );

  it.each(["none", "same-id"] as const)(
    "records the first delivery only for its initialized session: %s",
    async (replacement) =>
      heartbeatCase(async ({ cfg, storePath, sendTelegram, run, read }) => {
        cfg.agents!.defaults!.heartbeat!.to = TELEGRAM_GROUP;
        const sessionKey = "agent:main:main";
        expect(readSessionStoreForTest(storePath)[sessionKey]).toBeUndefined();
        const replyResolver: InternalGetReplyFromConfig = async (ctx, options) => {
          const initialized = await initSessionState({
            ctx: finalizeInboundContext(ctx),
            cfg,
            commandAuthorized: true,
          });
          options?.onSessionPrepared?.({
            sessionKey: initialized.sessionKey,
            sessionId: initialized.sessionId,
            lifecycleRevision: initialized.sessionEntry.lifecycleRevision,
            storePath: initialized.storePath,
          });
          return { text: "Deployment requires attention." };
        };
        sendTelegram.mockImplementation(async () => {
          if (replacement !== "none") {
            replaceSessionEntrySync(
              { storePath, sessionKey },
              {
                sessionId:
                  replacement === "same-id" ? read(sessionKey).sessionId : "replacement-session",
                lifecycleRevision: "replacement-revision",
                updatedAt: Date.now(),
              },
            );
          }
          return { messageId: "first-alert" };
        });
        expect((await run({}, { getReplyFromConfig: replyResolver })).status).toBe("ran");
        expect(sendTelegram).toHaveBeenCalledOnce();
        const stored = read(sessionKey);
        if (replacement === "none") {
          expect(stored).toMatchObject({
            lastHeartbeatText: "Deployment requires attention.",
            lastHeartbeatSentAt: 0,
          });
          await run({}, { getReplyFromConfig: replyResolver });
          expect(sendTelegram).toHaveBeenCalledOnce();
        } else {
          expect(stored.lifecycleRevision).toBe("replacement-revision");
          expect(stored.lastHeartbeatText).toBeUndefined();
          expect(stored.lastHeartbeatSentAt).toBeUndefined();
        }
      })(),
  );

  it.each([
    { failure: "target-none", reason: "target-none" },
    { failure: "alerts-disabled", reason: "alerts-disabled" },
    { failure: "readiness-throws", reason: "readiness unavailable" },
    { failure: "hook-cancelled", reason: "message_sending_hook" },
    { failure: "send-failed", reason: "transport unavailable" },
  ])(
    "records a generated alert when $failure prevents confirmed delivery",
    async ({ failure, reason }) =>
      heartbeatCase(async ({ cfg, storePath, seed, replySpy, sendTelegram, run }) => {
        cfg.agents!.defaults!.heartbeat!.target = failure === "target-none" ? "none" : "telegram";
        if (failure === "alerts-disabled") {
          cfg.channels = {
            ...cfg.channels,
            defaults: { heartbeatVisibility: { showAlerts: false } },
          };
        }
        const registry = createTestRegistry([
          {
            pluginId: "telegram",
            source: "test",
            plugin: {
              ...heartbeatRunnerTelegramPlugin,
              heartbeat: {
                checkReady: async () => {
                  if (failure === "readiness-throws") {
                    throw new Error(reason);
                  }
                  return { ok: failure !== "readiness", reason };
                },
              },
            },
          },
        ]);
        setActivePluginRegistry(registry);
        if (failure === "hook-cancelled") {
          addTestHook({
            registry,
            pluginId: "heartbeat-test-suppression",
            hookName: "message_sending",
            handler: () => ({ cancel: true }),
          });
          initializeGlobalHookRunner(registry);
        }
        const sessionKey = await seed();
        replySpy.mockResolvedValue(
          createHeartbeatToolResponsePayload({
            outcome: "needs_attention",
            notify: true,
            summary: "Build is blocked.",
            notificationText: "Build needs credentials.",
            reason: "Deployment check",
            priority: "high",
          }),
        );
        if (failure === "send-failed") {
          sendTelegram.mockRejectedValue(new Error(reason));
        }
        const result = await run({ source: "manual", reason: "operator check" });
        expect(replySpy).toHaveBeenCalledOnce();
        expect(getLastHeartbeatEvent()?.indicatorType).toBe(
          failure === "send-failed" ? "error" : failure === "alerts-disabled" ? "alert" : undefined,
        );
        if (failure.startsWith("readiness")) {
          expect.soft(result).toMatchObject({
            status: "skipped",
            reason: "channel-not-ready",
            retryAtMs: expect.any(Number),
          });
          expect.soft(isRetryableHeartbeatSkipReason("channel-not-ready")).toBe(true);
        }
        await closeOpenClawAgentDatabasesAsync();
        const stored = await heartbeatOutcomeStore.claimHeartbeatOutcomeForRun({
          agentId: "main",
          sessionKey,
          storePath,
          runId: "user-run",
        });
        expect(stored).toMatchObject({
          outcome: "blocked",
          priority: "high",
          wakeSource: "manual",
          wakeReason: "operator check",
        });
        expect(stored?.summary).toContain("Build needs credentials.");
        expect(stored?.responseReason).toContain(reason);
        expect(stored?.responseReason).toContain("notify:true");
        await closeOpenClawAgentDatabasesAsync();
      })(),
  );

  it(
    "delivers only the final non-reasoning answer after private blocks",
    heartbeatCase(async ({ seed, replySpy, sendTelegram, run }) => {
      await seed();
      replySpy.mockImplementation(async (_ctx, options) => {
        await options?.onBlockReply?.({ text: "Intermediate finding" });
        return [
          { text: "Superseded draft" },
          { text: "Final monitoring result" },
          { text: "Private reasoning", isReasoning: true },
        ];
      });
      expect((await run()).status).toBe("ran");
      expect(sendTelegram).toHaveBeenCalledOnce();
      expect(sendTelegram.mock.calls[0]?.[1]).toBe("Final monitoring result");
    }),
  );

  it(
    "delivers changed heartbeat actions when their visible text matches the previous send",
    heartbeatCase(async ({ seed, replySpy, sendTelegram, run }) => {
      await seed();
      const text = "Deployment approval required.";
      replySpy
        .mockResolvedValueOnce({ text, ...buttons("Review deployment", "review") })
        .mockResolvedValueOnce({ text, ...buttons("Approve deployment", "approve") });
      await run();
      await run();
      expect(sendTelegram).toHaveBeenCalledTimes(2);
      expect(sendTelegram.mock.calls[0]?.[1]).toContain("Review deployment");
      expect(sendTelegram.mock.calls[1]?.[1]).toContain("Approve deployment");
    }),
  );

  it.each(["confirmed", "unknown"] as const)(
    "settles confirmed presentation delivery and retains unknown custody: %s",
    async (mode) =>
      heartbeatCase(async ({ storePath, seed, replySpy, sendTelegram, run, read }) => {
        const previous = {
          lastHeartbeatText: "Previous successful heartbeat",
          lastHeartbeatSentAt: 0,
        };
        const sessionKey = await seed(previous);
        replySpy.mockImplementation(async () => {
          const reply = buttons("Approve deployment", "approve");
          await patchSessionEntryCore(
            { storePath, sessionKey },
            (current) => {
              setReplyPayloadMetadata(reply, {
                pendingFinalDeliveryCompletion: {
                  sessionKey,
                  storePath,
                  sessionId: current.sessionId,
                  intentId: "structured-heartbeat-intent",
                  deliveryId: "presentation",
                },
              });
              return {
                pendingFinalDelivery: {
                  kind: "transport-only",
                  createdAt: 0,
                  intentId: "structured-heartbeat-intent",
                  deliveries: [{ id: "presentation", state: "prepared" }],
                },
              };
            },
            { preserveActivity: true },
          );
          return reply;
        });
        sendTelegram.mockResolvedValue({
          messageId: mode === "confirmed" ? "presentation-1" : undefined,
        });
        expect((await run()).status).toBe("ran");
        expect(sendTelegram).toHaveBeenCalledOnce();
        expect(sendTelegram.mock.calls[0]?.[0]).toBe(TELEGRAM_GROUP);
        expect(sendTelegram.mock.calls[0]?.[1]).toContain("Approve deployment");
        const stored = read(sessionKey);
        expect(stored).toMatchObject(previous);
        if (mode === "confirmed") {
          expect(stored.pendingFinalDelivery).toBeUndefined();
        } else {
          expect(stored.pendingFinalDelivery).toMatchObject({
            intentId: "structured-heartbeat-intent",
            deliveries: [{ id: "presentation", state: "unknown" }],
          });
        }
      })(),
  );

  it(
    "preserves heartbeat reply metadata, channel data, and voice delivery",
    heartbeatCase(async ({ seed, replySpy, run }) => {
      await seed();
      const sendPayload = vi
        .fn()
        .mockResolvedValue({ channel: "telegram", messageId: "metadata-1" });
      setActivePluginRegistry(
        createTestRegistry([
          {
            pluginId: "telegram",
            source: "test",
            plugin: createOutboundTestPlugin({
              id: "telegram",
              outbound: {
                deliveryMode: "direct",
                sendText: vi.fn().mockResolvedValue({ messageId: "text-1" }),
                sendPayload,
              },
            }),
          },
        ]),
      );
      const payload = {
        text: "Deployment update",
        mediaUrl: "https://example.test/heartbeat.ogg",
        replyToId: "42",
        audioAsVoice: true,
        channelData: {
          telegram: { buttons: [[{ text: "Open deployment", callback_data: "open" }]] },
        },
      };
      replySpy.mockResolvedValue(setReplyPayloadMetadata(payload, { replyToIdExplicit: true }));
      expect((await run()).status).toBe("ran");
      expect(sendPayload).toHaveBeenCalledOnce();
      expect(sendPayload.mock.calls[0]?.[0]?.payload).toMatchObject(payload);
    }),
  );
});
