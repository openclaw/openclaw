// Real Gateway proof: execute only on a machine with isolated SQLite coordination.
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../packages/gateway-protocol/src/client-info.js";
import { resolveStateDir } from "../config/paths.js";
import * as devicePairing from "../infra/device-pairing.js";
import * as questionChannel from "../infra/question-channel-runtime.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { getAsyncWorkSignal } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import * as approvalWebPush from "./approval-web-push.js";
import { issueOperatorToken } from "./device-authz.test-helpers.js";
import { createPluginGatewayMethodDescriptor } from "./methods/descriptor.js";
import * as approvalStore from "./operator-approval-store.js";
import { observeHeldGatewayWorkDrain } from "./server-held-work.test-support.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { resetTestPluginRegistry, setTestPluginRegistry } from "./test-helpers.plugin-registry.js";
import {
  connectOk,
  createGatewaySuiteHarness,
  installGatewayTestHooks,
  onceMessage,
  rpcReq,
} from "./test-helpers.server.js";

installGatewayTestHooks({ scope: "suite" });
afterEach(() => {
  vi.restoreAllMocks();
});

type GatewayHarness = Awaited<ReturnType<typeof createGatewaySuiteHarness>>;
type ObserverGateway = Awaited<ReturnType<typeof startObserverGateway>>;

async function withObserverGateway(run: (started: ObserverGateway) => Promise<void>) {
  const started = await startObserverGateway();
  try {
    await run(started);
  } finally {
    started.admin.terminate();
    await started.upgrades.close();
    started.questionManager.close();
    await started.gateway.server.close({ drainTimeoutMs: 0 });
    resetTestPluginRegistry();
  }
}

async function startObserverGateway() {
  const captured = createDeferredCore<GatewayRequestContext>();
  const registry = createEmptyPluginRegistry();
  registry.gatewayHandlers["test.observer-context"] = ({ context, respond }) => {
    captured.resolve(context);
    respond(true, { captured: true });
  };
  registry.gatewayMethodDescriptors.push(
    createPluginGatewayMethodDescriptor({
      pluginId: "observer-proof",
      name: "test.observer-context",
      handler: registry.gatewayHandlers["test.observer-context"],
    }),
  );
  setTestPluginRegistry(registry);
  let gateway: GatewayHarness | undefined;
  let admin: WebSocket | undefined;
  try {
    gateway = await createGatewaySuiteHarness({ serverOptions: { bind: "loopback" } });
    await gateway.server.startupSettled;
    admin = await gateway.openWs();
    await connectOk(admin, { scopes: ["operator.admin"] });
    expect((await rpcReq(admin, "test.observer-context", {})).ok).toBe(true);
    const { questionManager, scopeUpgradeCoordinator } = await captured.promise;
    if (!questionManager || !scopeUpgradeCoordinator) {
      throw new Error("Gateway observer owners were not initialized");
    }
    return { gateway, admin, questionManager, upgrades: scopeUpgradeCoordinator };
  } catch (error) {
    admin?.terminate();
    await gateway?.server.close({ drainTimeoutMs: 0 });
    resetTestPluginRegistry();
    throw error;
  }
}

async function admitObserverRpc(
  ws: WebSocket,
  method: string,
  params: Record<string, unknown>,
  entered: Promise<void>,
): Promise<void> {
  const id = randomUUID();
  const prematureReply = onceMessage<{ type: string; id: string; error?: { code?: string } }>(
    ws,
    (frame) => frame.type === "res" && frame.id === id,
  ).then((frame) => {
    throw new Error(
      `${method} returned before observer admission: ${frame.error?.code ?? "success"}`,
    );
  });
  ws.send(JSON.stringify({ type: "req", id, method, params }));
  await Promise.race([entered, prematureReply]);
}

