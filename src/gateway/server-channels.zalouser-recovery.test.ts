import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import * as zalouserPublicApi from "../../extensions/zalouser/api.js";
import zalouserEntry from "../../extensions/zalouser/index.js";
import * as zalouserRuntimeApi from "../../extensions/zalouser/runtime-api.js";
import { createDeferred } from "../../test/helpers/promise.js";
import * as ingressQueue from "../channels/message/ingress-queue.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger, runtimeForLogger } from "../logging/subsystem.js";
import { loadBundledEntryExportSync } from "../plugin-sdk/channel-entry-contract.js";
import { observeChannelIngressQueueWrite } from "../plugin-sdk/channel-ingress-test-runtime.js";
import {
  createPluginRecord,
  createPluginRegistry,
  createPluginRuntimeMock,
  disposePluginRegistryInstances,
} from "../plugin-sdk/plugin-test-runtime.js";
import { withOpenClawTestState } from "../plugin-sdk/test-state.js";
import { createJiti } from "../plugins/jiti-factory.js";
import { resetGatewayWorkAdmission } from "../process/gateway-work-admission.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { startChannelHealthMonitor } from "./channel-health-monitor.js";
import { createChannelManager } from "./server-channels.js";

const io = vi.hoisted(() => ({ createZalo: vi.fn(), credentialsPresent: true }));
// Only provider authentication and credential storage I/O are fixtures. The
// plugin, watchdog, account supervisor and health monitor make real decisions.
vi.mock("../../extensions/zalouser/src/zca-client.js", () => ({
  createZalo: io.createZalo,
}));
vi.mock("../../extensions/zalouser/src/session-state.js", async (importOriginal) => ({
  ...(await importOriginal()),
  loadStoredZaloCredentials: async (profile: string) =>
    io.credentialsPresent
      ? { profile, imei: "fixture", userAgent: "fixture", cookie: [], createdAt: "2026-10-01" }
      : null,
  refreshStoredZaloCredentials: async (profile: string, credentials: object) => ({
    profile,
    ...credentials,
    createdAt: "2026-10-01",
  }),
}));

// Keep entry sidecars in Vitest's module graph so external-I/O fixtures apply;
// registration, scoped runtime ownership and disposal remain production code.
const createEntryLoader: typeof createJiti = (...loaderArgs) =>
  new Proxy(createJiti(...loaderArgs), {
    apply(target, thisArg, args) {
      if (typeof args[0] === "string" && /[/\\]channel-plugin-api\.[cm]?[jt]s$/.test(args[0])) {
        return zalouserPublicApi;
      }
      if (typeof args[0] === "string" && /[/\\]runtime-api\.[cm]?[jt]s$/.test(args[0])) {
        return zalouserRuntimeApi;
      }
      return Reflect.apply(target, thisArg, args);
    },
  });

class FixtureListener extends EventEmitter {
  started = createDeferred();
  start = vi.fn(() => {
    this.emit("connected");
    this.started.resolve();
  });
  stop = vi.fn(() => this.emit("closed", 1000, "stopped"));
}

function session(listener: FixtureListener) {
  return {
    listener,
    getOwnId: () => "fixture-owner",
    getContext: () => ({ imei: "fixture", userAgent: "fixture" }),
    getCookie: () => ({ toJSON: () => ({ cookies: [] }) }),
    fetchAccountInfo: async () => ({ userId: "fixture-owner" }),
  };
}

afterEach(() => {
  resetGatewayWorkAdmission();
  vi.useRealTimers();
  vi.restoreAllMocks();
  io.createZalo.mockReset();
  io.credentialsPresent = true;
});

