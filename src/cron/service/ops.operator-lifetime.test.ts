// Accepted cron work must not borrow the initiating request's shorter-lived tool authority.
import { describe, expect, it, vi } from "vitest";
import {
  createCronRegressionState,
  createDueIsolatedJob,
  setupCronRegressionFixtures,
} from "../../../test/helpers/cron/service-regression-fixtures.js";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import { withGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import { createGitHubIdentityStatusTool } from "../../agents/tools/github-identity-status-tool.js";
import { createGatewayMethodRegistry } from "../../gateway/methods/registry.js";
import { captureGatewayOperatorRunAuthority } from "../../gateway/operator-run-authority.js";
import { createScheduledGatewayRunner } from "../../gateway/scheduled-run-gateway-context.js";
import { cronHandlers } from "../../gateway/server-methods/cron.js";
import type { GatewayRequestHandlerOptions } from "../../gateway/server-methods/types.js";
import {
  dispatchGatewayMethodInProcessRaw,
  withOperatorToolGatewayAuthority,
} from "../../gateway/server-plugin-in-process-dispatch.js";
import {
  createContext,
  createOperatorClient,
} from "../../gateway/server-plugin-in-process-dispatch.test-support.js";
import { withPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { runInDetachedAsyncContext } from "../../shared/detached-async-context.js";
import { CronService } from "../service.js";
import { saveCronStore } from "../store.js";
import { stop } from "./ops-lifecycle.js";
import { enqueueRun } from "./ops-run.js";
import { onTimer } from "./timer.test-support.js";

const fixtures = setupCronRegressionFixtures({ prefix: "cron-operator-lifetime-" });

describe("cron execution after initiating operator invocation ends", () => {
  it.each(["manual", "manual-rpc", "timer"] as const)(
    "permits the scheduled GitHub read via %s",
    async (route) => {
      const store = fixtures.makeStorePath();
      const now = Date.parse("2026-10-09T23:51:00Z");
      const job = createDueIsolatedJob({ id: "operator-lifetime", nowMs: now, nextRunAtMs: now });
      await saveCronStore(store.storePath, { version: 1, jobs: [job] });
      const context = createContext();
      context.resolveGatewayContext = () => context;
      const readResult = { effective: { credentialState: "available", refreshState: "idle" } };
      const readHandler = vi.fn(({ respond }: GatewayRequestHandlerOptions) =>
        respond(true, readResult),
      );
      context.getGatewayMethodRegistry = () =>
        createGatewayMethodRegistry([
          {
            name: "tools.github.status",
            scope: "operator.read",
            owner: { kind: "core", area: "sessions" },
            handler: readHandler,
          },
          {
            name: "cron.run",
            scope: "operator.write",
            owner: { kind: "core", area: "cron" },
            handler: cronHandlers["cron.run"]!,
          },
        ]);
      const client = createOperatorClient({
        profileName: "cron-lifetime",
        scopes: ["operator.read", "operator.write", "operator.admin"],
      });
      const source =
        route === "manual-rpc"
          ? await captureGatewayOperatorRunAuthority({ client, context })
          : undefined;
      if (source) {
        client.internal = { operatorRunAuthority: source.authority };
      }
      const payloadEntered = createDeferredCore();
      const continuePayload = createDeferredCore();
      const finished = createDeferredCore();
      let readError: string | undefined;
      let observed: unknown;
      let terminalError: string | undefined;
      const state = createCronRegressionState({
        storePath: store.storePath,
        nowMs: () => now,
        runSchedulerOwned: createScheduledGatewayRunner(() => context),
        onEvent: (event) => {
          if (event.action === "finished") {
            terminalError = event.error;
            finished.resolve();
          }
        },
        runIsolatedAgentJob: async () => {
          payloadEntered.resolve();
          await continuePayload.promise;
          try {
            const result = await withGatewayToolCallerIdentity(
              { agentId: "main", sessionKey: "agent:main:cron:operator-lifetime" },
              () => createGitHubIdentityStatusTool().execute("scheduled-github-check", {}),
            );
            observed = result.details;
            return { status: "ok" };
          } catch (error) {
            readError = String(error);
            return { status: "error", error: readError };
          }
        },
      });
      const cron = new CronService(state.deps);
      context.cron = cron;
      let timerRun: Promise<void> | undefined;
      try {
        await withPluginRuntimeGatewayRequestScope(
          { client, context, resolveGatewayContext: () => context, isWebchatConnect: () => false },
          () =>
            route === "manual-rpc"
              ? dispatchGatewayMethodInProcessRaw("cron.run", { id: job.id, mode: "force" }).then(
                  (result) => {
                    expect(result).toMatchObject({ ok: true, payload: { enqueued: true } });
                  },
                )
              : withOperatorToolGatewayAuthority(
                  {
                    authenticatedUserProfile: client.authenticatedUserProfile,
                    scopes: client.connect.scopes ?? [],
                  },
                  async () => {
                    if (route === "manual") {
                      expect(await enqueueRun(state, job.id, "force")).toMatchObject({
                        ok: true,
                        enqueued: true,
                      });
                    } else {
                      timerRun = runInDetachedAsyncContext(() => onTimer(state));
                    }
                  },
                ),
        );
        // Keep the source through admission, then finish the initiating turn before its payload tool read.
        if (source) {
          await awaitGateBeforeSettlement(
            payloadEntered.promise,
            finished.promise,
            "Manual cron run ended before entering its payload",
          );
          source.release();
        }
        continuePayload.resolve();
        await finished.promise;
        await timerRun;
        expect(terminalError).toBeUndefined();
        expect(readError).toBeUndefined();
        expect(observed).toEqual(readResult);
        expect(readHandler).toHaveBeenCalledOnce();
      } finally {
        continuePayload.resolve();
        stop(state);
        cron.stop();
        source?.release();
        await timerRun;
      }
    },
  );
});
