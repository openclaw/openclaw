import { expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { readGatewayRequestMutationAuthority } from "../../gateway/server-methods/session-mutation-guards.js";
import type { GatewayRequestHandlerOptions } from "../../gateway/server-methods/types.js";
import { createContext } from "../../gateway/server-plugin-in-process-dispatch.test-support.js";
import { createSyntheticPluginRuntimeClient } from "../../gateway/server-plugin-runtime-client.js";
import { withPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createOperationalRunInstanceRef } from "../admitted-run-context.js";
import { withGatewayToolCallerIdentity } from "./gateway-caller-context.js";
import { callAgentToolGatewayRequest } from "./in-process-gateway.js";
import { captureSessionStopCaller, stopSessionTool } from "./sessions-tool-control.js";

it.each(["current", "replaced target", "retired Gateway"] as const)(
  "retains slow Stop after the caller finishes while fencing a %s",
  (boundary) =>
    withOpenClawTestState({ scenario: "minimal" }, async () => {
      const cfg = { agents: { entries: { main: {} } } };
      setRuntimeConfigSnapshot(cfg);
      const target = { agentId: "main", sessionKey: "agent:main:yielded-parent" };
      await upsertSessionEntryCore(target, { sessionId: "parent-session", updatedAt: 1 });
      const entered = createDeferredCore();
      const resume = createDeferredCore();
      let cancelled = false;
      const settled = vi.fn<(result: Awaited<ReturnType<typeof stopSessionTool>>) => void>();
      const abort = async (options: GatewayRequestHandlerOptions) => {
        entered.resolve();
        await resume.promise;
        readGatewayRequestMutationAuthority(options).assertCurrent();
        cancelled = true;
        options.respond(true, { ok: true, status: "aborted", abortedRunId: "parent-run" });
      };
      const context = createContext(
        [["sessions.abort", "operator.write", "sessions", abort]],
        () => cfg,
      );
      const executions = vi.spyOn(context, "trackExecution");
      const settleExecutions = () =>
        Promise.allSettled(executions.mock.results.map(({ value }) => value));
      let gatewayCurrent = true;
      context.resolveGatewayContext = () => (gatewayCurrent ? context : undefined);
      let callerCurrent = true;
      const callerSignal = new AbortController();
      const caller = {
        agentId: "main",
        sessionKey: "agent:main:caller",
        operationalRunInstance: createOperationalRunInstanceRef("stop-caller"),
        receiptAuthority: () => callerCurrent,
        gatewayContextResolver: context.resolveGatewayContext,
      };
      const stopTarget: Parameters<typeof stopSessionTool>[0] = {
        cfg,
        agentId: target.agentId,
        key: target.sessionKey,
        expectedSessionId: "parent-session",
        operation: "stop",
        restricted: false,
        isRequesterSession: false,
      };
      const invokeStop = () =>
        stopSessionTool(
          stopTarget,
          {},
          callAgentToolGatewayRequest,
          captureSessionStopCaller(),
          callerSignal.signal,
        );
      let stop: Promise<unknown> | undefined;
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        stop = withPluginRuntimeGatewayRequestScope(
          {
            context,
            resolveGatewayContext: context.resolveGatewayContext,
            client: createSyntheticPluginRuntimeClient({
              scopes: ["operator.admin"],
              operatorRoleActor: { kind: "system" },
            }),
            isWebchatConnect: () => false,
          },
          () => withGatewayToolCallerIdentity(caller, invokeStop),
        ).then(settled);
        await Promise.race([entered.promise, stop]);
        await vi.advanceTimersByTimeAsync(5_000);
        expect(settled.mock.calls[0]?.[0].details).toMatchObject({
          status: "settling",
          abortedRunId: null,
        });
        expect(cancelled).toBe(false);
        callerCurrent = false;
        callerSignal.abort(new Error("Calling turn finished"));
        // Cross the former in-process deadline before allowing the Gateway effect.
        await vi.advanceTimersByTimeAsync(10_000);
        if (boundary === "replaced target") {
          await upsertSessionEntryCore(target, { sessionId: "replacement-session", updatedAt: 2 });
        } else if (boundary === "retired Gateway") {
          gatewayCurrent = false;
        }
        resume.resolve();
        await settleExecutions();
        expect(cancelled).toBe(boundary === "current");
      } finally {
        resume.resolve();
        await Promise.allSettled([stop]);
        await settleExecutions();
        executions.mockRestore();
        await vi.advanceTimersByTimeAsync(0);
        vi.useRealTimers();
      }
    }),
);
