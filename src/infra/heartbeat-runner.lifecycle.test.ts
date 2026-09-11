import { afterEach, describe, expect, it, vi } from "vitest";
import { heartbeatRunnerTelegramPlugin } from "../../test/helpers/infra/heartbeat-runner-channel-plugins.js";
import * as inboundDispatch from "../auto-reply/dispatch.js";
import type { OpenClawConfig } from "../config/config.js";
import * as sessionAccessor from "../config/sessions/session-accessor.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { resetGatewayWorkAdmission } from "../process/gateway-work-admission.js";
import { createDeferredCore } from "../shared/deferred.js";
import { drainGlobalSingletonLifecycleState } from "../shared/global-singleton.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import { runHeartbeatOnce } from "./heartbeat-runner.js";
import { installHeartbeatRunnerTestRuntime } from "./heartbeat-runner.test-harness.js";
import {
  readSessionStoreForTest,
  seedMainSessionStore,
  withTempHeartbeatSandbox,
} from "./heartbeat-runner.test-utils.js";
import * as heartbeatTyping from "./heartbeat-typing.js";
import * as targets from "./outbound/targets.js";
import {
  requestSessionEventWakeAndWait,
  setSessionEventWakeHandler,
} from "./session-event-wake.js";

installHeartbeatRunnerTestRuntime();

afterEach(async () => {
  await drainGlobalSingletonLifecycleState("close");
  resetGatewayWorkAdmission();
  vi.restoreAllMocks();
});

describe("heartbeat runner lifecycle cancellation", () => {
  it.each(["route", "transaction", "typing"] as const)(
    "does not resume retired %s preparation into state writes or inbound dispatch",
    async (stage) => {
      await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
        const entered = createDeferredCore<void>();
        const release = createDeferredCore<void>();
        const finished = createDeferredCore<void>();
        const cleared = createDeferredCore<void>();
        const sendTyping = vi.fn(async () => {});
        const clearTyping = vi.fn(async () => {
          cleared.resolve();
        });
        setActivePluginRegistry(
          createTestRegistry([
            {
              pluginId: "telegram",
              source: "test",
              plugin: {
                ...heartbeatRunnerTelegramPlugin,
                heartbeat: { sendTyping, clearTyping },
              },
            },
          ]),
        );
        const cfg: OpenClawConfig = {
          agents: {
            defaults: {
              workspace: tmpDir,
              typingMode: "instant",
              heartbeat: {
                every: "5m",
                target: "telegram",
                isolatedSession: stage !== "typing",
              },
            },
          },
          channels: { telegram: { allowFrom: ["*"] } },
          session: { store: storePath },
        };
        const sessionKey = await seedMainSessionStore(storePath, cfg, {
          sessionId: "lifecycle-base",
          lastChannel: "telegram",
          lastProvider: "telegram",
          lastTo: "123456789",
        });
        const before = readSessionStoreForTest(storePath);
        const dispatch = vi.spyOn(
          inboundDispatch,
          "dispatchInboundMessageWithRoutedChannelDispatcher",
        );
        if (stage === "route") {
          const resolveRoute = targets.resolveHeartbeatDeliveryTargetWithSessionRoute;
          vi.spyOn(targets, "resolveHeartbeatDeliveryTargetWithSessionRoute").mockImplementation(
            async (...args) => {
              const route = await resolveRoute(...args);
              entered.resolve();
              await release.promise;
              return route;
            },
          );
        } else if (stage === "transaction") {
          const mutate = sessionAccessor.applySessionEntryLifecycleMutation;
          vi.spyOn(sessionAccessor, "applySessionEntryLifecycleMutation").mockImplementation(
            async (params) => {
              entered.resolve();
              await release.promise;
              return mutate(params);
            },
          );
        } else {
          const createTyping = heartbeatTyping.createHeartbeatTypingCallbacks;
          vi.spyOn(heartbeatTyping, "createHeartbeatTypingCallbacks").mockImplementation(
            (...args) => {
              const callbacks = createTyping(...args);
              if (!callbacks) {
                throw new Error("expected heartbeat typing callbacks");
              }
              return {
                ...callbacks,
                onReplyStart: async () => {
                  await callbacks.onReplyStart();
                  entered.resolve();
                  await release.promise;
                },
              };
            },
          );
        }
        let body: ReturnType<typeof runHeartbeatOnce> | undefined;
        let signal: AbortSignal | undefined;
        const dispose = setSessionEventWakeHandler((_request, ownerSignal) => {
          signal = ownerSignal;
          body = runHeartbeatOnce({
            cfg,
            agentId: "main",
            sessionKey,
            source: "background-task",
            intent: "immediate",
            reason: "background-task",
            deps: { getReplyFromConfig: replySpy, getQueueSize: () => 0 },
          });
          void body.then(
            () => finished.resolve(),
            () => finished.resolve(),
          );
          return body;
        });
        const pending = requestSessionEventWakeAndWait({
          source: "background-task",
          intent: "immediate",
          reason: "background-task",
          agentId: "main",
          sessionKey,
          coalesceMs: 0,
        });
        try {
          await Promise.race([
            entered.promise,
            finished.promise.then(() => {
              throw new Error(`heartbeat finished before held ${stage}`);
            }),
          ]);
          expect(signal?.aborted).toBe(false);
          expect(dispatch).not.toHaveBeenCalled();
          expect(readSessionStoreForTest(storePath)).toEqual(before);
          await drainGlobalSingletonLifecycleState("close");
          expect(signal?.aborted).toBe(true);
          await expect(pending).resolves.toEqual({
            status: "failed",
            reason: "heartbeat wake cancelled",
          });

          release.resolve();
          expect(body).toBeDefined();
          if (stage === "typing") {
            await expect(body).resolves.toMatchObject({
              status: "failed",
              reason: signal?.reason.message,
            });
          } else {
            await expect(body).rejects.toBe(signal?.reason);
          }
          expect(dispatch).not.toHaveBeenCalled();
          expect(replySpy).not.toHaveBeenCalled();
          expect(readSessionStoreForTest(storePath)).toEqual(before);
          if (stage === "typing") {
            await cleared.promise;
            expect(sendTyping).toHaveBeenCalledOnce();
            expect(clearTyping).toHaveBeenCalledOnce();
          } else {
            expect(sendTyping).not.toHaveBeenCalled();
          }
        } finally {
          release.resolve();
          await Promise.allSettled([body]);
          if (stage === "typing" && sendTyping.mock.calls.length > 0) {
            await cleared.promise;
          }
          dispose();
          await drainGlobalSingletonLifecycleState("close");
        }
      });
    },
  );
});
