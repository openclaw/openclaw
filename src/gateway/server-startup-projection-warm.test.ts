import type { ServerResponse } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import * as orphanMarking from "../agents/main-session-recovery/main-session-restart-recovery-marking.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import { MAX_SESSION_ROW_FACTS_KEYS } from "../config/sessions/session-transcript-worker.types.js";
import * as hostAccount from "../infra/host-account-name.js";
import { getActiveGatewayRootWorkCount } from "../process/gateway-work-admission.js";
import { getActiveSecretsRuntimeConfigSnapshot } from "../secrets/runtime-state.js";
import { runOpenClawAgentWriteTransaction } from "../state/openclaw-agent-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { readResidentGatewayOwnerProfile } from "../state/user-profile-list.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { getFreePort } from "../test-utils/ports.js";
import { buildControlUiSessionEntryUrl } from "./control-ui-session-entry-path.js";
import { createGatewayKernel } from "./server-kernel.js";
import type { GatewayServer } from "./server-public.js";
import * as rowReads from "./session-row-database-facts.js";
import * as projections from "./session-row-projection.js";

function observeProjectionDisposal(afterCreate?: () => Promise<void>) {
  const createProjection = projections.createSessionRowProjection;
  const disposed = vi.fn();
  vi.spyOn(projections, "createSessionRowProjection").mockImplementation(async (params) => {
    const projection = await createProjection(params);
    const dispose = projection.dispose;
    vi.spyOn(projection, "dispose").mockImplementation(disposed.mockImplementation(dispose));
    await afterCreate?.();
    return projection;
  });
  return disposed;
}

const token = "startup-projection-synthetic-token";
const basePath = "/health";
const startupOptions = { bind: "loopback", controlUiEnabled: false } as const;
const authenticatedOptions = {
  ...startupOptions,
  auth: { mode: "token", token },
  sidecarStartup: "defer",
} as const;
let state: Awaited<ReturnType<typeof createOpenClawTestState>>;
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await state?.cleanup();
});

