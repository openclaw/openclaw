// Source production-path probe; not published-package or live Telegram proof.
import { expect, it, vi, type MockInstance } from "vitest";
import {
  telegramPlugin,
  getOrCreateAccountThrottler,
  apiThrottler,
  resetTelegramAccountThrottlersForTest,
  loadTelegramSendHttpFixture,
} from "../extensions/telegram/test-api.js";
import { resolveOpenClawPluginToolsForOptions } from "../src/agents/openclaw-plugin-tools.js";
import * as execution from "../src/auto-reply/reply/agent-runner-execution.test-support.js";
import { setActivePluginRegistry } from "../src/plugins/runtime.js";
import type { OpenClawPluginToolDelivery } from "../src/plugins/tool-types.js";
import { createTestRegistry } from "../src/test-utils/channel-plugins.js";
import { createDeferred } from "./helpers/promise.js";
const capture = vi.hoisted(() => ({
  delivery: undefined as OpenClawPluginToolDelivery | undefined,
}));
// mock-isolation: Capture host context only; real delivery, authority, adapter and HTTP.
vi.mock("../src/plugins/tools.js", async (original) => ({
  ...(await original<typeof import("../src/plugins/tools.js")>()),
  resolvePluginTools: ({ context }: { context: { delivery?: OpenClawPluginToolDelivery } }) => {
    capture.delivery = context.delivery;
    return [];
  },
}));
const state = await execution.setupAgentRunnerExecutionTestState();
const execute = await execution.getExecuteAgentTurnForTest();
const { mintReplyMessageActionTurnCapability } = await vi.importActual<
  typeof import("../src/auto-reply/reply/agent-runner-utils.js")
