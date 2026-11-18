import fsp from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import { prepareChildRuntimeFailure } from "../infra/child-runtime-viability.js";
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
  using runtimeStats = vi.spyOn(fsp, "stat");
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
  expect(runtimeStats.mock.calls.filter(([file]) => file === process.execPath)).toHaveLength(0);
});

it("serves all HTTP probes while runtime IO is held and reports recorded failures", async ({
  signal,
}) => {
  const entered = createDeferred();
  const resume = createDeferred();
  let draining = false;
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

        const stat = fsp.stat;
        using _ = vi.spyOn(fsp, "stat").mockImplementation(async (...args) => {
          const identity = await stat(...args);
          if (args[0] === process.execPath) {
            entered.resolve();
            await resume.promise;
          }
          return identity;
        });
        const inspection = getReadiness.prepare();
        try {
          await withinTest(entered.promise, signal);
          for (const pathname of ["/healthz", "/startupz", "/readyz"]) {
            const response = await readHttp(new URL(pathname, origin).href, {
              signal: AbortSignal.any([signal, AbortSignal.timeout(1_000)]),
            });
            expect(response.status).toBe(200);
          }
          draining = true;
          const response = await probe("/readyz");
          expect(response.status).toBe(503);
          expect(response.json()).toMatchObject({
            ready: false,
            coreReady: false,
            failing: ["gateway-draining"],
          });
          draining = false;
          await prepareChildRuntimeFailure({
            stderr: "node: error while loading shared libraries: libfixture.so",
          });
          const unavailable = await probe("/readyz");
          expect(unavailable.status).toBe(503);
          expect(unavailable.json()).toMatchObject({ failing: ["child-runtime"] });
        } finally {
          resume.resolve();
          await inspection;
        }
      } finally {
        server.closeAllConnections();
        await server[Symbol.asyncDispose]();
      }
    },
  });
});
