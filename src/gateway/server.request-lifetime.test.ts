// Real Gateway proof: execute only on a machine with isolated SQLite coordination.
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../packages/gateway-protocol/src/client-info.js";
import type { ResponseFrame } from "../../packages/gateway-protocol/src/schema/frames.js";
import { isAgentRunRestartAbortReason } from "../agents/run-termination.js";
import { resolveStateDir } from "../config/paths.js";
import { waitForGatewayActiveWork } from "../infra/gateway-active-work.js";
import { initializeGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  getActiveGatewayRootWorkCount,
  getActiveGatewayRootWorkHolders,
  markGatewayRestartDraining,
} from "../process/gateway-work-admission.js";
import { getAsyncWorkSignal } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import * as agentJobs from "./agent-turn/agent-job.js";
import { observeHeldGatewayWorkDrain } from "./server-held-work.test-support.js";
import {
  getTestPluginRegistry,
  resetTestPluginRegistry,
  setTestPluginRegistry,
} from "./test-helpers.plugin-registry.js";
import {
  connectOk,
  createGatewaySuiteHarness,
  installGatewayTestHooks,
  onceMessage,
  rpcReq,
} from "./test-helpers.server.js";

installGatewayTestHooks({ scope: "suite" });

type GatewayHarness = Awaited<ReturnType<typeof createGatewaySuiteHarness>>;

async function closeTwice(
  gateway: GatewayHarness,
  options: Parameters<GatewayHarness["server"]["close"]>[0],
  onClosed: () => void,
) {
  await Promise.all(
    [options, { drainTimeoutMs: 0 }].map((closeOptions) =>
      gateway.server.close(closeOptions).then(onClosed),
    ),
  );
}

