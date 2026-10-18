import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withinTest } from "../../../test/helpers/promise.js";
import { createQueueTestRun } from "../../auto-reply/reply/queue.test-helpers.js";
import { enqueueFollowupRun, reserveSteerCandidate } from "../../auto-reply/reply/queue/enqueue.js";
import { withPluginRuntimeGatewayContextResolver } from "../../plugins/runtime/gateway-request-scope.js";
import {
  beginSessionControllerSourceInjection,
  bindSessionControllerSource,
  claimSessionControllerTask,
  releaseSessionControllerClaim,
  type SessionControllerMailboxClaim,
} from "../../sessions/session-controller.mailbox.js";
import { registerRpcSource } from "../../sessions/session-controller.rpc-sources.js";
import { rpcSourceTesting } from "../../sessions/session-lifecycle-admission.test-support.js";
import { agentHandlers } from "../server-methods/agent.js";
import { createGatewayRequestContext } from "../server-request-context.js";
import { makeContextParams } from "../server-request-context.test-support.js";
import { createRpcSourceForTest } from "../test-helpers.rpc-source.js";
import { setGatewayDedupeEntry } from "./agent-job.js";
import { prepareAgentWaitForTurn } from "./agent-wait.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("agent.wait queue admission", () => {
  it("keeps the wait's Gateway when another scope publishes queue admission", async ({
    signal,
  }) => {
    const runId = "cross-gateway-queue-publication";
    const context = createGatewayRequestContext(makeContextParams());
    const resolveGatewayContext = () => context;
    const resolveForeign = () => undefined;
    const identity = {
      runId,
      agentId: "main",
      sessionKey: "agent:main:cross-gateway-queue",
      sessionId: "cross-gateway-session",
      storeScope: "/synthetic/cross-gateway-queue/sessions",
    };
    const source = withPluginRuntimeGatewayContextResolver(resolveGatewayContext, () =>
      createRpcSourceForTest({ kind: "chat-send" }, identity),
    );
    const foreign = withPluginRuntimeGatewayContextResolver(resolveForeign, () =>
      createRpcSourceForTest(
        { kind: "chat-send" },
        { ...identity, storeScope: "/synthetic/foreign-queue/sessions" },
      ),
    );
    registerRpcSource(runId, source);
    registerRpcSource(runId, foreign);
    const run = createQueueTestRun({ prompt: "queued source" });
    run.run = {
      ...run.run,
      agentId: identity.agentId,
      sessionKey: identity.sessionKey,
      sessionId: identity.sessionId,
      config: { ...run.run.config, session: { store: identity.storeScope } },
    };
    run.turnAdoptionLifecycle = {
      onAdopted: () => {},
      onDeferred: () =>
        setGatewayDedupeEntry({
          dedupe: context.dedupe,
          key: `chat:${runId}`,
          entry: { ts: Date.now(), ok: true, payload: { runId, status: "accepted" } },
        }),
    };
    bindSessionControllerSource(source.input, run);
    vi.useFakeTimers();
    const waiting = prepareAgentWaitForTurn(
      { dedupe: context.dedupe, resolveGatewayContext },
      { runId, timeoutMs: 30_000 },
    ).wait();
    try {
      withPluginRuntimeGatewayContextResolver(resolveForeign, () => {
        expect(
          enqueueFollowupRun(
            identity.sessionKey,
            run,
            { mode: "followup" },
            "none",
            undefined,
            false,
          ),
        ).toBe(true);
      });
      await expect(withinTest(waiting, signal)).resolves.toMatchObject({
        session: { sessionId: identity.sessionId },
        result: { runId, status: "pending", timeoutPhase: "queue", providerStarted: false },
      });
    } finally {
      setGatewayDedupeEntry({
        dedupe: context.dedupe,
        key: `chat:${runId}`,
        entry: { ts: Date.now(), ok: true, payload: { runId, status: "ok" } },
      });
      await waiting;
    }
  });

  it.each([
    { name: "direct claim waiting", enqueued: false, injecting: false },
    { name: "direct native injection", enqueued: false, injecting: true },
    { name: "enqueued follow-up", enqueued: true, injecting: false },
    { name: "enqueued native injection", enqueued: true, injecting: true },
  ])(
    "reports queue pending only after follow-up admission: $name",
    async ({ name, enqueued, injecting }) => {
      const runId = `queue-admission-${name}`;
      const identity = {
        storeScope: `/synthetic/agent-wait/${name}/sessions`,
        sessionKey: "agent:main:queue-admission",
        sessionId: runId,
      };
      let blocker: SessionControllerMailboxClaim | undefined;
      if (!enqueued && !injecting) {
        const blockingSource = createRpcSourceForTest({}, identity);
        blocker = await claimSessionControllerTask(blockingSource.input, () => {});
      }
      const source = createRpcSourceForTest(
        { kind: "chat-send" },
        { ...identity, runId, phase: enqueued && !injecting ? "waiting" : "preparing" },
      );
      rpcSourceTesting.set(runId, source);
      const directClaim = blocker ? claimSessionControllerTask(source.input, () => {}) : undefined;
      const injection =
        injecting && !enqueued ? beginSessionControllerSourceInjection(source.input) : undefined;
      let queuedInjection: ReturnType<typeof reserveSteerCandidate>;
      if (enqueued && injecting) {
        const run = createQueueTestRun({ prompt: "queued steering" });
        run.run = {
          ...run.run,
          sessionKey: identity.sessionKey,
          sessionId: identity.sessionId,
          config: { ...run.run.config, session: { store: identity.storeScope } },
        };
        bindSessionControllerSource(source.input, run);
        queuedInjection = reserveSteerCandidate(
          identity.sessionKey,
          run,
          { mode: "steer" },
          async () => {},
        );
      }
      const context = createGatewayRequestContext(makeContextParams());
      const respond = vi.fn();
      let waiting: Promise<void> | void = undefined;
      try {
        if (enqueued && injecting) {
          expect(await queuedInjection?.admit()).toBe("steer");
          queuedInjection?.accepted(true);
        }
        if (injection) {
          expect(await injection.admit()).toBe(true);
          injection.accepted(true);
        }
        vi.useFakeTimers();
        const handler = expectDefined(agentHandlers["agent.wait"], "registered wait handler");
        waiting = handler({
          req: { type: "req", id: runId, method: "agent.wait" },
          params: { runId, timeoutMs: 30_000 },
          respond,
          context,
          client: null,
          isWebchatConnect: () => false,
        });
        await vi.advanceTimersByTimeAsync(0);
        if (enqueued) {
          expect(respond).toHaveBeenCalledWith(
            true,
            expect.objectContaining({
              runId,
              status: "pending",
              timeoutPhase: "queue",
              providerStarted: false,
            }),
          );
        } else {
          expect(respond).not.toHaveBeenCalled();
        }
      } finally {
        queuedInjection?.consume("consumed");
        injection?.finish(true);
        if (blocker) {
          releaseSessionControllerClaim(blocker);
        }
        if (directClaim) {
          releaseSessionControllerClaim(await directClaim);
        }
        setGatewayDedupeEntry({
          dedupe: context.dedupe,
          key: `chat:${runId}`,
          entry: { ts: Date.now(), ok: true, payload: { runId, status: "ok" } },
        });
        await waiting;
      }
      if (!enqueued) {
        expect(respond).toHaveBeenCalledWith(
          true,
          expect.objectContaining({ runId, status: "ok" }),
        );
      }
    },
  );
});
