import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../packages/gateway-protocol/src/client-info.js";
import { awaitGateBeforeSettlement } from "../../test/helpers/promise.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createCoreGatewayMethodDescriptors } from "./methods/core-method-policy.js";
import { createPluginGatewayMethodDescriptor } from "./methods/descriptor.js";
import { createGatewayMethodRegistry } from "./methods/registry.js";
import { serializeGatewayFrame } from "./serialized-json.js";
import { handleGatewayRequest } from "./server-methods.js";
import { createPreparedReadHandler } from "./server-methods/prepared-read.js";
import type {
  GatewayClient,
  GatewayRequestContext,
  GatewayRequestHandler,
  RespondFn,
} from "./server-methods/types.js";
import { SessionMutationAuthorizationChangedError } from "./session-mutation-authorization-error.js";
import { invalidateSharedReadResponses } from "./shared-read-responses.js";

function createReadHarness(
  handler: GatewayRequestHandler,
  method = "models.list",
  broadcast: GatewayRequestContext["broadcast"] = vi.fn(),
) {
  let config: OpenClawConfig = {};
  let runnerRevision = 0;
  const context = {
    getRuntimeConfig: () => config,
    getCommittedRuntimeConfig: () => config,
    broadcast,
    logGateway: { warn: vi.fn() },
    workerPlacementRunnerAvailabilityReader: {
      read: () => undefined,
      version: () => runnerRevision,
    },
  } as unknown as GatewayRequestContext;
  const methodRegistry = createGatewayMethodRegistry(
    method.startsWith("workboard.")
      ? [
          createPluginGatewayMethodDescriptor({
            pluginId: "workboard",
            name: method,
            handler,
            scope: "operator.read",
          }),
        ]
      : createCoreGatewayMethodDescriptors({ [method]: handler }),
  );
  return {
    setConfig: (next: OpenClawConfig) => {
      config = next;
    },
    invalidate: (event?: string) => invalidateSharedReadResponses(context.broadcast, event),
    runnerChanged: () => runnerRevision++,
    request(id: string, params: Record<string, unknown> = {}, profileId = "alice") {
      const client: GatewayClient = {
        connId: `connection-${id}`,
        authenticatedUserProfile: {
          profileId,
          displayName: profileId,
          hasAvatar: false,
          updatedAt: 0,
        },
        connect: {
          minProtocol: 1,
          maxProtocol: 1,
          role: "operator",
          scopes: ["operator.read"],
          client: {
            id: GATEWAY_CLIENT_IDS.CONTROL_UI,
            mode: GATEWAY_CLIENT_MODES.WEBCHAT,
            version: "test",
            platform: "test",
          },
        },
      };
      const frames: string[] = [];
      const respond = vi.fn<RespondFn>((ok, payload, error) => {
        frames.push(serializeGatewayFrame({ type: "res", id, ok, payload, error }).toString());
      });
      const done = handleGatewayRequest({
        req: { type: "req", id, method, params },
        client,
        respond,
        context,
        methodRegistry,
        isWebchatConnect: () => true,
        acceptsSerializedJson: true,
      });
      return { id, client, frames, respond, done };
    },
  };
}

function expectPayload(request: { id: string; frames: readonly string[] }, payload: unknown) {
  expect(request.frames).toHaveLength(1);
  expect(JSON.parse(request.frames[0]!)).toStrictEqual({
    type: "res",
    id: request.id,
    ok: true,
    ...(payload === undefined ? {} : { payload }),
  });
}

async function read(
  harness: ReturnType<typeof createReadHarness>,
  id: string,
  payload: unknown,
  params?: Record<string, unknown>,
) {
  const request = harness.request(id, params);
  await request.done;
  expectPayload(request, payload);
  return request;
}

const preparedHarness = (run: (respond: RespondFn) => void | Promise<void>, method?: string) =>
  createReadHarness(
    createPreparedReadHandler(() => ({ run })),
    method,
  );

function readBarrier(count = 1) {
  const entered = createDeferredCore();
  const release = createDeferredCore();
  let remaining = count;
  const wait = (done: Promise<unknown>) =>
    awaitGateBeforeSettlement(entered.promise, done, "readers did not prepare");
  return {
    pause: () => release.promise,
    wait,
    prepare() {
      if (--remaining === 0) {
        entered.resolve();
      }
    },
    async hold(done: Promise<unknown>, inspect: () => void | Promise<void> = () => {}) {
      try {
        await wait(done);
        await inspect();
      } finally {
        release.resolve();
        await done;
      }
    },
  };
}