async function requestPendingUpgrade(started: ObserverGateway, name: string) {
  const paired = await issueOperatorToken({
    name,
    approvedScopes: ["operator.read"],
    clientId: GATEWAY_CLIENT_IDS.TEST,
    clientMode: GATEWAY_CLIENT_MODES.TEST,
  });
  const ws = await started.gateway.openWs();
  try {
    await connectOk(ws, {
      skipDefaultAuth: true,
      deviceToken: paired.token,
      deviceIdentityPath: paired.identityPath,
      scopes: ["operator.read"],
    });
    const registration = await rpcReq<{ requestId: string }>(ws, "device.scopes.requestUpgrade", {
      scopes: ["operator.read", "operator.write"],
    });
    expect(registration.ok).toBe(true);
    const requestId = registration.payload?.requestId;
    if (!requestId) {
      throw new Error("Scope upgrade did not return a request id");
    }
    return { ws, requestId, deviceId: paired.deviceId };
  } catch (error) {
    ws.terminate();
    throw error;
  }
}

type ReadMode = "pending" | "queued-wake" | "held-pending" | "held-absent";
type ObserverResult =
  | Awaited<ReturnType<ObserverGateway["questionManager"]["waitAnswer"]>>
  | Awaited<ReturnType<ObserverGateway["upgrades"]["wait"]>>;

