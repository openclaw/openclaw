import { once } from "node:events";
import { createServer } from "node:http";
import { rawDataToString } from "@openclaw/gateway-client/websocket-data";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import {
  validateWorkerInferenceTerminalFrame,
  type WorkerInferenceTerminalFrame,
} from "../../../packages/gateway-protocol/src/schema/worker-inference.js";
import { closeGatewayTestWebSocket } from "../../../test/helpers/gateway-websocket.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { abortSessionControllerInput } from "../../sessions/session-controller.mailbox.js";
import type { RpcSourceRef } from "../../sessions/session-controller.rpc-sources.js";
import { rpcSourceTesting } from "../../sessions/session-lifecycle-admission.test-support.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { reserveTestPortListener } from "../../test-utils/port-claims.js";
import { roleClient, rolePolicyConfig } from "../session-sharing.test-utils.js";
import * as sessionUtils from "../session-utils.js";
import { registerWorkerInferenceSessionControl } from "../worker-environments/inference-control-internal.js";
import { createWorkerInferenceServiceStub } from "../worker-environments/inference-control.test-helpers.js";
import { createWorkerInferenceManager } from "../worker-environments/inference.js";
import { identityFor, REQUEST } from "../worker-environments/inference.test-support.js";
import { createWorkerEnvironmentStore } from "../worker-environments/store.js";
import { createHistoryReadContext } from "./chat-history.test-helpers.js";
import { chatRpc } from "./chat-rpc-fixture.test-support.js";
import { createActiveRun } from "./chat.abort.test-helpers.js";
import { disposeSessionReadContexts } from "./sessions-read-cache.test-support.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";

const scope = {
  agentId: "main",
  sessionKey: "agent:main:abort-fence",
  sessionId: "current-session",
};

async function withAbortFixture(
  run: (fixture: Awaited<ReturnType<typeof createFixture>>) => Promise<void>,
) {
  await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
    const fixture = await createFixture();
    try {
      await run(fixture);
    } finally {
      for (const source of fixture.sources) {
        abortSessionControllerInput(source.input, "Fixture finished");
      }
      await Promise.all(fixture.sources.map((source) => source.input.settlement.promise));
      rpcSourceTesting.reset();
      await disposeSessionReadContexts();
    }
  });
}

async function createFixture() {
  const cfg = rolePolicyConfig();
  setRuntimeConfigSnapshot(cfg);
  const owner = roleClient("write", "abort-owner");
  owner.connId = "abort-owner";
  const other = roleClient("write", "abort-other");
  other.connId = "abort-other";
  const admin: GatewayClient = {
    ...owner,
    connect: { ...owner.connect, scopes: ["operator.admin"] },
  };
  // Keep the configured role ceiling consistent with the admin test connection.
  expectDefined(cfg.gateway?.roles?.definitions.write, "writer role").scopes.push("operator.admin");
  await upsertSessionEntryCore(scope, {
    sessionId: scope.sessionId,
    updatedAt: 1,
    createdActor: {
      type: "human",
      source: "profile",
      id: expectDefined(owner.authenticatedUserProfile, "owner profile").profileId,
    },
  });
  const context = await createHistoryReadContext({ getRuntimeConfig: () => cfg });
  const sources: RpcSourceRef[] = [];
  const register = (runId: string, sessionId = scope.sessionId, queued = true) => {
    const source = createActiveRun(scope.sessionKey, {
      agentId: scope.agentId,
      sessionId,
      owner: { connId: owner.connId },
      queued,
    });
    sources.push(source);
    rpcSourceTesting.set(runId, source);
    return source;
  };
  return {
    context,
    owner,
    other,
    admin,
    sources,
    register,
    abort: (params: Record<string, unknown>, client = admin) =>
      chatRpc(context, client, "chat.abort", { sessionKey: scope.sessionKey, ...params }),
  };
}