it.each(["recover", "manual stop", "logout"] as const)(
  "handles %s after a watchdog exit and replacement authentication timeout",
  async (outcome) => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "zalo-recovery-" },
      async ({ stateDir }) => {
        vi.useFakeTimers({
          toFake: [
            "setTimeout",
            "clearTimeout",
            "setInterval",
            "clearInterval",
            "Date",
            "performance",
          ],
        });
        resetGatewayWorkAdmission();
        const runtime = createPluginRuntimeMock();
        runtime.state.resolveStateDir = () => stateDir;
        const incomingCompleted = createDeferred<boolean>();
        const createQueue = ingressQueue.createChannelIngressQueue;
        vi.spyOn(ingressQueue, "createChannelIngressQueue").mockImplementation(
          <TPayload, TMetadata = unknown, TCompletedMetadata = unknown>(
            ...args: Parameters<typeof createQueue>
          ) => {
            const queue = createQueue<TPayload, TMetadata, TCompletedMetadata>(...args);
            void observeChannelIngressQueueWrite(queue, "complete", "post-recovery").then(
              incomingCompleted.resolve,
            );
            return queue;
          },
        );
        const first = new FixtureListener();
        const replacement = new FixtureListener();
        const pending = createDeferred<ReturnType<typeof session>>();
        const login = vi
          .fn()
          .mockResolvedValueOnce(session(first))
          .mockReturnValueOnce(pending.promise)
          .mockResolvedValueOnce(session(replacement));
        io.createZalo.mockResolvedValue({ login });
        const cfg: OpenClawConfig = {
          channels: { zalouser: { enabled: true, profile: "default", groupPolicy: "disabled" } },
        };
        const scheduler = createTestGatewayScheduler("fake-timers");
        const log = createSubsystemLogger("gateway/zalo-recovery-test");
        zalouserEntry.loadChannelPlugin({ createLoaderForTest: createEntryLoader });
        loadBundledEntryExportSync(
          new URL("../../extensions/zalouser/index.ts", import.meta.url).href,
          { specifier: "./runtime-api.js", exportName: "setZalouserRuntime" },
          { createLoaderForTest: createEntryLoader },
        );
        const builder = createPluginRegistry({
          runtime,
          logger: log,
          activateGlobalSideEffects: false,
        });
        const record = createPluginRecord({ id: "zalouser", origin: "bundled" });
        builder.registry.plugins.push(record);
        const api = builder.createApi(record, { config: cfg, registrationMode: "full" });
        api.lifecycle.runInBackgroundContext!(() => zalouserEntry.register(api));
        const restartScheduled = createDeferred();
        vi.spyOn(log, "info").mockImplementation((message) => {
          if (message.includes("auto-restart attempt")) {
            restartScheduled.resolve();
          }
        });
        const manager = createChannelManager({
          channelLogs: { zalouser: log },
          channelRuntimeEnvs: { zalouser: runtimeForLogger(log) },
          scheduler,
          getRuntimeConfig: () => cfg,
          getPluginRegistry: () => builder.registry,
        });
        const snapshot = () => manager.getRuntimeSnapshot().channelAccounts.zalouser?.default;
        let monitor: ReturnType<typeof startChannelHealthMonitor> | undefined;
        try {
          await manager.startChannels();
          expect(snapshot()).toMatchObject({ running: true });
          await first.started.promise;
          // Advance wall time without replaying interval callbacks, then let the
          // real watchdog detect the event-loop gap.
          vi.setSystemTime(Date.now() + 40_000);
          await vi.advanceTimersByTimeAsync(30_000);
          expect(first.stop).toHaveBeenCalled();
          await restartScheduled.promise;
          expect(manager.isAutoRestartScheduled("zalouser", "default")).toBe(true);
          await vi.advanceTimersByTimeAsync(6_000);
          expect(login).toHaveBeenCalledTimes(2);
          await vi.advanceTimersByTimeAsync(12_000);
          expect(snapshot()).toMatchObject({ running: false, restartPending: false });
          expect(replacement.start).not.toHaveBeenCalled();
          if (outcome === "manual stop") {
            await manager.stopChannel("zalouser", "default");
          } else if (outcome === "logout") {
            io.credentialsPresent = false;
          }
          monitor = startChannelHealthMonitor({ scheduler, channelManager: manager });
          await vi.advanceTimersByTimeAsync(60_000);
          await monitor.waitForIdle();
          if (outcome === "recover") {
            expect(replacement.start).toHaveBeenCalledOnce();
            expect(snapshot()).toMatchObject({ running: true, linked: true });
            expect(first.start).toHaveBeenCalledOnce();
            expect(first.listenerCount("message")).toBe(0);
            expect(replacement.listenerCount("message")).toBe(1);
            // A real post-recovery ingress row reaches the configured group-policy
            // decision and completes. No agent/model request is needed for a drop.
            replacement.emit("message", {
              type: 1,
              threadId: "fixture-group",
              isSelf: false,
              data: {
                msgId: "post-recovery",
                cliMsgId: "fixture-client",
                uidFrom: "fixture-sender",
                idTo: "fixture-group",
                dName: "Fixture Sender",
                content: "hello",
                ts: String(Date.now()),
              },
            });
            await expect(incomingCompleted.promise).resolves.toBe(true);
            expect(snapshot()?.lastInboundAt).toBe(Date.now());
          } else {
            expect(replacement.start).not.toHaveBeenCalled();
            expect(login).toHaveBeenCalledTimes(2);
            expect(snapshot()?.running).toBe(false);
          }
        } finally {
          monitor?.shutdown();
          const stop = manager.stopChannel("zalouser", "default");
          await vi.advanceTimersByTimeAsync(6_000);
          await stop;
          scheduler.beginClose();
          pending.resolve(session(new FixtureListener()));
          await disposePluginRegistryInstances(builder.registry);
          vi.useRealTimers();
        }
      },
    );
  },
);
