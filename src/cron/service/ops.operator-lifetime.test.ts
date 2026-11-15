// Accepted cron work must not borrow the initiating request's shorter-lived tool authority.
import { expect, it, vi } from "vitest";
import {
  createCronRegressionState,
  createDueIsolatedJob,
  setupCronRegressionFixtures,
} from "../../../test/helpers/cron/service-regression-fixtures.js";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import { withGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import { createGitHubIdentityStatusTool } from "../../agents/tools/github-identity-status-tool.js";
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
import { CronService, type CronEvent } from "../service.js";
import { saveCronStore } from "../store.js";
import { stop } from "./ops-lifecycle.js";
import { enqueueRun } from "./ops-run.js";
import { onTimer } from "./timer.test-support.js";

const fixtures = setupCronRegressionFixtures({ prefix: "cron-operator-lifetime-" });

it.each(["manual", "manual-rpc", "timer"] as const)(
  "permits the scheduled GitHub read via %s after the initiating operator invocation ends",
  async (route) => {
    const store = fixtures.makeStorePath();
    const now = Date.parse("2026-10-09T23:51:00Z");
    const job = createDueIsolatedJob({ id: "operator-lifetime", nowMs: now, nextRunAtMs: now });
    await saveCronStore(store.storePath, { version: 1, jobs: [job] });
    const readResult = { effective: { credentialState: "available", refreshState: "idle" } };
    const readHandler = vi.fn(({ respond }: GatewayRequestHandlerOptions) =>
      respond(true, readResult),
    );
    const context = createContext([
      ["tools.github.status", "operator.read", "sessions", readHandler],
      ["cron.run", "operator.write", "cron", cronHandlers["cron.run"]!],
    ]);
    context.resolveGatewayContext = () => context;
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
    const finished = createDeferredCore<CronEvent>();
    let observed: unknown;
    const state = createCronRegressionState({
      storePath: store.storePath,
      nowMs: () => now,
      runSchedulerOwned: createScheduledGatewayRunner(() => context),
      onEvent: (event) => {
        if (event.action === "finished") {
          finished.resolve(event);
        }
      },
      runIsolatedAgentJob: async () => {
        payloadEntered.resolve();
        await continuePayload.promise;
        const result = await withGatewayToolCallerIdentity(
          { agentId: "main", sessionKey: "agent:main:cron:operator-lifetime" },
          () => createGitHubIdentityStatusTool().execute("scheduled-github-check", {}),
        );
        observed = result.details;
        return { status: "ok" };
      },
    });
    const cron = new CronService(state.deps);
    context.cron = cron;
    let timerRun: Promise<void> | undefined;
    try {
      await withPluginRuntimeGatewayRequestScope(
        { client, context, resolveGatewayContext: () => context, isWebchatConnect: () => false },
        async () => {
          if (route === "manual-rpc") {
            const result = await dispatchGatewayMethodInProcessRaw("cron.run", {
              id: job.id,
              mode: "force",
            });
            expect(result).toMatchObject({ ok: true, payload: { enqueued: true } });
            return;
          }
          await withOperatorToolGatewayAuthority(
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
          );
        },
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
      const terminal = await finished.promise;
      await timerRun;
      expect(terminal.error).toBeUndefined();
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