it("fences exact local runs without granting cancellation authority or stopping siblings", () =>
  withAbortFixture(async (f) => {
    const selected = f.register("selected", scope.sessionId, false);
    const sibling = f.register("sibling");
    const reject = async (params: Record<string, unknown>, message: string, client = f.admin) => {
      expect(await f.abort(params, client)).toMatchObject([
        false,
        undefined,
        { code: "INVALID_REQUEST", message },
      ]);
      expect(selected.input.abortSignal.aborted).toBe(false);
      expect(sibling.input.abortSignal.aborted).toBe(false);
    };
    await reject({ sessionId: scope.sessionId }, "sessionId requires an exact runId");
    await reject(
      { sessionId: "previous-session", runId: "selected" },
      "session incarnation changed",
    );
    await reject({ sessionId: scope.sessionId, runId: "selected" }, "unauthorized", f.other);
    const narrow = {
      ...f.owner,
      connect: { ...f.owner.connect, scopes: ["operator.sessions.write"] },
    };
    await reject(
      { sessionId: "previous-session", runId: "selected" },
      "session incarnation changed",
      narrow,
    );
    expect(await f.abort({ sessionId: scope.sessionId, runId: "selected" }, f.owner)).toMatchObject(
      [true, { aborted: true, runIds: ["selected"] }],
    );
    expect(selected.input.abortSignal.aborted).toBe(true);
    expect(sibling.input.abortSignal.aborted).toBe(false);
    expect(await f.abort({})).toMatchObject([true, { aborted: true, runIds: ["sibling"] }]);
    expect(sibling.input.abortSignal.aborted).toBe(true);
  }));

async function withWorkerTransport(
  context: GatewayRequestContext,
  run: (worker: {
    start: (runId: string, sessionId?: string) => Promise<AbortSignal>;
    frames: WorkerInferenceTerminalFrame[];
    flush: () => Promise<void>;
  }) => Promise<void>,
) {
  const listener = await reserveTestPortListener({ offsets: [0], createListener: createServer });
  const server = new WebSocketServer({ server: listener.listener });
  const connected = createDeferredCore<WebSocket>();
  server.once("connection", connected.resolve);
  const remote = new WebSocket("ws://127.0.0.1:" + listener.claim.port);
  const opened = once(remote, "open");
  const socket = await connected.promise;
  const frames: WorkerInferenceTerminalFrame[] = [];
  remote.on("message", (raw) => {
    const frame: unknown = JSON.parse(rawDataToString(raw));
    if (validateWorkerInferenceTerminalFrame(frame)) {
      frames.push(frame);
    }
  });
  const environments = await createWorkerEnvironmentStore();
  const entered = new Map<string, ReturnType<typeof createDeferredCore<AbortSignal>>>();
  const manager = createWorkerInferenceManager({
    execute: async ({ signal, request }) => {
      expectDefined(entered.get(request.runId), "worker execution").resolve(signal);
      await new Promise<void>((resolve) => {
        if (signal.aborted) {
          resolve();
        } else {
          signal.addEventListener("abort", () => resolve(), { once: true });
        }
      });
      return { type: "error", reason: "cancelled", message: "Inference cancelled" };
    },
  });
  try {
    await opened;
    await environments.createIntent({
      environmentId: "w",
      providerId: "fixture",
      profileId: "fixture",
      profileSnapshot: { settings: {} },
      provisionOperationId: "fixture-worker",
    });
    context.workerEnvironmentService = createWorkerInferenceServiceStub();
    registerWorkerInferenceSessionControl(context.workerEnvironmentService, manager);
    await run({
      frames,
      // An ordered wire barrier observes all frames sent before this call, not a timed absence.
      flush: async () => {
        const pong = once(socket, "pong");
        socket.ping();
        await pong;
      },
      start: async (runId, sessionId = scope.sessionId) => {
        const entry = createDeferredCore<AbortSignal>();
        entered.set(runId, entry);
        const request = { ...REQUEST, runId, sessionId };
        const result = await manager.start({
          request,
          identity: identityFor(request),
          sessionTarget: { ...scope, sessionId, storePath: "fixture-worker-store" },
          sink: {
            connectionId: "fixture-worker",
            send: (frame) => socket.send(JSON.stringify(frame)),
          },
        });
        expect(result.ok).toBe(true);
        if (!result.ok) {
          throw new Error("Worker admission failed: " + result.reason);
        }
        result.launch();
        return await entry.promise;
      },
    });
  } finally {
    await manager.stop();
    await environments.close();
    await Promise.all([closeGatewayTestWebSocket(remote), closeGatewayTestWebSocket(socket)]);
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    await listener.releaseListener();
    await listener.claim.release();
  }
}

