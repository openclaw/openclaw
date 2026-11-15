import fsp from "node:fs/promises";
import { expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  nextEventLoopTurn,
  withinTest,
} from "../../test/helpers/promise.js";
import { observeMainThreadFs } from "../test-utils/main-thread-fs-spies.test-support.js";
import { createMockServerResponse } from "../test-utils/mock-http-response.js";
import { readHttp } from "./control-ui-fixture.test-support.js";
import { listenProvider } from "./gateway-provider-fixture.test-support.js";
import { createGatewayRequest } from "./hooks-test-helpers.js";
import { handleGatewayProbeRequest } from "./server-http-probes.js";
import { AUTH_NONE, withGatewayServer } from "./server-http.test-harness.js";
import { createReadinessChecker } from "./server/readiness.js";

it("serves repeated readyz probes without synchronous runtime filesystem checks", async () => {
  const getReadiness = createReadinessChecker({
    startedAt: Date.now(),
    channelManager: {
      getRuntimeSnapshot: () => ({ channels: {}, channelAccounts: {} }),
      getAutostartSuppression: () => null,
      isAmbientAutostartSuppressed: () => false,
    },
  });
  const probes = [0, 1].map(() => ({
    request: createGatewayRequest({ path: "/readyz" }),
    response: createMockServerResponse(),
  }));
  const handled: boolean[] = [];
  let syncCalls: number;
  let apis: Record<string, number>;
  {
    using filesystem = observeMainThreadFs();
    for (const { request, response } of probes) {
      handled.push(
        await handleGatewayProbeRequest(
          request,
          response,
          "/readyz",
          { mode: "none", allowTailscale: false },
          [],
          false,
          undefined,
          getReadiness,
        ),
      );
    }
    syncCalls = filesystem.count();
    apis = filesystem.calls();
  }
  expect(handled).toEqual([true, true]);
  for (const { response } of probes) {
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body ?? "null")).toMatchObject({
      ready: true,
      coreReady: true,
      failing: [],
    });
  }
  expect(syncCalls, JSON.stringify(apis)).toBe(0);
});

it("serves HTTP liveness while runtime IO is held and publishes current draining state", async ({
  signal,
}) => {
  const entered = createDeferred();
  const resume = createDeferred();
  let draining = false;
  let readyResponded = false;
  const getReadiness = createReadinessChecker({
    startedAt: Date.now(),
    getGatewayDraining: () => draining,
    channelManager: {
      getRuntimeSnapshot: () => ({ channels: {}, channelAccounts: {} }),
      getAutostartSuppression: () => null,
      isAmbientAutostartSuppressed: () => false,
    },
  });
  await withGatewayServer({
    prefix: "runtime-viability-http-owner",
    resolvedAuth: AUTH_NONE,
    overrides: { getReadiness },
    run: async (server) => {
      try {
        const origin = await listenProvider(server);
        const probe = (pathname: string) => readHttp(new URL(pathname, origin).href, { signal });
        const initial = await withinTest(probe("/readyz"), signal);
        expect(initial.status).toBe(200);
        expect(initial.json()).toMatchObject({ ready: true, coreReady: true, failing: [] });

        const access = fsp.access;
        using _ = vi.spyOn(fsp, "access").mockImplementation(async (file, mode) => {
          await access(file, mode);
          if (file === process.execPath) {
            entered.resolve();
            await resume.promise;
          }
        });
        const ready = probe("/readyz").then((response) => {
          readyResponded = true;
          return response;
        });
        try {
          await withinTest(
            awaitGateBeforeSettlement(
              entered.promise,
              ready,
              "Readiness skipped async runtime preparation",
            ),
            signal,
          );
          await withinTest(nextEventLoopTurn(), signal);
          const live = await withinTest(probe("/healthz"), signal);
          expect(live.status).toBe(200);
          expect(live.json()).toEqual({ ok: true, status: "live" });
          expect(readyResponded).toBe(false);
          draining = true;
          resume.resolve();
          const response = await withinTest(ready, signal);
          expect(response.status).toBe(503);
          expect(response.json()).toMatchObject({
            ready: false,
            coreReady: false,
            failing: ["gateway-draining"],
          });
        } finally {
          resume.resolve();
          await Promise.allSettled([ready]);
        }
      } finally {
        server.closeAllConnections();
        await server[Symbol.asyncDispose]();
      }
    },
  });
});