>("../src/auto-reply/reply/agent-runner-utils.js");
const { useTelegramHttpFixture } = await loadTelegramSendHttpFixture();
const fixture = useTelegramHttpFixture();
const key = "agent:main:telegram:direct:123"; // synthetic
const runId = "synthetic-transport-proof";
it.each(["cancelled", "settled", "replaced"] as const)(
  "observes real loopback HTTP and fences deferred transport after %s",
  async (terminal) => {
    state.isCliProviderMock.mockReturnValue(false);
    state.mintReplyMessageActionTurnCapabilityMock.mockImplementation(
      mintReplyMessageActionTurnCapability,
    );
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "telegram", source: "synthetic", plugin: telegramPlugin }]),
    );
    const followupRun = execution.createFollowupRun({
      sessionKey: key,
      messageProvider: "telegram",
      agentAccountId: "default",
      senderId: "456",
      config: fixture.cfg,
      timeoutMs: 30 * 60_000,
    });
    followupRun.originatingChannel = "telegram";
    followupRun.originatingTo = "123";
    const turn = {
      ...execution.createMinimalRunAgentTurnParams({
        followupRun,
        opts: { runId },
        sessionCtx: {
          Provider: "telegram",
          ChatType: "direct",
          To: "123",
          AccountId: "default",
          SenderId: "456",
        },
      }),
      sessionKey: key,
    };
    const controller = new AbortController();
    const started = createDeferred();
    const release = createDeferred();
    const transportRelease = createDeferred();
    const nextCandidateStarted = createDeferred();
    const nextCandidateRelease = createDeferred();
    let holdTransport = false;
    let gateReached = false;
    let inFlight: Promise<unknown> | undefined;
    resetTelegramAccountThrottlersForTest();
    getOrCreateAccountThrottler(fixture.cfg.channels.telegram.botToken, () => {
      const throttle = apiThrottler({ global: {}, group: {}, out: {} });
      return (prev, method, payload, signal) =>
        throttle(
          async (...args) => {
            if (holdTransport && method === "sendMessage") {
              holdTransport = false;
              gateReached = true;
              started.resolve();
              await transportRelease.promise;
            }
            return prev(...args);
          },
          method,
          payload,
          signal,
        );
    });
    let retained: OpenClawPluginToolDelivery | undefined;
    let replaced: OpenClawPluginToolDelivery | undefined;
    let candidate = 0;
    const bind = (token: string | undefined, sessionKey = key) => {
      resolveOpenClawPluginToolsForOptions({
        resolvedConfig: fixture.cfg,
        options: {
          config: fixture.cfg,
          agentSessionKey: sessionKey,
          runId,
          sessionId: "session",
          agentChannel: "telegram",
          agentAccountId: "default",
          agentTo: "123",
          requesterAgentIdOverride: "main",
          senderIsOwner: true,
          messageActionTurnCapability: token,
        },
      });
      expect(capture.delivery).toBeDefined();
      return capture.delivery!;
    };
    const realNow = Date.now.bind(Date);
    let clock: MockInstance<typeof Date.now> | undefined;
    state.runWithModelFallbackMock.mockImplementation(
      async (params: execution.FallbackRunnerParams) => {
        await params.run("anthropic", "claude", execution.initialFallbackAttemptOptions(params));
        const result = await execution.runFallbackCandidate(
          params,
          "anthropic",
          "claude",
          execution.fallbackAttemptOptions(params, "unknown"),
        );
        if (terminal !== "replaced") {
          return result;
        }
        return execution.runFallbackCandidate(
          params,
          "anthropic",
          "claude",
          execution.fallbackAttemptOptions(params, "unknown"),
        );
      },
    );
    state.runEmbeddedAgentMock.mockImplementation(
      async (run: { messageActionTurnCapability?: string }) => {
        candidate++;
        const delivery = bind(run.messageActionTurnCapability);
        if (candidate === 3) {
          nextCandidateStarted.resolve();
          await nextCandidateRelease.promise;
          return { payloads: [], meta: {} };
        }
        if (candidate === 1) {
          clock = vi.spyOn(Date, "now").mockImplementation(() => realNow() + 41 * 60_000);
          // Keep the monotonic simulated offset through queued HTTP work.
          // Restoring here would move the throttler clock backwards by 41 minutes.
          await delivery.send({ text: "synthetic active after simulated 41 minutes" });
          expect(fixture.requests.map((r) => r.method)).toEqual(["sendMessage"]);
          console.log(
            "PROOF active simulated_elapsed_minutes=41 attempt_minutes=30 final_HTTP_sendMessage=1",
          );
          expect(() =>
            bind(run.messageActionTurnCapability, "agent:main:telegram:direct:999"),
          ).toThrow("no longer active");
          expect(fixture.requests).toHaveLength(1);
          console.log("PROOF wrong-session final_HTTP_delta=0");
          replaced = delivery;
        } else {
          await expect(replaced!.send({ text: "synthetic replaced callback" })).rejects.toThrow(
            "no longer active",
          );
          expect(fixture.requests).toHaveLength(1);
          console.log("PROOF replaced retained_callback_executed=true final_HTTP_delta=0");
          retained = delivery;
          holdTransport = true;
          inFlight = delivery
            .send({ text: "synthetic deferred transport" })
            .then(
              () => ({ sent: true }),
              (error: unknown) => ({ error }),
            )
            .then((result) => {
              if (!gateReached) {
                console.log("PROBE_SETUP deferred gate not reached", result);
                started.resolve();
              }
              return result;
            });
          await release.promise;
        }
        return { payloads: [], meta: {} };
      },
    );
    const pending = execute({ ...turn, opts: { ...turn.opts, abortSignal: controller.signal } });
    try {
      await Promise.race([
        started.promise,
        pending.then(() => {
          throw new Error("candidate did not reach transport");
        }),
      ]);
      expect(gateReached, "transport must actually reach the deferred final-I/O seam").toBe(true);
      if (terminal === "cancelled") {
        controller.abort();
      } else {
        release.resolve();
        if (terminal === "replaced") {
          await nextCandidateStarted.promise;
        } else {
          await pending;
        }
      }
      transportRelease.resolve();
      const result = await inFlight;
      expect(fixture.requests).toHaveLength(1);
      expect(result).toMatchObject({ error: expect.any(Error) });
      await expect(retained!.send({ text: "synthetic terminal callback" })).rejects.toThrow(
        "no longer active",
      );
      console.log(
        "PROOF " + terminal + " deferred_transport_callback_executed=true final_HTTP_delta=0",
      );
    } finally {
      release.resolve();
      nextCandidateRelease.resolve();
      transportRelease.resolve();
      await inFlight;
      await pending;
      resetTelegramAccountThrottlersForTest();
      clock?.mockRestore();
    }
  },
);