async function proveObserverLifetime(
  signal: AbortSignal,
  mode: "question" | ReadMode,
  disconnected: boolean,
) {
  const question = mode === "question";
  const holdRead = mode === "held-pending" || mode === "held-absent";
  const expectHeldWork = holdRead ? await observeHeldGatewayWorkDrain() : undefined;
  await withObserverGateway(async (started) => {
    const { admin, gateway, questionManager: questions, upgrades } = started;
    const entered = createDeferredCore();
    const releaseRead = createDeferredCore();
    const readPending = devicePairing.getPendingDevicePairing;
    const readPaired = devicePairing.getPairedDevice;
    const reads: Promise<unknown>[] = [];
    const terminal = question
      ? vi.spyOn(questionChannel, "handleQuestionChannelResolved")
      : undefined;
    let limited: Awaited<ReturnType<typeof requestPendingUpgrade>> | undefined;
    let observed: Promise<PromiseSettledResult<ObserverResult>> | undefined;
    let closing: Promise<void> | undefined;
    let rejection: Promise<void> | undefined;
    const stateDir = resolveStateDir();
    let atClose: { observerSettled: boolean; heldReadFinished: boolean } | undefined;
    let settled = false;
    let closeStarted = false;
    let heldReadFinished = false;
    let emergencyRelease = false;
    let pendingReads = 0;
    let postCloseReads = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const capture = (wait: Promise<ObserverResult>) => {
      observed = wait.then(
        (value) => {
          settled = true;
          return { status: "fulfilled", value };
        },
        (reason: unknown) => {
          settled = true;
          return { status: "rejected", reason };
        },
      );
    };
    const unblock = () => {
      releaseRead.resolve();
      if (question) {
        questions.close();
      } else if (limited && !settled) {
        const { requestId } = limited;
        rejection ??= devicePairing.rejectDevicePairing(requestId, stateDir).then(() => {
          upgrades.notify(requestId, "rejected");
        });
        void rejection.catch(() => {});
      }
    };
    signal.addEventListener("abort", unblock, { once: true });
    try {
      let id: string;
      let ws: WebSocket;
      let pairedBefore: Awaited<ReturnType<typeof readPaired>> = null;
      let pendingBefore: Awaited<ReturnType<typeof readPending>> = null;
      if (question) {
        const registration = await rpcReq<{ id: string }>(admin, "question.request", {
          questions: [
            {
              questionId: "target",
              header: "Target",
              question: "Deploy where?",
              options: [{ label: "Staging" }, { label: "Production" }],
            },
          ],
        });
        expect(registration.ok).toBe(true);
        if (!registration.payload?.id) {
          throw new Error("Question request did not return an id");
        }
        id = registration.payload.id;
        ws = admin;
        const originalWait = questions.waitAnswer.bind(questions);
        vi.spyOn(questions, "waitAnswer").mockImplementation((...args) => {
          const wait = originalWait(...args);
          if (args[0] === id) {
            capture(wait);
            entered.resolve();
          }
          return wait;
        });
      } else {
        limited = await requestPendingUpgrade(started, `observer-${randomUUID()}`);
        id = limited.requestId;
        ws = limited.ws;
        const { deviceId } = limited;
        pairedBefore = await readPaired(deviceId, stateDir);
        expect(pairedBefore).not.toBeNull();
        if (mode === "held-absent") {
          // A durable decision without an in-process notification.
          expect(await devicePairing.rejectDevicePairing(id, stateDir)).not.toBeNull();
        }
        pendingBefore = await readPending(id, stateDir);
        expect(Boolean(pendingBefore)).toBe(mode !== "held-absent");
        const originalWait = upgrades.wait.bind(upgrades);
        vi.spyOn(upgrades, "wait").mockImplementation((...args) => {
          const wait = originalWait(...args);
          if (args[0] === id) {
            capture(wait);
          }
          return wait;
        });
        vi.spyOn(devicePairing, "getPendingDevicePairing").mockImplementation((...args) => {
          if (args[0] !== id) {
            return readPending(...args);
          }
          pendingReads++;
          if (closeStarted) {
            postCloseReads++;
          }
          const firstRead = pendingReads === 1;
          const work = (async () => {
            const result = await readPending(...args);
            if (firstRead) {
              entered.resolve();
              if (holdRead) {
                await releaseRead.promise;
                heldReadFinished = true;
              }
            }
            return result;
          })();
          reads.push(work);
          return work;
        });
        vi.spyOn(devicePairing, "getPairedDevice").mockImplementation((...args) => {
          if (args[0] === deviceId && closeStarted) {
            postCloseReads++;
          }
          const work = readPaired(...args);
          reads.push(work);
          return work;
        });
      }
      await admitObserverRpc(
        ws,
        question ? "question.waitAnswer" : "device.scopes.waitUpgrade",
        question ? { id } : { requestId: id },
        entered.promise,
      );
      if (!holdRead) {
        timer = setTimeout(() => {
          if (!settled) {
            emergencyRelease = true;
            unblock();
          }
        }, 5_000);
      }
      if (disconnected) {
        const closed = once(ws, "close");
        ws.close();
        await closed;
        await observed;
      }
      if (mode === "held-pending") {
        // Wake the captured read with a real decision, independently of its poll timer.
        expect((await rpcReq(admin, "device.pair.reject", { requestId: id })).ok).toBe(true);
        pendingBefore = await readPending(id, stateDir);
        expect(pendingBefore).toBeNull();
      }
      await nextTurn();
      expect(settled).toBe(disconnected);
      if (question) {
        expect(questions.get(id)?.status).toBe("pending");
      }
      if (mode === "queued-wake") {
        upgrades.notify(id, "rejected");
      }
      closeStarted = true;
      closing = gateway.server
        .close({ reason: `${mode} observer lifetime proof`, drainTimeoutMs: 0 })
        .then(() => {
          atClose = { observerSettled: settled, heldReadFinished };
          // Preserve failure-path cleanup if public close returns before the held read.
          releaseRead.resolve();
        });
      if (expectHeldWork) {
        await expectHeldWork(closing);
        expect(atClose).toBeUndefined();
        expect(heldReadFinished).toBe(false);
        releaseRead.resolve();
      }
      await closing;
      expect(emergencyRelease).toBe(false);
      if (question) {
        expect(atClose?.observerSettled).toBe(true);
        await expect(observed).resolves.toEqual({
          status: "fulfilled",
          value: { status: "pending" },
        });
        expect(terminal).not.toHaveBeenCalled();
        expect(questions.get(id)).toBeNull();
      } else {
        expect(atClose).toEqual({ observerSettled: true, heldReadFinished: holdRead });
        expect(postCloseReads).toBe(0);
        await expect(observed).resolves.toMatchObject({
          status: "rejected",
          reason: { name: "AbortError" },
        });
        if (holdRead) {
          expect(pendingReads).toBe(1);
        }
        expect(await readPending(id, stateDir)).toEqual(pendingBefore);
        expect(limited && (await readPaired(limited.deviceId, stateDir))).toEqual(pairedBefore);
      }
    } finally {
      clearTimeout(timer);
      unblock();
      try {
        await rejection;
        await observed;
        await Promise.all(reads);
      } finally {
        limited?.ws.terminate();
        signal.removeEventListener("abort", unblock);
        await closing;
      }
    }
  });
}

