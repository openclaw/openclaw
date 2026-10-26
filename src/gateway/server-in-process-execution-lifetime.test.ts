import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { AsyncWorkScope, getAsyncWorkSignal } from "../shared/async-work-scope.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createInternalAgentTurnFacade } from "./agent-turn/internal-facade.js";
import { withLocalGatewayRequestScope } from "./local-request-context.js";
import { createGatewayMethodRegistry } from "./methods/registry.js";
import { observeHeldGatewayWorkDrain } from "./server-held-work.test-support.js";
import { dispatchGatewayRequestInProcessRaw } from "./server-in-process-dispatch.js";
import { closeKernelFixture, createKernelFixture } from "./server-kernel.fixture-test-support.js";
import type { GatewayRequestHandler } from "./server-methods/types.js";
import { createSyntheticPluginRuntimeClient } from "./server-plugin-runtime-client.js";

describe("in-process Gateway original execution ownership", () => {
  it.for(["raw", "typed"] as const)(
    "rejects %s dispatch when its inherited execution scope is closed",
    async (surface) => {
      const state = await createOpenClawTestState({ label: `closed-local-${surface}-execution` });
      const cfg = {};
      const scope = new AsyncWorkScope();
      const releaseCallback = createDeferred();
      let dispatch: Promise<unknown> | undefined;
      try {
        await scope.track(() => {
          // A callback retained by local work keeps its original async owner after drain.
          dispatch = releaseCallback.promise.then(() =>
            withLocalGatewayRequestScope({ deps: {}, getRuntimeConfig: () => cfg }, () => {
              const context = getPluginRuntimeGatewayRequestScope()?.context;
              if (!context) {
                throw new Error("local Gateway context was not created");
              }
              const client = createSyntheticPluginRuntimeClient({ scopes: ["operator.admin"] });
              const options = { client, context, timeoutMs: 1_000 };
              return surface === "raw"
                ? dispatchGatewayRequestInProcessRaw("agent.identity.get", {}, options)
                : createInternalAgentTurnFacade({ client, getContext: () => context }).dispatchRaw(
                    { message: "refuse closed local work", idempotencyKey: "closed-local-work" },
                    { timeoutMs: 1_000 },
                  );
            }),
          );
        });
        await scope.drain();
        const rejected = expect(dispatch).rejects.toThrow("Async work scope is closed");
        releaseCallback.resolve();
        await rejected;
      } finally {
        releaseCallback.resolve();
        await Promise.allSettled([dispatch]);
        await scope.drain();
        await state.cleanup();
      }
    },
  );

  it.for(["raw", "typed"] as const)(
    "keeps %s execution alive after acceptance until its Gateway can release dependencies",
    async (surface, { signal }) => {
      const fixture = await createKernelFixture(`gateway-${surface}-execution`);
      const release = createDeferred();
      const order: string[] = [];
      const originalCompletion = release.promise.then(() => {
        order.push("execution settled");
      });
      const accepted = { status: "accepted", runId: "in-process-tail" };
      const unblock = () => release.resolve();
      signal.addEventListener("abort", unblock, { once: true });
      let kernel: Awaited<ReturnType<typeof fixture.open>> | undefined;
      let closing: Promise<void> | undefined;
      let request: Promise<unknown> | undefined;
      try {
        await fixture.configure();
        kernel = await fixture.open({ sidecarStartup: undefined });
        kernel.kernel.setDispatchReady(true);
        kernel.kernel.unlockStartupMethods();
        kernel.kernel.markSidecarsReady();
        const client = createSyntheticPluginRuntimeClient({ scopes: ["operator.admin"] });
        const methodRegistry = createGatewayMethodRegistry([
          {
            name: "lifetime.rawTail",
            owner: { kind: "aux", area: "gateway-lifetime-proof" },
            scope: "operator.admin",
            handler: async ({ respond }: Parameters<GatewayRequestHandler>[0]) => {
              respond(true, accepted);
              await originalCompletion;
            },
          },
        ]);
        const serviceModule = await import("./agent-turn/agent-turn-service.js");
        const createService = serviceModule.createAgentTurnService;
        if (surface === "typed") {
          vi.spyOn(serviceModule, "createAgentTurnService").mockImplementationOnce((...args) => {
            const service = createService(...args);
            vi.spyOn(service, "startTurn").mockImplementationOnce(async ({ io }) => {
              io.emitAcceptance([true, accepted, undefined]);
              await originalCompletion;
            });
            return service;
          });
        }
        // These public in-process entry points must acquire their owner without ambient WS work.
        expect(getAsyncWorkSignal()).toBeUndefined();
        const options = { client, context: kernel.gatewayRequestContext, methodRegistry };
        request =
          surface === "raw"
            ? dispatchGatewayRequestInProcessRaw("lifetime.rawTail", {}, options)
            : createInternalAgentTurnFacade({
                client,
                getContext: () => kernel!.gatewayRequestContext,
              }).dispatchRaw({
                message: "hold the original turn",
                idempotencyKey: "in-process-tail",
              });
        expect(await request).toMatchObject({ ok: true, payload: accepted });
        expect(order).toEqual([]);
        kernel.registerGatewayLifetimeSidecars({
          stop: () => {
            order.push("dependencies stopped");
          },
        });
        const expectHeldWork = await observeHeldGatewayWorkDrain(
          () => kernel?.connectionWork.signal,
        );
        closing = kernel.closeOnStartupFailure();
        await expectHeldWork(closing);
        expect(order).toEqual([]);
        unblock();
        await originalCompletion;
        await closing;
        expect(order).toEqual(["execution settled", "dependencies stopped"]);
      } finally {
        unblock();
        try {
          await Promise.allSettled([request, originalCompletion, closing]);
          await closeKernelFixture(kernel, fixture.state);
        } finally {
          vi.restoreAllMocks();
          signal.removeEventListener("abort", unblock);
        }
      }
    },
  );
});