function generationHarness(blockFirst = false, prepare = () => {}) {
  let generation = 0;
  const barrier = readBarrier();
  const produce = vi.fn(async (config: OpenClawConfig, respond: RespondFn) => {
    const current = ++generation;
    if (blockFirst && current === 1) {
      barrier.prepare();
      await barrier.pause();
    }
    respond(true, { generation: current, port: config.gateway?.port });
  });
  const harness = createReadHarness(
    createPreparedReadHandler(({ context }) => {
      prepare();
      const config = context.getRuntimeConfig();
      return { run: (respond) => produce(config, respond) };
    }),
  );
  return { harness, produce, barrier };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("shared read response dispatch", () => {
  it.each(["expiry", "invalidation"])(
    "releases a waiting reader on %s without waiting for the slow producer",
    async (reason) => {
      const prepared = readBarrier(2);
      const { harness, produce, barrier } = generationHarness(true, prepared.prepare);
      const first = harness.request("slow-producer");
      let follower: ReturnType<typeof harness.request> | undefined;
      try {
        await barrier.hold(first.done, async () => {
          follower = harness.request("waiting-reader");
          await prepared.wait(follower.done);
          await vi.advanceTimersByTimeAsync(0);
          if (reason === "invalidation") {
            harness.invalidate("chat.metadata.changed");
          }
          await vi.advanceTimersByTimeAsync(reason === "expiry" ? 1_000 : 0);
          expect(produce).toHaveBeenCalledTimes(2);
          await follower.done;
          expectPayload(follower, { generation: 2 });
          expect(first.frames).toHaveLength(0);
        });
      } finally {
        await follower?.done;
      }
    },
  );

  it("bounds retained responses across methods instead of retaining a cache per method", async () => {
    const broadcast = vi.fn();
    const produce = vi.fn((respond: RespondFn) => respond(true, { value: "bounded" }));
    const handler = createPreparedReadHandler(() => ({ shareable: true, run: produce }));
    const readers = ["models.list", "chat.metadata", "sessions.list", "cron.list"].map((method) =>
      createReadHarness(handler, method, broadcast),
    );
    for (let profile = 0; profile < 5; profile++) {
      for (const [method, reader] of readers.entries()) {
        await reader.request(`${profile}-${method}`, {}, `profile-${profile}`).done;
      }
    }
    const evicted = readers[0]!.request("evicted", {}, "profile-0");
    await evicted.done;
    expectPayload(evicted, { value: "bounded" });
    expect(produce).toHaveBeenCalledTimes(21);
  });

  it("refreshes runner status before its asynchronous session change event is published", async () => {
    let available = true;
    const produce = vi.fn((respond: RespondFn) => respond(true, { available }));
    const harness = preparedHarness(produce, "sessions.list");
    await read(harness, "before-disconnect", { available: true });

    available = false;
    harness.runnerChanged();
    await read(harness, "before-row-event", { available: false });
    await read(harness, "same-runner-revision", { available: false });
    expect(produce).toHaveBeenCalledTimes(2);
  });

  it("computes and serializes one payload for 25 connections while delivering every request id", async () => {
    const barrier = readBarrier(25);
    const payload = { models: [{ id: "fixture-model", name: 'Model é🦞 \\"' }] };
    const serialize = vi.fn(() => payload);
    const produce = vi.fn(async (respond: RespondFn) => {
      await barrier.pause();
      respond(true, { toJSON: serialize });
    });
    const released = vi.fn();
    const delivered = vi.fn();
    const harness = createReadHarness(
      createPreparedReadHandler(() => {
        barrier.prepare();
        return { run: produce, release: released, beforeRespond: delivered };
      }),
    );
    const requests = Array.from({ length: 25 }, (_, index) => harness.request(`request-${index}`));
    await barrier.hold(Promise.all(requests.map((request) => request.done)));

    expect(produce).toHaveBeenCalledOnce();
    expect(serialize).toHaveBeenCalledExactlyOnceWith("payload");
    expect(released).toHaveBeenCalledTimes(25);
    expect(delivered).toHaveBeenCalledTimes(25);
    const payloadBytes = new Set<string>();
    for (const request of requests) {
      expectPayload(request, payload);
      const frame = request.frames[0]!;
      payloadBytes.add(frame.slice(frame.indexOf('"payload":') + '"payload":'.length, -1));
    }
    expect(payloadBytes.size).toBe(1);
  });

  it("keeps an omitted toJSON payload valid across shared and ordinary JSON responses", async () => {
    const toJSON = vi.fn(() => undefined);
    const produce = vi.fn((respond: RespondFn) => respond(true, { toJSON }));
    const harness = preparedHarness(produce);
    const first = await read(harness, "omitted-first", undefined);
    await read(harness, "omitted-second", undefined);
    expect(JSON.stringify({ ok: true, payload: first.respond.mock.calls[0]![1] })).toBe(
      '{"ok":true}',
    );
    expect(produce).toHaveBeenCalledOnce();
    expect(toJSON).toHaveBeenCalledExactlyOnceWith("payload");
  });

  it("does not retain scalar responses exceeding the encoded byte limit", async () => {
    const payload = "é".repeat(600 * 1024);
    const produce = vi.fn((respond: RespondFn) => respond(true, payload));
    const harness = preparedHarness(produce);
    await read(harness, "large-first", payload);
    await read(harness, "large-second", payload);
    expect(produce).toHaveBeenCalledTimes(2);
  });

  it("separates two profiles and two selected accounts within the same method", async () => {
    const produce = vi.fn((profileId: string | undefined, account: unknown, respond: RespondFn) => {
      respond(true, { profileId, account });
    });
    const harness = createReadHarness(
      createPreparedReadHandler(({ client, params }) => ({
        run: (respond) =>
          produce(client?.authenticatedUserProfile?.profileId, params.authProfileId, respond),
      })),
    );
    const requests = ["alice", "bob"].flatMap((profile) =>
      ["first-account", "second-account"].flatMap((account) =>
        [0, 1].map((repeat) => ({
          profile,
          account,
          request: harness.request(
            `${profile}-${account}-${repeat}`,
            { authProfileId: account },
            profile,
          ),
        })),
      ),
    );
    await Promise.all(requests.map(({ request }) => request.done));

    expect(produce).toHaveBeenCalledTimes(4);
    for (const { request, profile, account } of requests) {
      expectPayload(request, { profileId: profile, account });
    }
  });

  it.each(["method authority", "operator scope"] as const)(
    "rejects only the waiting reader whose %s changes and releases every reader",
    async (authority) => {
      const barrier = readBarrier(3);
      const revoked = new Set<string>();
      const released = vi.fn<(id: string) => void>();
      const delivered = vi.fn<(id: string) => void>();
      const produce = vi.fn(async (respond: RespondFn) => {
        await barrier.pause();
        respond(true, { models: ["allowed"] });
      });
      const harness = createReadHarness(
        createPreparedReadHandler(({ req }) => {
          barrier.prepare();
          return {
            run: produce,
            assertCurrent: () => {
              if (revoked.has(req.id)) {
                throw new SessionMutationAuthorizationChangedError({
                  code: "FORBIDDEN",
                  message: "Selected account access revoked",
                });
              }
            },
            release: () => released(req.id),
            beforeRespond: () => delivered(req.id),
          };
        }),
      );
      const requests = ["producer", "revoked", "allowed"].map((id) => harness.request(id));
      await barrier.hold(Promise.all(requests.map((request) => request.done)), () => {
        if (authority === "method authority") {
          revoked.add("revoked");
        } else {
          requests[1]!.client.connect.scopes = [];
        }
      });

      expect(produce).toHaveBeenCalledOnce();
      expect(requests[1]!.respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: "FORBIDDEN" }),
      );
      for (const request of [requests[0]!, requests[2]!]) {
        expectPayload(request, { models: ["allowed"] });
      }
      expect(released.mock.calls.map(([id]) => id).toSorted()).toEqual([
        "allowed",
        "producer",
        "revoked",
      ]);
      expect(delivered.mock.calls.map(([id]) => id).toSorted()).toEqual(["allowed", "producer"]);
    },
  );

  it.each(["config replacement", "invalidation"])(
    "keeps old completions out after %s",
    async (cause) => {
      const { harness, produce, barrier } = generationHarness(true);
      const first = harness.request("before");
      let second: ReturnType<typeof harness.request> | undefined;
      const current = { generation: 2, ...(cause === "config replacement" ? { port: 18790 } : {}) };
      await barrier.hold(first.done, async () => {
        if (cause === "config replacement") {
          harness.setConfig({ gateway: { port: 18790 } });
        } else {
          harness.invalidate("chat.metadata.changed");
        }
        second = harness.request("after");
        await second.done;
      });
      await read(harness, "after-old-completed", current);

      expect(produce).toHaveBeenCalledTimes(2);
      expectPayload(first, { generation: 1 });
      expectPayload(second!, current);
    },
  );

  it("expires a response at the absolute ceiling even when recent readers used it", async () => {
    vi.setSystemTime(1_000);
    const { harness, produce } = generationHarness();
    await read(harness, "initial", { generation: 1 });
    vi.setSystemTime(1_999);
    await read(harness, "last-hit", { generation: 1 });
    vi.setSystemTime(2_000);
    await read(harness, "expired", { generation: 2 });

    expect(produce).toHaveBeenCalledTimes(2);
  });

  it("executes every explicit model refresh when the method's share key opts out", async () => {
    const { harness, produce } = generationHarness();
    await read(harness, "refresh-first", { generation: 1 }, { refresh: true });
    await read(harness, "refresh-second", { generation: 2 }, { refresh: true });

    expect(produce).toHaveBeenCalledTimes(2);
  });

  it.each(["sessions.catalog.list", "workboard.cards.list"])(
    "preserves connection-bound %s responses without method opt-in",
    async (method) => {
      const handler = vi.fn<GatewayRequestHandler>(({ client, respond }) => {
        respond(true, { connection: client?.connId });
      });
      const harness = createReadHarness(handler, method);
      const requests = [harness.request("first"), harness.request("second")];
      await Promise.all(requests.map((request) => request.done));

      expect(handler).toHaveBeenCalledTimes(2);
      expectPayload(requests[0]!, { connection: "connection-first" });
      expectPayload(requests[1]!, { connection: "connection-second" });
    },
  );
});
