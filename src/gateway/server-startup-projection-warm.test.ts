import type { ServerResponse } from "node:http";
import { expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import { MAX_SESSION_ROW_FACTS_KEYS } from "../config/sessions/session-transcript-worker.types.js";
import { getActiveGatewayRootWorkCount } from "../process/gateway-work-admission.js";
import { getActiveSecretsRuntimeConfigSnapshot } from "../secrets/runtime-state.js";
import { runOpenClawAgentWriteTransaction } from "../state/openclaw-agent-db.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { getFreePort } from "../test-utils/ports.js";
import { buildControlUiSessionEntryUrl } from "./control-ui-session-entry-path.js";
import { createGatewayKernel } from "./server-kernel.js";
import type { GatewayServer } from "./server-public.js";
import * as rowReads from "./session-row-database-facts.js";
import * as projections from "./session-row-projection.js";

function createStartupState(label: string) {
  return createOpenClawTestState({
    label,
    layout: "home",
    env: {
      OPENCLAW_GATEWAY_PASSWORD: undefined,
      OPENCLAW_GATEWAY_TOKEN: undefined,
      OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
      OPENCLAW_SKIP_CANVAS_HOST: "1",
      OPENCLAW_SKIP_CHANNELS: "1",
      OPENCLAW_SKIP_CRON: "1",
      OPENCLAW_SKIP_GMAIL_WATCHER: "1",
      OPENCLAW_SKIP_PROVIDERS: "1",
      OPENCLAW_TEST_MINIMAL_GATEWAY: "1",
      VITEST: "1",
    },
  });
}

it("retains projection startup when an early session request disconnects", async ({ signal }) => {
  const port = await getFreePort();
  const token = "startup-projection-synthetic-token";
  const state = await createStartupState("startup-projection-http");
  const projectionEntered = createDeferred();
  const releaseProjection = createDeferred();
  const listenerBound = createDeferred();
  const releaseListening = createDeferred();
  const entryReceived = createDeferred<ServerResponse>();
  const secondEntryReceived = createDeferred<ServerResponse>();
  const entryClosed = createDeferred();
  const requests = new AbortController();
  const earlyRequest = new AbortController();
  const requestSignal = AbortSignal.any([signal, requests.signal]);
  const entryPath = `${buildControlUiSessionEntryUrl("/chat/main/topic", "")}&probe=1`;
  let startup: Promise<GatewayServer> | undefined;
  let earlyEntryRequest: Promise<Response> | undefined;
  let entryRequest: Promise<Response> | undefined;
  try {
    await state.writeConfig({
      gateway: { auth: { mode: "token", token }, controlUi: { enabled: true }, port },
      agents: { defaults: { model: "unit-test/model", utilityModel: "" } },
      plugins: { enabled: false },
      discovery: { mdns: { mode: "off" } },
      cron: { enabled: false },
    });
    state.applyEnv();
    replaceSessionEntrySync(
      { agentId: "main", sessionKey: "agent:main:topic" },
      { sessionId: "startup-http-topic", updatedAt: 1 },
    );
    const createProjection = projections.createSessionRowProjection;
    vi.spyOn(projections, "createSessionRowProjection").mockImplementation(async (params) => {
      projectionEntered.resolve();
      await releaseProjection.promise;
      return createProjection(params);
    });
    const transportModule = await import("./server-runtime-state.js");
    const createTransport = transportModule.createGatewayHttpTransport;
    vi.spyOn(transportModule, "createGatewayHttpTransport").mockImplementation(async (params) => {
      const transport = await createTransport(params);
      const entryResponses = [entryReceived, secondEntryReceived];
      transport.httpServer.on("request", (req, res) => {
        if (req.url === entryPath) {
          entryResponses.shift()?.resolve(res);
          res.once("close", entryClosed.resolve);
        }
      });
      return {
        ...transport,
        startListening: async () => {
          await transport.startListening();
          listenerBound.resolve();
          await releaseListening.promise;
        },
      };
    });
    const { startGatewayServerCore } = await import("./server-start.js");
    startup = startGatewayServerCore(port, {
      auth: { mode: "token", token },
      bind: "loopback",
      controlUiEnabled: true,
      sidecarStartup: "defer",
    });
    await withinTest(
      awaitGateBeforeSettlement(
        listenerBound.promise,
        startup,
        "Gateway startup completed before its listener was available",
      ),
      signal,
    );
    const read = (path: string, fetchSignal = requestSignal) =>
      fetch(`http://127.0.0.1:${port}${path}`, {
        headers: { authorization: `Bearer ${token}` },
        signal: fetchSignal,
      });
    earlyEntryRequest = read(entryPath, AbortSignal.any([requestSignal, earlyRequest.signal]));
    void earlyEntryRequest.catch(() => {});
    const entryResponse = await withinTest(
      awaitGateBeforeSettlement(
        entryReceived.promise,
        earlyEntryRequest,
        "Session entry request did not reach the Gateway listener",
      ),
      signal,
    );
    await withinTest(
      awaitGateBeforeSettlement(
        projectionEntered.promise,
        earlyEntryRequest,
        "Session entry request completed without preparing its session projection",
      ),
      signal,
    );
    for (const [path, expectedStatus] of [
      ["/healthz", 200],
      ["/startupz", 503],
      ["/readyz", 503],
    ] as const) {
      const response = await read(path);
      expect(response.status, path).toBe(expectedStatus);
      await response.arrayBuffer();
    }
    expect(entryResponse.writableEnded).toBe(false);
    earlyRequest.abort();
    await withinTest(entryClosed.promise, signal);
    entryRequest = read(entryPath);
    const secondEntryResponse = await withinTest(
      awaitGateBeforeSettlement(
        secondEntryReceived.promise,
        entryRequest,
        "Second session entry request did not reach the Gateway listener",
      ),
      signal,
    );
    expect(secondEntryResponse.writableEnded).toBe(false);
    releaseProjection.resolve();
    releaseListening.resolve();
    expect((await entryRequest).status).toBe(204);
    const server = await startup;
    await server.startupSettled;
  } finally {
    releaseProjection.resolve();
    releaseListening.resolve();
    requests.abort();
    try {
      const server = await startup?.catch(() => undefined);
      await server?.close();
      await earlyEntryRequest?.catch(() => undefined);
      await entryRequest?.catch(() => undefined);
    } finally {
      vi.restoreAllMocks();
      await state.cleanup();
    }
  }
});

it("refuses startup and disposes its projection when initial rows fail after the first batch", async () => {
  const port = await getFreePort();
  const token = "startup-projection-synthetic-token";
  const state = await createStartupState("startup-projection-warm");
  let kernel: Awaited<ReturnType<typeof createGatewayKernel>> | undefined;
  const disposed = vi.fn();
  try {
    await state.writeConfig({
      gateway: { auth: { mode: "token", token }, controlUi: { enabled: false }, port },
      agents: { defaults: { model: "unit-test/model", utilityModel: "" } },
      plugins: { enabled: false },
      discovery: { mdns: { mode: "off" } },
      cron: { enabled: false },
    });
    state.applyEnv();
    runOpenClawAgentWriteTransaction(
      () => {
        for (let index = 0; index <= MAX_SESSION_ROW_FACTS_KEYS; index++) {
          replaceSessionEntrySync(
            { agentId: "main", sessionKey: `agent:main:startup-warm-${index}` },
            { sessionId: `startup-warm-${index}`, updatedAt: index + 1 },
          );
        }
      },
      { agentId: "main" },
    );
    const failure = new Error("Initial session row batch unavailable");
    const readFacts = rowReads.withSessionRowDatabaseFacts;
    let batches = 0;
    vi.spyOn(rowReads, "withSessionRowDatabaseFacts").mockImplementation(async (...args) => {
      if ((args[0].selected ?? args[0].dirty).size > 0 && ++batches > 1) {
        throw failure;
      }
      return readFacts(...args);
    });
    const createProjection = projections.createSessionRowProjection;
    vi.spyOn(projections, "createSessionRowProjection").mockImplementation(async (params) => {
      const projection = await createProjection(params);
      const dispose = projection.dispose;
      vi.spyOn(projection, "dispose").mockImplementation(() => {
        dispose();
        disposed();
      });
      return projection;
    });
    const startup = createGatewayKernel(port, {
      auth: { mode: "token", token },
      bind: "loopback",
      controlUiEnabled: false,
      sidecarStartup: "defer",
    }).then((created) => {
      kernel = created;
    });
    await expect(startup).rejects.toBe(failure);
    expect(batches).toBeGreaterThan(1);
    expect(disposed).toHaveBeenCalledOnce();
    expect(getActiveGatewayRootWorkCount()).toBe(0);
    expect(getActiveSecretsRuntimeConfigSnapshot()).toBeNull();
  } finally {
    try {
      await kernel?.closeOnStartupFailure();
    } finally {
      vi.restoreAllMocks();
      await state.cleanup();
    }
  }
});