it("fences worker Stop across stale authority and unreadable session facts, retaining unfenced best effort", () =>
  withAbortFixture(async (f) => {
    await withWorkerTransport(f.context, async (worker) => {
      const original = await worker.start("old-worker", "previous-session");
      const current = await worker.start("worker");
      const local = f.register("old-local", "previous-session");
      for (const runId of ["old-local", "old-worker"]) {
        expect(await f.abort({ sessionId: scope.sessionId, runId })).toMatchObject([
          false,
          undefined,
          { code: "INVALID_REQUEST", message: "runId does not match session incarnation" },
        ]);
      }
      expect(await f.abort({ sessionId: "previous-session", runId: "worker" })).toMatchObject([
        false,
        undefined,
        { code: "INVALID_REQUEST", message: "session incarnation changed" },
      ]);
      expect(await f.abort({ sessionId: scope.sessionId, runId: "worker" }, f.other)).toMatchObject(
        [false, undefined, { code: "INVALID_REQUEST", message: "unauthorized" }],
      );
      {
        const readSession = sessionUtils.loadGatewaySessionEntryReadOnlyInWorker;
        using _ = vi
          .spyOn(sessionUtils, "loadGatewaySessionEntryReadOnlyInWorker")
          .mockImplementationOnce(async (...args) => {
            const result = await readSession(...args);
            f.admin.connect.scopes = ["operator.read"];
            return result;
          });
        expect(await f.abort({ sessionId: scope.sessionId, runId: "worker" })).toMatchObject([
          false,
          undefined,
          { code: "FORBIDDEN" },
        ]);
      }
      await worker.flush();
      expect(worker.frames).toEqual([]);
      expect(current.aborted).toBe(false);
      expect(original.aborted).toBe(false);
      expect(local.input.abortSignal.aborted).toBe(false);
      f.admin.connect.scopes = ["operator.admin"];
      expect(await f.abort({ sessionId: scope.sessionId, runId: "worker" })).toMatchObject([
        true,
        { aborted: true, runIds: ["worker"] },
      ]);
      await worker.flush();
      expect(current.aborted).toBe(true);
      expect(original.aborted).toBe(false);
      expect(local.input.abortSignal.aborted).toBe(false);
      const terminals = () =>
        worker.frames.map(({ payload }) => [payload.runId, payload.sessionId, payload.outcome]);
      const stopped = ["worker", scope.sessionId, { type: "error", reason: "cancelled" }];
      expect(terminals()).toMatchObject([stopped]);

      // The old owners survive the exact stop and must also survive unreadable fenced requests.
      using _ = vi.spyOn(sessionUtils, "loadGatewaySessionEntryReadOnlyInWorker").mockRejectedValue(
        Object.assign(new Error("Synthetic session read failed"), {
          code: "ERR_SQLITE_ERROR",
          errcode: 5,
        }),
      );
      for (const runId of ["old-local", "old-worker"]) {
        expect(await f.abort({ sessionId: "previous-session", runId })).toMatchObject([
          false,
          undefined,
          { code: "UNAVAILABLE" },
        ]);
      }
      await worker.flush();
      expect(local.input.abortSignal.aborted).toBe(false);
      expect(original.aborted).toBe(false);
      expect(terminals()).toMatchObject([stopped]);
      // Without the opt-in fence, the captured owner still stops before the read error returns.
      for (const runId of ["old-local", "old-worker"]) {
        expect((await f.abort({ runId }))[0]).toBe(false);
      }
      await worker.flush();
      expect(local.input.abortSignal.aborted).toBe(true);
      expect(original.aborted).toBe(true);
      expect(terminals()).toMatchObject([
        stopped,
        ["old-worker", "previous-session", { type: "error", reason: "cancelled" }],
      ]);
    });
  }));