async function createStartupState({ ui = false, anonymous = false } = {}) {
  const port = await getFreePort();
  state = await createOpenClawTestState({
    label: "startup-projection",
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
  await state.writeConfig({
    gateway: {
      auth: anonymous ? { mode: "none" } : { mode: "token", token },
      controlUi: ui
        ? { enabled: true, basePath, root: state.statePath("synthetic-ui") }
        : { enabled: false },
      port,
    },
    ...(!anonymous && { agents: { defaults: { model: "unit-test/model", utilityModel: "" } } }),
    plugins: { enabled: false },
    discovery: { mdns: { mode: "off" } },
    cron: { enabled: false },
  });
  state.applyEnv();
  return port;
}

it("completes startup and projection preparation before marking while retaining readiness gates", async ({
  signal,
}) => {
  const port = await createStartupState({ ui: true });
  const projectionEntered = createDeferred();
  const releaseProjection = createDeferred();
  const releaseTransport = createDeferred();
  const listenerBound = createDeferred();
  const releaseListening = createDeferred();
  const earlyRuntimeEntered = createDeferred();
  const releaseEarlyRuntime = createDeferred();
  const markingEntered = createDeferred();
  const releaseMarking = createDeferred();
  const entryReceived = createDeferred<ServerResponse>();
  const secondEntryReceived = createDeferred<ServerResponse>();
  const entryClosed = createDeferred();
  const requests = new AbortController();
  const earlyRequest = new AbortController();
  const requestSignal = AbortSignal.any([signal, requests.signal]);
  const waitFor = <T>(gate: PromiseLike<T>, operation: PromiseLike<unknown>) =>
    withinTest(
      awaitGateBeforeSettlement(gate, operation, "Checkpoint must precede settlement"),
      signal,
    );
  const entryPath = `${buildControlUiSessionEntryUrl(`${basePath}/chat/main/topic`, basePath)}&probe=1`;
  let startup: Promise<GatewayServer> | undefined;
  let projection: Awaited<ReturnType<typeof projections.createSessionRowProjection>> | undefined;
  let startupFinished = false;
  let earlyEntryRequest: Promise<Response> | undefined;
  let entryRequest: Promise<Response> | undefined;
  try {
    await state.writeText(
      "synthetic-ui/index.html",
      "<!doctype html><title>Startup fixture</title>",
    );
    vi.stubEnv("OPENCLAW_TEST_MINIMAL_GATEWAY", "");
    vi.spyOn(hostAccount, "resolveHostAccountName").mockResolvedValue("Startup Owner");
    replaceSessionEntrySync(
      { agentId: "main", sessionKey: "agent:main:topic" },
      { sessionId: "startup-http-topic", updatedAt: 1 },
    );
    replaceSessionEntrySync(
      { agentId: "main", sessionKey: "agent:main:orphan" },
      { sessionId: "startup-orphan", updatedAt: 1, abortedLastRun: true, status: "interrupted" },
    );
    const createProjection = projections.createSessionRowProjection;
    vi.spyOn(projections, "createSessionRowProjection").mockImplementation(async (params) => {
      projectionEntered.resolve();
      await releaseProjection.promise;
      projection = await createProjection(params);
      return projection;
    });
    const markOrphans = orphanMarking.markStartupOrphanedMainSessionsForRecovery;
    vi.spyOn(orphanMarking, "markStartupOrphanedMainSessionsForRecovery").mockImplementation(
      async (params) => {
        const result = await markOrphans(params);
        expect(result.marked).toBe(1);
        markingEntered.resolve();
        await releaseMarking.promise;
        return result;
      },
    );
    const transportModule = await import("./server-runtime-state.js");
    const createTransport = transportModule.createGatewayHttpTransport;
    vi.spyOn(transportModule, "createGatewayHttpTransport").mockImplementation(async (params) => {
      await releaseTransport.promise;
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
    const earlyModule = await import("./server-startup-early.js");
    const startEarlyRuntime = earlyModule.startGatewayEarlyRuntime;
    vi.spyOn(earlyModule, "startGatewayEarlyRuntime").mockImplementation(async (...args) => {
      earlyRuntimeEntered.resolve();
      await releaseEarlyRuntime.promise;
      return startEarlyRuntime(...args);
    });
    const { startGatewayServerCore } = await import("./server-start.js");
    startup = startGatewayServerCore(port, {
      ...authenticatedOptions,
      controlUiEnabled: true,
    }).then((server) => {
      startupFinished = true;
      return server;
    });
    await waitFor(projectionEntered.promise, startup);
    releaseTransport.resolve();
    await waitFor(listenerBound.promise, startup);
    const read = (path: string, fetchSignal = requestSignal) =>
      fetch(`http://127.0.0.1:${port}${path}`, {
        headers: { authorization: `Bearer ${token}` },
        signal: fetchSignal,
      });
    earlyEntryRequest = read(entryPath, AbortSignal.any([requestSignal, earlyRequest.signal]));
    void earlyEntryRequest.catch(() => {});
    const entryResponse = await waitFor(entryReceived.promise, earlyEntryRequest);
    await waitFor(projectionEntered.promise, earlyEntryRequest);
    for (const [path, expectedStatus, expectedBody] of [
      ["/healthz", 200, { ok: true, status: "live" }],
      ["/startupz", 503, { ok: false, status: "starting" }],
      ["/readyz", 503, { ready: false }],
    ] as const) {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, { signal: requestSignal });
      expect(response.status, path).toBe(expectedStatus);
      expect(await response.json(), path).toMatchObject(expectedBody);
    }
    expect(entryResponse.writableEnded).toBe(false);
    earlyRequest.abort();
    await withinTest(entryClosed.promise, signal);
    entryRequest = read(entryPath);
    const secondEntryResponse = await waitFor(secondEntryReceived.promise, entryRequest);
    expect(secondEntryResponse.writableEnded).toBe(false);
    releaseListening.resolve();
    await waitFor(earlyRuntimeEntered.promise, startup);
    expect(secondEntryResponse.writableEnded).toBe(false);
    releaseProjection.resolve();
    expect((await entryRequest).status).toBe(204);
    expect(readResidentGatewayOwnerProfile(resolveOpenClawStateSqlitePath())?.displayName).toBe(
      "Startup Owner",
    );
    expect(startupFinished).toBe(false);
    releaseEarlyRuntime.resolve();
    const server = await startup;
    await server.startupSettled;
    await withinTest(markingEntered.promise, signal);
    await projection?.ensureMaterialized();
    expect(
      projection?.describe({ agentId: "main", key: "agent:main:orphan" })?.entry
        .mainRestartRecovery,
    ).toBeDefined();
    const pendingReadiness = await read("/readyz");
    expect(pendingReadiness.status).toBe(503);
    await pendingReadiness.arrayBuffer();
    expect(startupFinished).toBe(true);
    releaseMarking.resolve();
    const unauthorized = await fetch(`http://127.0.0.1:${port}${entryPath}`, {
      signal: requestSignal,
    });
    expect(unauthorized.status).toBe(401);
    await unauthorized.arrayBuffer();
  } finally {
    releaseTransport.resolve();
    releaseProjection.resolve();
    releaseListening.resolve();
    releaseEarlyRuntime.resolve();
    releaseMarking.resolve();
    requests.abort();
    const server = await startup?.catch(() => undefined);
    await server?.close();
    await earlyEntryRequest?.catch(() => undefined);
    await entryRequest?.catch(() => undefined);
  }
});

it("joins and disposes a warming projection when transport creation fails", async ({ signal }) => {
  const port = await createStartupState({ anonymous: true });
  const projectionEntered = createDeferred();
  const releaseProjection = createDeferred();
  const transportFailed = createDeferred();
  const failure = new Error("Synthetic transport failure");
  let startup: Promise<GatewayServer> | undefined;
  let settled = false;
  try {
    const disposed = observeProjectionDisposal(async () => {
      projectionEntered.resolve();
      await releaseProjection.promise;
    });
    const transportModule = await import("./server-runtime-state.js");
    vi.spyOn(transportModule, "createGatewayHttpTransport").mockImplementation(async () => {
      await projectionEntered.promise;
      transportFailed.resolve();
      throw failure;
    });
    const { startGatewayServerCore } = await import("./server-start.js");
    startup = startGatewayServerCore(port, startupOptions);
    const markSettled = () => {
      settled = true;
    };
    void startup.then(markSettled, markSettled);
    await withinTest(
      awaitGateBeforeSettlement(transportFailed.promise, startup, "Transport did not fail"),
      signal,
    );
    expect(settled).toBe(false);
    expect(disposed).not.toHaveBeenCalled();
    releaseProjection.resolve();
    await expect(startup).rejects.toBe(failure);
    expect(disposed).toHaveBeenCalledOnce();
    expect(getActiveGatewayRootWorkCount()).toBe(0);
    expect(getActiveSecretsRuntimeConfigSnapshot()).toBeNull();
  } finally {
    releaseProjection.resolve();
    projectionEntered.resolve();
    const server = await startup?.catch(() => undefined);
    await server?.close();
  }
});

it("refuses startup and disposes its projection when initial rows fail after the first batch", async () => {
  const port = await createStartupState();
  let kernel: Awaited<ReturnType<typeof createGatewayKernel>> | undefined;
  try {
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
    const disposed = observeProjectionDisposal();
    const startup = createGatewayKernel(port, authenticatedOptions).then((created) => {
      kernel = created;
    });
    await expect(startup).rejects.toBe(failure);
    expect(batches).toBeGreaterThan(1);
    expect(disposed).toHaveBeenCalledOnce();
    expect(getActiveGatewayRootWorkCount()).toBe(0);
    expect(getActiveSecretsRuntimeConfigSnapshot()).toBeNull();
  } finally {
    await kernel?.closeOnStartupFailure();
  }
});