describe("public Gateway close request lifetime", () => {
  it.for([
    { name: "connected client", finish: "close" },
    { name: "disconnected client", finish: "disconnect" },
    { name: "client across committed restart drain", finish: "drain" },
  ] as const)(
    "retires agent.wait for a $name before zero-budget close joins it",
    async ({ finish }, { signal }) => {
      const runId = randomUUID();
      const entered = createDeferredCore();
      const originalWait = agentJobs.waitForAgentJob;
      let observed: ReturnType<typeof originalWait> | undefined;
      let requestSent = false;
      let settled = false;
      let emergencyRelease = false;
      const observation = vi.spyOn(agentJobs, "waitForAgentJob").mockImplementation((params) => {
        const wait = originalWait(params);
        if (params.runId === runId) {
          observed = wait.then((result) => {
            settled = true;
            return result;
          });
          entered.resolve();
        }
        return wait;
      });
      const releaseWait = () => {
        if (requestSent && !settled) {
          agentJobs.setGatewayDedupeEntry({
            dedupe: new Map(),
            key: `agent:${runId}`,
            entry: {
              ts: Date.now(),
              ok: true,
              payload: { runId, status: "ok", startedAt: 100, endedAt: 200 },
            },
          });
        }
      };
      signal.addEventListener("abort", releaseWait, { once: true });
      let gateway: GatewayHarness | undefined;
      let ws: WebSocket | undefined;
      let closing: Promise<void> | undefined;
      let releaseTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        gateway = await createGatewaySuiteHarness({
          serverOptions: { bind: "loopback", auth: { mode: "none" } },
        });
        await gateway.server.startupSettled;
        ws = await gateway.openWs();
        // A device-less local backend admits no history or pairing work alongside the waiter.
        await connectOk(ws, {
          scopes: ["operator.admin"],
          device: null,
          client: {
            id: GATEWAY_CLIENT_IDS.GATEWAY_CLIENT,
            mode: GATEWAY_CLIENT_MODES.BACKEND,
            version: "1.0.0",
            platform: "test",
          },
        });
        const response = onceMessage<Pick<ResponseFrame, "type" | "id" | "ok" | "error">>(
          ws,
          (frame) => frame.type === "res" && frame.id === "wait-for-shutdown",
        );
        const prematureReply = response.then((frame) => {
          throw new Error(
            `agent.wait returned before waiter registration: ${frame.error?.code ?? "success"}`,
          );
        });
        ws.send(
          JSON.stringify({
            type: "req",
            id: "wait-for-shutdown",
            method: "agent.wait",
            params: { runId, timeoutMs: 1_500_000 },
          }),
        );
        requestSent = true;
        await Promise.race([entered.promise, prematureReply]);
        expect(getActiveGatewayRootWorkCount(), getActiveGatewayRootWorkHolders().join(", ")).toBe(
          1,
        );
        // A failing owner is released through the real terminal registry, not an abandoned wait.
        releaseTimer = setTimeout(() => {
          emergencyRelease = true;
          releaseWait();
        }, 5_000);
        if (finish === "disconnect") {
          const disconnected = once(ws, "close");
          ws.close();
          await disconnected;
          await observed;
        } else if (finish === "drain") {
          markGatewayRestartDraining("stop (SIGTERM)");
          expect(await response).toMatchObject({
            ok: false,
            error: {
              code: "UNAVAILABLE",
              message: "agent.wait unavailable during gateway restart",
              retryable: true,
              retryAfterMs: 1_000,
              details: { reason: "gateway-restarting" },
            },
          });
          await observed;
        }
        await nextTurn();
        expect(settled).toBe(finish !== "close");
        expect(getActiveGatewayRootWorkCount()).toBe(finish === "close" ? 1 : 0);
        if (finish === "drain") {
          expect(await waitForGatewayActiveWork(0)).toMatchObject({ drained: true });
        }
        const finishedAtClose: boolean[] = [];
        closing = closeTwice(gateway, { reason: "wait lifetime proof", drainTimeoutMs: 0 }, () => {
          finishedAtClose.push(settled);
        });
        await closing;
        expect(emergencyRelease).toBe(false);
        expect(finishedAtClose).toEqual([true, true]);
        expect(settled).toBe(true);
        await expect(observed).resolves.toBeNull();
      } finally {
        clearTimeout(releaseTimer);
        releaseWait();
        await observed;
        ws?.terminate();
        await (closing ?? gateway?.server.close({ drainTimeoutMs: 0 }));
        observation.mockRestore();
        signal.removeEventListener("abort", releaseWait);
      }
    },
  );

  it("joins both handlers across restart drain and concurrent close before fixture restoration", async ({
    signal,
  }) => {
    const expectHeldWork = await observeHeldGatewayWorkDrain();
    const bothEntered = createDeferredCore();
    const release = createDeferredCore();
    const initialRoot = path.join(os.tmpdir(), "gateway-lifetime", "fixture");
    const selection = { OPENCLAW_STATE_DIR: initialRoot };
    const selectedRoots: string[] = [];
    const handlerRuns: Promise<void>[] = [];
    let enteredCount = 0;
    const registry = createEmptyPluginRegistry();
    registry.gatewayHandlers["test.lifetime"] = ({ respond }) => {
      const work = (async () => {
        if (++enteredCount === 2) {
          bothEntered.resolve();
        }
        // An accepted response is not completion of the handler's remaining work.
        respond(true, { accepted: true });
        await release.promise;
        selectedRoots.push(resolveStateDir(selection));
      })();
      handlerRuns.push(work);
      return work;
    };
    setTestPluginRegistry(registry);
    let gateway: GatewayHarness | undefined;
    let ws: WebSocket | undefined;
    const closing: Promise<void>[] = [];
    const finishedAtClose: number[] = [];
    const unblock = () => release.resolve();
    signal.addEventListener("abort", unblock, { once: true });
    try {
      gateway = await createGatewaySuiteHarness({
        serverOptions: { bind: "loopback", auth: { mode: "none" } },
      });
      ws = await gateway.openWs();
      await connectOk(ws, { scopes: ["operator.admin"] });
      const socket = ws;
      const accepted = [rpcReq(socket, "test.lifetime", {}), rpcReq(socket, "test.lifetime", {})];
      expect(await Promise.all(accepted)).toEqual([
        expect.objectContaining({ ok: true }),
        expect.objectContaining({ ok: true }),
      ]);
      await bothEntered.promise;
      const shutdown = onceMessage<{ type: string; event: string; payload: { reason: string } }>(
        socket,
        (frame) => frame.type === "event" && frame.event === "shutdown",
      );

      markGatewayRestartDraining("stop (SIGTERM)");
      for (let index = 0; index < 2; index++) {
        closing.push(
          gateway.server.close({ reason: "request lifetime proof" }).then(() => {
            finishedAtClose.push(selectedRoots.length);
            // Model fixture restoration with an explicit synthetic selector only.
            selection.OPENCLAW_STATE_DIR = path.join(os.tmpdir(), "gateway-lifetime", "restored");
            unblock();
          }),
        );
      }
      expect((await shutdown).payload.reason).toBe("request lifetime proof");
      await expectHeldWork(Promise.all(closing));
      unblock();
      await Promise.all(closing);
      await Promise.all(handlerRuns);
      expect(finishedAtClose).toEqual([2, 2]);
      expect(selectedRoots).toEqual([initialRoot, initialRoot]);
    } finally {
      unblock();
      // Public close is deliberately insufficient on the baseline. Join our own
      // continuations before the Gateway fixture can restore process state.
      await Promise.all(handlerRuns);
      ws?.terminate();
      await Promise.all(closing.length ? closing : gateway ? [gateway.server.close()] : []);
      resetTestPluginRegistry();
      signal.removeEventListener("abort", unblock);
    }
  });

  it("joins a returned catalog's held completion before zero-budget dependency retirement", async ({
    signal,
  }) => {
    const release = createDeferredCore();
    const connectionReleased = createDeferredCore();
    const order: string[] = [];
    const finishedAtClose: boolean[] = [];
    let publication: Promise<void> | undefined;
    let providerSignal: AbortSignal | undefined;
    let gatewaySignal: AbortSignal | undefined;
    let completionSettled = false;
    let drainFinished = false;
    const registry = createEmptyPluginRegistry();
    registry.sessionCatalogs.push({
      pluginId: "catalog-lifetime-proof",
      source: "test",
      provider: {
        id: "catalog-lifetime-proof",
        label: "Catalog lifetime proof",
        audience: "gateway-operators",
        supportsProcessHomeIsolation: true,
        list: async (params) => {
          providerSignal = params.signal;
          gatewaySignal = getAsyncWorkSignal();
          publication = release.promise
            .then(() =>
              params.onHost?.({
                hostId: "node:held",
                kind: "node",
                label: "Held host",
                connected: true,
                sessions: [],
              }),
            )
            .finally(() => {
              completionSettled = true;
              order.push("catalog completion settled");
            });
          params.waitUntil?.(publication);
          return [];
        },
        read: async () => {
          throw new Error("read is outside this catalog lifetime proof");
        },
      },
    });
    setTestPluginRegistry(registry);
    const unblock = () => release.resolve();
    signal.addEventListener("abort", unblock, { once: true });
    let gateway: GatewayHarness | undefined;
    let ws: WebSocket | undefined;
    let closing: Promise<void> | undefined;
    try {
      // Observe the real owner after the fixture's mock registration has loaded.
      const kernelModule = await import("./server-kernel.js");
      const createKernel = kernelModule.createGatewayKernel;
      vi.spyOn(kernelModule, "createGatewayKernel").mockImplementationOnce(async (...args) => {
        const kernel = await createKernel(...args);
        const register = kernel.connectionWork.registerConnection.bind(kernel.connectionWork);
        vi.spyOn(kernel.connectionWork, "registerConnection").mockImplementation((close) => {
          const releaseConnection = register(close);
          return () => {
            releaseConnection();
            connectionReleased.resolve();
          };
        });
        const drain = kernel.connectionWork.drain.bind(kernel.connectionWork);
        vi.spyOn(kernel.connectionWork, "drain").mockImplementation(async () => {
          await drain();
          drainFinished = true;
        });
        kernel.registerGatewayLifetimeSidecars({
          stop: () => {
            order.push("dependencies stopped");
          },
        });
        return kernel;
      });
      gateway = await createGatewaySuiteHarness({
        serverOptions: { bind: "loopback", auth: { mode: "none" } },
      });
      await gateway.server.startupSettled;
      ws = await gateway.openWs();
      await connectOk(ws, { scopes: ["operator.admin"] });
      expect(
        await rpcReq(ws, "sessions.catalog.list", {
          catalogId: "catalog-lifetime-proof",
          progressId: "held-catalog",
        }),
      ).toMatchObject({
        ok: true,
        payload: { catalogs: [{ id: "catalog-lifetime-proof", hosts: [] }] },
      });
      await nextTurn();
      expect(completionSettled).toBe(false);
      expect(providerSignal?.aborted).toBe(false);
      expect(gatewaySignal).toBeDefined();
      const disconnected = once(ws, "close");
      closing = closeTwice(gateway, { restartExpectedMs: 0, drainTimeoutMs: 0 }, () => {
        finishedAtClose.push(completionSettled);
      });
      await disconnected;
      // The server-side release follows actual socket bookkeeping. Once its microtasks
      // settle, the held catalog completion must be the remaining required work.
      await connectionReleased.promise;
      await nextTurn();
      const whileHeld = {
        drainFinished,
        order: [...order],
        retired: providerSignal?.aborted,
        restart: isAgentRunRestartAbortReason(gatewaySignal?.reason),
      };
      unblock();
      await publication;
      await closing;
      expect(whileHeld).toEqual({ drainFinished: false, order: [], retired: true, restart: true });
      expect(order).toEqual(["catalog completion settled", "dependencies stopped"]);
      expect(finishedAtClose).toEqual([true, true]);
    } finally {
      unblock();
      try {
        await Promise.allSettled([publication]);
        ws?.terminate();
        await (closing ?? gateway?.server.close({ drainTimeoutMs: 0 }));
        resetTestPluginRegistry();
      } finally {
        vi.restoreAllMocks();
        signal.removeEventListener("abort", unblock);
      }
    }
  });

  it("fences incoming RPCs while an asynchronous shutdown owner is still stopping", async ({
    signal,
  }) => {
    const stopping = createDeferredCore();
    const release = createDeferredCore();
    const registry = createEmptyPluginRegistry();
    let invoked = 0;
    registry.gatewayHandlers["test.lifetime"] = ({ respond }) => {
      invoked++;
      respond(true, { executed: true });
    };
    registry.typedHooks.push({
      pluginId: "lifetime-proof",
      hookName: "gateway_stop",
      source: "test",
      handler: async () => {
        stopping.resolve();
        await release.promise;
      },
    });
    setTestPluginRegistry(registry);
    let gateway: GatewayHarness | undefined;
    let ws: WebSocket | undefined;
    let closing: Promise<void> | undefined;
    const unblock = () => release.resolve();
    signal.addEventListener("abort", unblock, { once: true });
    try {
      gateway = await createGatewaySuiteHarness({
        serverOptions: { bind: "loopback", auth: { mode: "none" } },
      });
      ws = await gateway.openWs();
      await connectOk(ws, { scopes: ["operator.admin"] });
      initializeGlobalHookRunner(getTestPluginRegistry());
      closing = gateway.server.close({ reason: "incoming work fence proof" });
      await stopping.promise;
      if (ws.readyState === WebSocket.OPEN) {
        const response = onceMessage<{ type: string; id: string; ok: boolean }>(
          ws,
          (frame) => frame.type === "res" && frame.id === "late",
        ).catch((error: unknown) => {
          if (ws?.readyState === WebSocket.CLOSED) {
            return { type: "closed", id: "late", ok: false };
          }
          throw error;
        });
        ws.send(JSON.stringify({ type: "req", id: "late", method: "test.lifetime", params: {} }));
        expect((await response).ok).toBe(false);
      }
      expect(invoked).toBe(0);
    } finally {
      unblock();
      ws?.terminate();
      await (closing ?? gateway?.server.close());
      resetTestPluginRegistry();
      signal.removeEventListener("abort", unblock);
    }
  });
});
