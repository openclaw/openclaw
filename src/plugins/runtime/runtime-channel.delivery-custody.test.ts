import net from "node:net";
import path from "node:path";
import tls from "node:tls";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { disposeAcpSessionManagerInstance } from "../../acp/control-plane/manager.lifecycle.js";
import type { SessionAcpMeta } from "../../acp/control-plane/manager.types.js";
import {
  acpManagerRuntimeMocks,
  acpMocks,
  hookMocks,
  resetPluginTtsAndThreadMocks,
  sessionStoreMocks,
  setDiscordTestRegistry,
} from "../../auto-reply/reply/dispatch-from-config.shared.test-harness.js";
import { resetInboundDedupe } from "../../auto-reply/reply/inbound-dedupe.js";
import type { ChannelPlugin } from "../../channels/plugins/types.plugin.js";
import type { AcpRuntime } from "../../plugin-sdk/acp-runtime.js";
import {
  createPluginStateKeyedStoreForTests,
  createPluginStateKeyedStoreV2ForTests,
  createPluginStateSyncKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "../../plugin-sdk/plugin-state-test-runtime.js";
import { createPluginRuntimeMock } from "../../plugin-sdk/test-helpers/plugin-runtime-mock.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import { createSuiteTempRootTracker } from "../../test-helpers/temp-dir.js";
import { loadBundledPluginFacade } from "../../test-utils/bundled-plugin-public-surface.js";
import { buildPluginApi } from "../api-builder.js";
import { instrumentPluginInstanceApi } from "../api-facades.js";
import { createHookRunner } from "../hooks.js";
import { pluginInstanceInvocation } from "../plugin-instance-invocation.js";
import { getPluginInstanceRuntimeSlot } from "../plugin-instance-scope.js";
import { PluginInstance } from "../plugin-instance.js";
import { createEmptyPluginRegistry } from "../registry-empty.js";
import { createPluginRecord } from "../status.test-helpers.js";
import type { PluginRuntime } from "./types.js";

let AcpSessionManager: typeof import("../../acp/control-plane/manager.js").AcpSessionManager;
let dispatchReplyFromConfig: typeof import("../../auto-reply/reply/dispatch-from-config.js").dispatchReplyFromConfig;
let tryDispatchAcpReplyHook: typeof import("../../plugin-sdk/acpx.js").tryDispatchAcpReplyHook;
let createRuntimeChannel: typeof import("./runtime-channel.js").createRuntimeChannel;
const tempDirs = createSuiteTempRootTracker({ prefix: "openclaw-acp-matrix-custody-" });
let storePath: string;

function denyNetwork() {
  const denied = () => {
    throw new Error("OFFLINE_NETWORK_DENIED");
  };
  vi.spyOn(net.Socket.prototype, "connect").mockImplementation(denied);
  vi.spyOn(tls, "connect").mockImplementation(denied);
  vi.spyOn(globalThis, "fetch").mockImplementation(denied);
}

beforeAll(async () => {
  await tempDirs.setup();
  denyNetwork();
  ({ AcpSessionManager } = await import("../../acp/control-plane/manager.js"));
  ({ dispatchReplyFromConfig } = await import("../../auto-reply/reply/dispatch-from-config.js"));
  ({ tryDispatchAcpReplyHook } = await import("../../plugin-sdk/acpx.js"));
  ({ createRuntimeChannel } = await import("./runtime-channel.js"));
});

afterAll(async () => {
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
  resetPluginStateStoreForTests();
  await tempDirs.cleanup();
});

function ownedInstance(id: string) {
  const registry = createEmptyPluginRegistry();
  const record = createPluginRecord({ id });
  registry.plugins.push(record);
  return new PluginInstance(id, { record, registry });
}

const current = () => pluginInstanceInvocation.getStore()?.instance;

async function fixture(
  options: {
    retire?: boolean;
    observeOnly?: boolean;
    fail?: boolean;
    assembled?: boolean;
    ingress?: boolean;
    streaming?: boolean;
    prewrapped?: boolean;
    adapterStyle?: "prototype" | "own";
    matrix?: {
      agentId: string;
      roomId: string;
      setRuntime: (runtime: PluginRuntime) => void;
      sendText: NonNullable<NonNullable<ChannelPlugin["outbound"]>["sendText"]>;
      stateDir: string;
    };
  } = {},
) {
  const channelId = options.matrix ? "matrix" : "discord";
  const agentId = options.matrix?.agentId ?? "main";
  const channelOwner = ownedInstance(channelId);
  const acpOwner = ownedInstance(options.streaming ? "offline-agent" : "offline-acp");
  const started = createDeferred();
  const secondStarted = createDeferred();
  const proceed = createDeferred();
  const finalization = createDeferred();
  const delivered = createDeferred();
  const abort = new AbortController();
  let backendSignal: AbortSignal | undefined;
  const sends: string[] = [];
  const previews: string[] = [];
  const observers: string[] = [];
  const deliveryErrors: unknown[] = [];
  const backendRuns: string[] = [];
  const deliveryOwners: string[] = [];
  const messageIds: string[] = [];
  const channel = createRuntimeChannel({ dispatchReplyFromConfig });
  const registry = createEmptyPluginRegistry();
  const api = instrumentPluginInstanceApi(
    buildPluginApi({
      id: "offline-acp",
      name: "offline-acp",
      source: "offline",
      registrationMode: "discovery",
      config: {},
      runtime: { channel } as PluginRuntime,
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      resolvePath: (value) => value,
      handlers: {
        on(hookName, handler, registrationOptions) {
          registry.typedHooks.push({
            pluginId: "offline-acp",
            source: "offline",
            hookName,
            handler,
            ...registrationOptions,
          });
        },
      },
    }),
    acpOwner,
  );
  api.on("reply_dispatch", tryDispatchAcpReplyHook, { eligibleDispatchKinds: ["acp"] });
  const runner = createHookRunner(registry, { catchErrors: false });
  hookMocks.runner.hasHooks.mockImplementation(
    (name) => !options.streaming && name === "reply_dispatch",
  );
  hookMocks.runner.runReplyDispatch.mockImplementation((event, context) => {
    const hookContext = context as Parameters<typeof tryDispatchAcpReplyHook>[1];
    expect(hookContext.dispatchKind).toBe("acp");
    return runner.runReplyDispatch(event, hookContext);
  });
  let meta: SessionAcpMeta = {
    backend: "fixture",
    agent: agentId,
    mode: "persistent",
    runtimeSessionName: "fixture",
    state: "idle",
    lastActivityAt: Date.now(),
  };
  const runtime: AcpRuntime = {
    ensureSession: async ({ sessionKey, agentId: sessionAgentId }) => ({
      sessionKey,
      agentId: sessionAgentId,
      backend: "fixture",
      runtimeSessionName: "fixture",
    }),
    cancel: async () => {},
    close: async () => {},
    async *runTurn({ handle, signal }) {
      expect(current()).toBe(acpOwner);
      backendSignal = signal;
      backendRuns.push(handle.sessionKey);
      if (handle.sessionKey.endsWith("second")) {
        secondStarted.resolve();
      } else {
        started.resolve();
      }
      if (options.retire) {
        await proceed.promise;
      }
      signal?.throwIfAborted();
      yield { type: "text_delta", text: "offline final", stream: "output" };
      yield { type: "done", stopReason: "end_turn" };
    },
  };
  const backend = { id: "fixture", runtime: acpOwner.wrap(runtime) };
  const sessionKey = `agent:${agentId}:acp:${options.matrix?.roomId ?? "custody"}`;
  const session = (params: { sessionKey: string } = { sessionKey }) => ({
    sessionKey: params.sessionKey,
    storeSessionKey: params.sessionKey,
    cfg: {},
    storePath,
    entry: {
      sessionId: "fixture",
      updatedAt: Date.now(),
      ...(options.streaming ? {} : { acp: meta }),
    },
    ...(options.streaming ? {} : { acp: meta }),
  });
  acpMocks.readAcpSessionEntry.mockImplementation(session);
  sessionStoreMocks.currentEntry = session().entry;
  const manager = new AcpSessionManager({
    listAcpSessions: async () => [],
    loadSessionEntry: session,
    loadSessionEntryAsync: async (params) => session(params),
    prepareSessionControlRead: async () => {
      throw new Error("OFFLINE_UNEXPECTED_SESSION_CONTROL");
    },
    upsertSessionMetaForControl: async () => {
      throw new Error("OFFLINE_UNEXPECTED_SESSION_CONTROL");
    },
    upsertSessionMeta: async ({ mutate, assertCommitAllowed }) => {
      assertCommitAllowed?.();
      meta = mutate(meta, session().entry) ?? meta;
      return session().entry;
    },
    getRuntimeBackend: () => backend,
    requireRuntimeBackend: () => backend,
  });
  acpManagerRuntimeMocks.getAcpSessionManager.mockReturnValue(manager);
  channelOwner.run(() => {
    getPluginInstanceRuntimeSlot("delivery-fixture")!.runtime = sends;
    if (options.matrix) {
      const { stateDir } = options.matrix;
      const stateEnv = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      const matrixRuntime = createPluginRuntimeMock();
      matrixRuntime.channel = channel;
      matrixRuntime.state.resolveStateDir = () => stateDir;
      matrixRuntime.state.openKeyedStore = (storeOptions) =>
        createPluginStateKeyedStoreForTests("matrix", { ...storeOptions, env: stateEnv });
      matrixRuntime.state.openKeyedStoreV2 = (storeOptions, authority) =>
        createPluginStateKeyedStoreV2ForTests(
          "matrix",
          { ...storeOptions, env: stateEnv },
          {
            assertCurrent: () => {
              channelOwner.run(() => channelOwner.lifecycle.signal.throwIfAborted());
              authority?.assertCurrent();
            },
            sessionEntryCurrent: authority?.sessionEntryCurrent,
          },
        );
      matrixRuntime.state.openSyncKeyedStore = (storeOptions) =>
        createPluginStateSyncKeyedStoreForTests("matrix", { ...storeOptions, env: stateEnv });
      options.matrix.setRuntime(matrixRuntime);
    }
  });
  const oldQueued = channelOwner.wrap(() => sends.push("stale"));
  const start = (owner: PluginInstance, key: string, sink: string[]) =>
    owner.run(() => {
      const cfg = {
        session: { store: storePath },
        diagnostics: { enabled: false },
        acp: {
          enabled: !options.streaming,
          dispatch: { enabled: !options.streaming },
          allowedAgents: [agentId],
        },
        ...(options.matrix
          ? {
              channels: {
                matrix: {
                  homeserver: "http://127.0.0.1:8008",
                  userId: "@bot:example.org",
                  accessToken: "synthetic-matrix-custody",
                  encryption: false,
                  network: { dangerouslyAllowPrivateNetwork: true },
                },
              },
            }
          : {}),
      };
      const turn = {
        cfg,
        channel: channelId,
        route: { agentId, sessionKey: key },
        ctxPayload: {
          Body: "question",
          BodyForAgent: "question",
          RawBody: "question",
          Provider: channelId,
          Surface: channelId,
          SessionKey: key,
          From: "sender",
          To: options.matrix?.roomId ?? "channel:123",
          CommandAuthorized: true,
        },
        admission: { kind: options.observeOnly ? "observeOnly" : "dispatch", reason: "fixture" },
        replyOptions: {
          abortSignal: abort.signal,
          ...(options.streaming
            ? {
                onPartialReply: (payload: { text?: string }) => {
                  expect(current()).toBe(owner);
                  expect(getPluginInstanceRuntimeSlot("delivery-fixture")?.runtime).toBe(sink);
                  previews.push(payload.text!);
                },
              }
            : {}),
        },
        replyResolver: options.streaming
          ? acpOwner.wrap(async (ctx, replyOptions) => {
              expect(current()).toBe(acpOwner);
              backendSignal = replyOptions?.abortSignal;
              backendRuns.push(ctx.SessionKey!);
              started.resolve();
              if (options.retire) {
                await proceed.promise;
              }
              backendSignal?.throwIfAborted();
              await replyOptions?.onPartialReply?.({ text: "offline preview" });
              return { text: "offline final" };
            })
          : async () => {
              throw new Error("OFFLINE_UNEXPECTED_AGENT_DISPATCH");
            },
        delivery: {
          async deliver(payload) {
            deliveryOwners.push(current()?.pluginId ?? "none");
            expect(current()).toBe(owner);
            expect(getPluginInstanceRuntimeSlot("delivery-fixture")?.runtime).toBe(sink);
            delivered.resolve();
            if (options.fail) {
              throw new Error("synthetic transport failure");
            }
            sink.push(payload.text!);
            const sent = options.matrix
              ? await options.matrix.sendText({
                  cfg,
                  to: options.matrix.roomId,
                  text: payload.text!,
                  accountId: "default",
                })
              : undefined;
            if (sent) {
              messageIds.push(sent.messageId);
            }
            return {
              visibleReplySent: true,
              ...(sent ? { messageIds: [sent.messageId], receipt: sent.receipt } : {}),
              finalization: finalization.promise.then(() => ({ visibleReplySent: true })),
            };
          },
          onDelivered() {
            expect(current()).toBe(owner);
            observers.push("delivered");
          },
          onError(error: unknown) {
            expect(current()).toBe(owner);
            observers.push("error");
            deliveryErrors.push(error);
          },
        },
      } satisfies Parameters<typeof channel.inbound.dispatch>[0];
      if (options.adapterStyle) {
        const delivery = turn.delivery;
        class Delivery {
          #delegate = delivery;
          deliver(...args: Parameters<typeof delivery.deliver>) {
            return this.#delegate.deliver(...args);
          }
          onDelivered() {
            this.#delegate.onDelivered();
          }
          onError(error: unknown) {
            this.#delegate.onError(error);
          }
        }
        const instance = new Delivery();
        if (options.adapterStyle === "own") {
          for (const methodName of ["deliver", "onDelivered", "onError"] as const) {
            Object.defineProperty(instance, methodName, {
              value: instance[methodName],
              enumerable: true,
            });
          }
        }
        turn.delivery = Object.freeze(instance);
      }
      if (options.prewrapped) {
        turn.delivery = owner.wrap(turn.delivery);
        turn.replyOptions = owner.wrap(turn.replyOptions);
      }
      if (options.ingress) {
        const adapter = {
          ingest: (raw: { id: string; text: string }) => ({ id: raw.id, rawText: raw.text, raw }),
          resolveTurn: () => turn,
        };
        class Ingress {
          #turn = turn;
          ingest(raw: { id: string; text: string }) {
            expect(this.#turn).toBe(turn);
            return adapter.ingest(raw);
          }
          resolveTurn() {
            return this.#turn;
          }
          onFinalize() {
            expect(this.#turn).toBe(turn);
            observers.push("finalized");
          }
        }
        return channel.inbound.run({
          channel: channelId,
          raw: { id: key, text: "question" },
          adapter: options.adapterStyle ? new Ingress() : adapter,
        });
      }
      if (options.assembled) {
        return channel.inbound.dispatchReply({
          ...turn,
          agentId: "main",
          routeSessionKey: key,
          storePath,
          recordInboundSession: async () => {},
          dispatchReplyFromConfig,
          dispatchReplyWithBufferedBlockDispatcher:
            channel.reply.dispatchReplyWithBufferedBlockDispatcher,
        });
      }
      return channel.inbound.dispatch(turn);
    });
  const work = start(channelOwner, sessionKey, sends);
  return {
    start,
    disposeManager: () => disposeAcpSessionManagerInstance(manager, "fixture-complete"),
    channelOwner,
    acpOwner,
    started,
    abort,
    backendSignal: () => backendSignal,
    secondStarted,
    proceed,
    finalization,
    delivered,
    sends,
    previews,
    observers,
    deliveryErrors,
    backendRuns,
    deliveryOwners,
    messageIds,
    oldQueued,
    work,
  };
}

beforeEach(async () => {
  storePath = path.join(await tempDirs.make(), "sessions.json");
  vi.clearAllMocks();
  denyNetwork();
  setDiscordTestRegistry();
  resetInboundDedupe();
  resetPluginTtsAndThreadMocks();
  sessionStoreMocks.currentEntry = undefined;
  sessionStoreMocks.loadSessionEntry
    .mockReset()
    .mockImplementation(() => sessionStoreMocks.currentEntry);
  sessionStoreMocks.loadSessionStoreEntry
    .mockReset()
    .mockImplementation(() => sessionStoreMocks.currentEntry);
  sessionStoreMocks.resolveSessionStorePathCore.mockReset().mockReturnValue(storePath);
});

afterEach(() => vi.restoreAllMocks());

describe("registered ACP channel delivery custody", () => {
  it.each([
    { adapterStyle: "prototype", ingress: false },
    { adapterStyle: "own", ingress: false },
    { adapterStyle: "prototype", ingress: true },
    { adapterStyle: "own", ingress: true },
  ] as const)(
    "preserves frozen class adapters (ingress: $ingress, $adapterStyle)",
    async (options) => {
      const f = await fixture({ ...options, streaming: true });
      try {
        f.finalization.resolve();
        await f.work;
        expect(f.previews).toEqual(["offline preview"]);
        expect(f.sends).toEqual(["offline final"]);
        expect(f.observers).toEqual(options.ingress ? ["delivered", "finalized"] : ["delivered"]);
        expect(f.channelOwner.hasRetainedConsumers).toBe(false);
      } finally {
        f.finalization.resolve();
        await Promise.allSettled([f.work]);
        await f.channelOwner.dispose();
        await f.acpOwner.dispose();
        await f.disposeManager();
      }
    },
  );

  it("sends fresh persistent Claude and Codex ACP finals through the Matrix formatter and client", async () => {
    const { matrixPlugin } = await loadBundledPluginFacade<{ matrixPlugin: ChannelPlugin }>({
      pluginId: "matrix",
      artifactBasename: "channel-plugin-api.js",
    });
    const { MatrixClient, setMatrixRuntime } = await loadBundledPluginFacade<{
      MatrixClient: {
        prototype: {
          start: () => Promise<void>;
          drainPendingDecryptions: () => Promise<void>;
          stopAndPersist: () => Promise<void>;
          stopWithoutPersist: () => Promise<void>;
          prepareRoomForMessageSend: () => Promise<"m.room.message" | "m.room.encrypted">;
          getJoinedRoomMembers: () => Promise<string[]>;
          sendMessage: () => Promise<string>;
        };
      };
      setMatrixRuntime: (runtime: PluginRuntime) => void;
    }>({
      pluginId: "matrix",
      artifactBasename: "test-api.js",
    });
    const sendText = matrixPlugin.outbound?.sendText;
    if (!sendText) {
      throw new Error("Matrix text transport is unavailable");
    }
    vi.spyOn(MatrixClient.prototype, "start").mockResolvedValue(undefined);
    vi.spyOn(MatrixClient.prototype, "drainPendingDecryptions").mockResolvedValue(undefined);
    vi.spyOn(MatrixClient.prototype, "stopAndPersist").mockResolvedValue(undefined);
    vi.spyOn(MatrixClient.prototype, "stopWithoutPersist").mockResolvedValue(undefined);
    vi.spyOn(MatrixClient.prototype, "prepareRoomForMessageSend").mockResolvedValue(
      "m.room.message",
    );
    vi.spyOn(MatrixClient.prototype, "getJoinedRoomMembers").mockResolvedValue([]);
    const sendMessage = vi
      .spyOn(MatrixClient.prototype, "sendMessage")
      .mockResolvedValue("$synthetic-final:example.org");
    for (const agentId of ["claude", "codex"]) {
      const roomId = `!${agentId}:example.org`;
      const f = await fixture({
        ingress: true,
        matrix: {
          agentId,
          roomId,
          setRuntime: setMatrixRuntime,
          sendText,
          stateDir: await tempDirs.make(),
        },
      });
      try {
        f.finalization.resolve();
        await f.work;
        expect(f.backendRuns).toEqual([`agent:${agentId}:acp:${roomId}`]);
        expect(f.deliveryOwners).toEqual(["matrix"]);
        expect(f.deliveryErrors).toEqual([]);
        expect(f.observers).toEqual(["delivered"]);
        expect(f.messageIds).toEqual(["$synthetic-final:example.org"]);
        expect(sendMessage).toHaveBeenLastCalledWith(
          roomId,
          expect.objectContaining({ msgtype: "m.text", body: "offline final" }),
          undefined,
          undefined,
        );
        expect(f.channelOwner.hasRetainedConsumers).toBe(false);
      } finally {
        f.finalization.resolve();
        await Promise.allSettled([f.work]);
        await f.channelOwner.dispose();
        await f.acpOwner.dispose();
        await f.disposeManager();
      }
    }
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])(
    "keeps fresh agent streaming callbacks with the channel owner (ingress: %s)",
    async (ingress) => {
      const f = await fixture({ streaming: true, ingress });
      try {
        f.finalization.resolve();
        await f.work;
        expect(f.previews).toEqual(["offline preview"]);
        expect(f.sends).toEqual(["offline final"]);
        expect(f.observers).toEqual(["delivered"]);
        expect(f.channelOwner.hasRetainedConsumers).toBe(false);
      } finally {
        f.finalization.resolve();
        await Promise.allSettled([f.work]);
        await f.channelOwner.dispose();
        await f.acpOwner.dispose();
        await f.disposeManager();
      }
    },
  );

  it.each([false, true])(
    "retains raw ingress delivery until finalization (prewrapped: %s)",
    async (prewrapped) => {
      const f = await fixture({ retire: true, ingress: true, prewrapped });
      try {
        expect(
          await Promise.race([
            f.started.promise.then(() => "started"),
            f.work.then(() => "completed"),
          ]),
        ).toBe("started");
        expect(f.channelOwner.hasRetainedConsumers).toBe(true);
        f.channelOwner.quiesce();
        const retired = f.channelOwner.dispose();
        f.proceed.resolve();
        expect(
          await Promise.race([
            f.delivered.promise.then(() => "delivered"),
            f.work.then(() => "completed"),
          ]),
        ).toBe("delivered");
        expect(f.channelOwner.hasRetainedConsumers).toBe(true);
        f.finalization.resolve();
        await f.work;
        expect((await retired).errors).toEqual([]);
        expect(f.sends).toEqual(["offline final"]);
        expect(f.channelOwner.hasRetainedConsumers).toBe(false);
      } finally {
        f.proceed.resolve();
        f.finalization.resolve();
        await Promise.allSettled([f.work]);
        await f.channelOwner.dispose();
        await f.acpOwner.dispose();
        await f.disposeManager();
      }
    },
  );

  it.each([false, true])(
    "drains admitted delivery through retirement and finalization (assembled: %s)",
    async (assembled) => {
      const f = await fixture({ retire: true, assembled });
      let replacement: PluginInstance | undefined;
      try {
        expect(
          await Promise.race([
            f.started.promise.then(() => "started"),
            f.work.then((result) => result),
          ]),
        ).toBe("started");
        f.channelOwner.quiesce();
        const retired = f.channelOwner.dispose();
        replacement = ownedInstance("discord");
        expect(() => f.oldQueued()).toThrow("reloaded or disabled");
        f.proceed.resolve();
        const outcome = await Promise.race([
          f.delivered.promise.then(() => "delivered"),
          f.work.then((result) => result),
        ]);
        expect(f.deliveryOwners).toEqual(["discord"]);
        expect(outcome).toBe("delivered");
        expect(f.channelOwner.hasRetainedConsumers).toBe(true);
        f.finalization.resolve();
        await f.work;
        expect((await retired).errors).toEqual([]);
        expect(f.sends).toEqual(["offline final"]);
        expect(f.observers).toEqual(["delivered"]);
        expect(f.channelOwner.hasRetainedConsumers).toBe(false);
      } finally {
        f.proceed.resolve();
        f.finalization.resolve();
        await Promise.allSettled([f.work]);
        await f.channelOwner.dispose();
        await f.acpOwner.dispose();
        await replacement?.dispose();
        await f.disposeManager();
      }
    },
  );

  it.each([
    { streaming: false, ingress: false },
    { streaming: true, ingress: true },
  ] as const)(
    "releases admitted custody when the caller cancels during retirement (streaming: $streaming)",
    async (options) => {
      const f = await fixture({ ...options, retire: true });
      try {
        expect(
          await Promise.race([
            f.started.promise.then(() => "started"),
            f.work.then(() => "completed"),
          ]),
        ).toBe("started");
        expect(f.channelOwner.hasRetainedConsumers).toBe(true);
        f.channelOwner.quiesce();
        const retired = f.channelOwner.dispose();
        f.abort.abort(new Error("synthetic caller cancellation"));
        f.proceed.resolve();
        await f.work;
        expect(f.backendSignal()?.aborted).toBe(true);
        expect(f.sends).toEqual([]);
        expect(f.deliveryOwners).toEqual([]);
        expect(f.channelOwner.hasRetainedConsumers).toBe(false);
        expect((await retired).errors).toEqual([]);
      } finally {
        f.proceed.resolve();
        f.finalization.resolve();
        await Promise.allSettled([f.work]);
        await f.channelOwner.dispose();
        await f.acpOwner.dispose();
        await f.disposeManager();
      }
    },
  );

  it("isolates concurrent distinct channel instances through queued delivery", async () => {
    const f = await fixture({ retire: true });
    const second = ownedInstance("discord");
    const secondSends: string[] = [];
    let secondWork: ReturnType<typeof f.start> | undefined;
    try {
      expect(
        await Promise.race([
          f.started.promise.then(() => "started"),
          f.work.then(() => "completed"),
        ]),
      ).toBe("started");
      second.run(() => {
        getPluginInstanceRuntimeSlot("delivery-fixture")!.runtime = secondSends;
      });
      secondWork = f.start(second, "agent:main:acp:second", secondSends);
      expect(
        await Promise.race([
          f.secondStarted.promise.then(() => "started"),
          secondWork.then(() => "completed"),
        ]),
      ).toBe("started");
      f.channelOwner.quiesce();
      second.quiesce();
      const retired = Promise.all([f.channelOwner.dispose(), second.dispose()]);
      f.proceed.resolve();
      f.finalization.resolve();
      await Promise.all([f.work, secondWork]);
      expect((await retired).map((result) => result.errors)).toEqual([[], []]);
      expect(f.sends).toEqual(["offline final"]);
      expect(secondSends).toEqual(["offline final"]);
      expect(f.observers).toEqual(["delivered", "delivered"]);
      expect(f.channelOwner.hasRetainedConsumers).toBe(false);
      expect(second.hasRetainedConsumers).toBe(false);
    } finally {
      f.proceed.resolve();
      f.finalization.resolve();
      await Promise.allSettled([f.work, secondWork]);
      await f.disposeManager();
      await f.channelOwner.dispose();
      await second.dispose();
      await f.acpOwner.dispose();
    }
  });

  it.each(["success", "assembled-success", "observe-only", "callback-error"] as const)(
    "releases custody after %s without unintended sends",
    async (mode) => {
      const f = await fixture({
        observeOnly: mode === "observe-only",
        fail: mode === "callback-error",
        assembled: mode === "assembled-success",
      });
      try {
        f.finalization.resolve();
        await f.work;
        expect(f.backendRuns).toEqual(["agent:main:acp:custody"]);
        expect(f.deliveryOwners).toEqual(mode === "observe-only" ? [] : ["discord"]);
        expect(f.sends).toEqual(mode.endsWith("success") ? ["offline final"] : []);
        expect(f.observers).toEqual(
          mode === "observe-only" ? [] : [mode.endsWith("success") ? "delivered" : "error"],
        );
        expect(f.channelOwner.hasRetainedConsumers).toBe(false);
      } finally {
        f.finalization.resolve();
        await Promise.allSettled([f.work]);
        await f.channelOwner.dispose();
        await f.acpOwner.dispose();
        await f.disposeManager();
      }
    },
  );
});