describe("public Gateway close operator observer lifetime", () => {
  it("retires a never-used coordinator before a retained context can register late work", async () => {
    await withObserverGateway(async (started) => {
      await started.gateway.server.close({ drainTimeoutMs: 0 });
      expect(
        started.upgrades.register({
          requestId: "late-unused-coordinator",
          owner: { deviceId: "synthetic-device", publicKey: "synthetic-public-key" },
          requestedScopes: ["operator.read"],
          expiresAtMs: Date.now() + 60_000,
        }),
      ).toBe(false);
    });
  });
  it.for(["connected", "disconnected"] as const)(
    "detaches question.waitAnswer for a %s client without publishing a question decision",
    (connection, { signal }) =>
      proveObserverLifetime(signal, "question", connection === "disconnected"),
  );
  it.for([
    { name: "a disconnected pending poll", read: "pending" },
    { name: "a notification queued immediately before close", read: "queued-wake" },
    { name: "an in-flight pending read with a durable wake", read: "held-pending" },
    { name: "an in-flight absent read before paired-device lookup", read: "held-absent" },
  ] as const)(
    "retires $name before state release without changing the pairing decision",
    ({ read }, { signal }) => proveObserverLifetime(signal, read, read === "pending"),
  );
});

describe("public Gateway close startup presentation lifetime", () => {
  it("refuses startup when durable approval recovery fails", async () => {
    vi.spyOn(approvalStore, "recoverOperatorApprovalsOnStartup").mockRejectedValueOnce(
      new Error("synthetic approval recovery failure"),
    );
    await expect(
      createGatewaySuiteHarness({
        serverOptions: { bind: "loopback", auth: { mode: "none" } },
      }),
    ).rejects.toThrow("synthetic approval recovery failure");
  });

  it("starts without waiting for approval recovery but joins it before close returns", async ({
    signal,
  }) => {
    let recoverySignal: AbortSignal | undefined;
    const expectHeldWork = await observeHeldGatewayWorkDrain(() => recoverySignal);
    const release = createDeferredCore();
    const recoveries: Promise<void>[] = [];
    const createDelivery = approvalWebPush.createApprovalWebPushDelivery;
    let recoveryFinished = false;
    vi.spyOn(approvalWebPush, "createApprovalWebPushDelivery").mockImplementation((params) => {
      const delivery = createDelivery(params);
      const recover = delivery.recoverTerminalDeliveries.bind(delivery);
      vi.spyOn(delivery, "recoverTerminalDeliveries").mockImplementation(() => {
        recoverySignal = getAsyncWorkSignal();
        const work = (async () => {
          await release.promise;
          await recover();
          recoveryFinished = true;
        })();
        recoveries.push(work);
        return work;
      });
      return delivery;
    });
    const unblock = () => release.resolve();
    signal.addEventListener("abort", unblock, { once: true });
    let startup: Promise<GatewayHarness> | undefined;
    let closing: Promise<void> | undefined;
    let finishedAtClose: boolean | undefined;
    try {
      startup = createGatewaySuiteHarness({
        serverOptions: { bind: "loopback", auth: { mode: "none" } },
      });
      const gateway = await startup;
      // No RPC admits this work, and the held recovery must not delay public startup.
      expect(recoveries).toHaveLength(1);
      expect(recoveryFinished).toBe(false);

      closing = gateway.server
        .close({ reason: "startup approval recovery lifetime proof" })
        .then(() => {
          finishedAtClose = recoveryFinished;
          unblock();
        });
      await expectHeldWork(closing);
      unblock();
      await closing;
      await Promise.all(recoveries);
      expect(finishedAtClose).toBe(true);
      expect(recoveryFinished).toBe(true);
    } finally {
      unblock();
      signal.removeEventListener("abort", unblock);
      const [started] = await Promise.allSettled([startup]);
      try {
        // Baseline public close leaves recovery detached. Join the original operation
        // while the fixture still owns its synthetic state, even on the red path.
        await Promise.all(recoveries);
      } finally {
        await (closing ??
          (started.status === "fulfilled" ? started.value?.server.close() : undefined));
      }
    }
  });
});
