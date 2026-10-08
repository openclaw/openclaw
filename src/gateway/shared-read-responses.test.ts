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
  // The dispatch fixture supplies the owners touched by these read-only methods.
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
      const entered = createDeferredCore();
      const prepared = createDeferredCore();
      const release = createDeferredCore();
      let preparations = 0;
      let generation = 0;
      const produce = vi.fn(async (respond: RespondFn) => {
        const value = ++generation;
        if (value === 1) {
          entered.resolve();
          await release.promise;
        }
        respond(true, { generation: value });
      });
      const harness = createReadHarness(
        createPreparedReadHandler(() => {
          if (++preparations === 2) {
            prepared.resolve();
          }
          return { run: produce };
        }),
      );
      const first = harness.request("slow-producer");
      let follower: ReturnType<typeof harness.request> | undefined;
      try {
        await awaitGateBeforeSettlement(entered.promise, first.done, "producer did not start");
        follower = harness.request("waiting-reader");
        await awaitGateBeforeSettlement(prepared.promise, follower.done, "reader did not prepare");
        await vi.advanceTimersByTimeAsync(0);
        if (reason === "invalidation") {
          harness.invalidate("chat.metadata.changed");
        }
        await vi.advanceTimersByTimeAsync(reason === "expiry" ? 1_000 : 0);
        expect(produce).toHaveBeenCalledTimes(2);
        await follower.done;
        expectPayload(follower, { generation: 2 });
        expect(first.frames).toHaveLength(0);
      } finally {
        release.resolve();
        await first.done;
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

  it("retires responses when their method registry is replaced", async () => {
    const produce = vi.fn((respond: RespondFn) => respond(true, { value: "current" }));
    const harness = createReadHarness(createPreparedReadHandler(() => ({ run: produce })));
    await harness.request("old-registry").done;
    harness.invalidate();
    const current = harness.request("new-registry");
    await current.done;
    expectPayload(current, { value: "current" });
    expect(produce).toHaveBeenCalledTimes(2);
  });

  it("does not certify a pending response against a replacement config", async () => {
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const produce = vi.fn(async (config: OpenClawConfig, respond: RespondFn) => {
      entered.resolve();
      await release.promise;
      respond(true, { port: config.gateway?.port });
    });
    const harness = createReadHarness(
      createPreparedReadHandler(({ context }) => {
        const config = context.getRuntimeConfig();
        return { run: (respond) => produce(config, respond) };
      }),
    );
    const original = harness.request("original-config");
    try {
      await awaitGateBeforeSettlement(entered.promise, original.done, "read did not start");
      harness.setConfig({ gateway: { port: 18790 } });
    } finally {
      release.resolve();
      await original.done;
    }
    const current = harness.request("current-config");
    await current.done;
    expectPayload(original, {});
    expectPayload(current, { port: 18790 });
    expect(produce).toHaveBeenCalledTimes(2);
  });

  it("refreshes runner status before its asynchronous session change event is published", async () => {
    let available = true;
    const produce = vi.fn((respond: RespondFn) => respond(true, { available }));
    const harness = createReadHarness(
      createPreparedReadHandler(() => ({ run: produce })),
      "sessions.list",
    );
    const first = harness.request("before-disconnect");
    await first.done;
    expectPayload(first, { available: true });

    available = false;
    harness.runnerChanged();
    const second = harness.request("before-row-event");
    await second.done;
    expectPayload(second, { available: false });

    const third = harness.request("same-runner-revision");
    await third.done;
    expectPayload(third, { available: false });
    expect(produce).toHaveBeenCalledTimes(2);
  });

  it("computes and serializes one payload for 25 connections while delivering every request id", async () => {
    const releaseProducer = createDeferredCore();
    const allPrepared = createDeferredCore();
    const payload = { models: [{ id: "fixture-model", name: 'Model é🦞 \\"' }] };
    const serialize = vi.fn(() => payload);
    const produce = vi.fn(async (respond: RespondFn) => {
      await releaseProducer.promise;
      respond(true, { toJSON: serialize });
    });
    const released = vi.fn();
    const delivered = vi.fn();
    let prepared = 0;
    const harness = createReadHarness(
      createPreparedReadHandler(() => {
        if (++prepared === 25) {
          allPrepared.resolve();
        }
        return { run: produce, release: released, beforeRespond: delivered };
      }),
    );
    const requests = Array.from({ length: 25 }, (_, index) => harness.request(`request-${index}`));
    const done = Promise.all(requests.map((request) => request.done));
    try {
      await awaitGateBeforeSettlement(
        allPrepared.promise,
        done,
        "burst did not prepare every reader",
      );
    } finally {
      releaseProducer.resolve();
      await done;
    }

    expect(produce).toHaveBeenCalledOnce();
    expect(serialize).toHaveBeenCalledExactlyOnceWith("payload");
    expect(released).toHaveBeenCalledTimes(25);
    expect(delivered).toHaveBeenCalledTimes(25);
    const payloadBytes = new Set<string>();
    for (const request of requests) {
      expect(request.frames).toHaveLength(1);
      const frame = request.frames[0]!;
      expect(JSON.parse(frame)).toEqual({ type: "res", id: request.id, ok: true, payload });
      payloadBytes.add(frame.slice(frame.indexOf('"payload":') + '"payload":'.length, -1));
    }
    expect(payloadBytes.size).toBe(1);
  });

  it("serializes a root array once and preserves ordinary JSON fallback", async () => {
    const toJSON = vi.fn((key: string) => ({ key, text: 'Array é🦞 \\"' }));
    const produce = vi.fn((respond: RespondFn) => respond(true, [{ toJSON }]));
    const harness = createReadHarness(createPreparedReadHandler(() => ({ run: produce })));
    const first = harness.request("array-first");
    await first.done;
    const second = harness.request("array-second");
    await second.done;

    const expected = [{ key: "0", text: 'Array é🦞 \\"' }];
    expectPayload(first, expected);
    expectPayload(second, expected);
    expect(JSON.stringify({ payload: first.respond.mock.calls[0]![1] })).toBe(
      JSON.stringify({ payload: expected }),
    );
    expect(produce).toHaveBeenCalledOnce();
    expect(toJSON).toHaveBeenCalledExactlyOnceWith("0");
  });

  it.each([null, true, 17, 'Scalar é🦞 \\"'])("shares scalar payload %j", async (payload) => {
    const produce = vi.fn((respond: RespondFn) => respond(true, payload));
    const harness = createReadHarness(createPreparedReadHandler(() => ({ run: produce })));
    const first = harness.request("scalar-first");
    await first.done;
    const second = harness.request("scalar-second");
    await second.done;

    expectPayload(first, payload);
    expectPayload(second, payload);
    expect(produce).toHaveBeenCalledOnce();
  });

  it("keeps an omitted toJSON payload valid across shared and ordinary JSON responses", async () => {
    const toJSON = vi.fn(() => undefined);
    const produce = vi.fn((respond: RespondFn) => respond(true, { toJSON }));
    const harness = createReadHarness(createPreparedReadHandler(() => ({ run: produce })));
    const first = harness.request("omitted-first");
    await first.done;
    const second = harness.request("omitted-second");
    await second.done;

    expectPayload(first, undefined);
    expectPayload(second, undefined);
    expect(JSON.stringify({ ok: true, payload: first.respond.mock.calls[0]![1] })).toBe(
      '{"ok":true}',
    );
    expect(produce).toHaveBeenCalledOnce();
    expect(toJSON).toHaveBeenCalledExactlyOnceWith("payload");
  });

  it("does not retain scalar responses exceeding the encoded byte limit", async () => {
    const payload = "é".repeat(600 * 1024);
    const produce = vi.fn((respond: RespondFn) => respond(true, payload));
    const harness = createReadHarness(createPreparedReadHandler(() => ({ run: produce })));
    const first = harness.request("large-first");
    await first.done;
    const second = harness.request("large-second");
    await second.done;

    expectPayload(first, payload);
    expectPayload(second, payload);
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
      const releaseProducer = createDeferredCore();
      const allPrepared = createDeferredCore();
      const revoked = new Set<string>();
      const released = vi.fn<(id: string) => void>();
      const delivered = vi.fn<(id: string) => void>();
      const produce = vi.fn(async (respond: RespondFn) => {
        await releaseProducer.promise;
        respond(true, { models: ["allowed"] });
      });
      let prepared = 0;
      const harness = createReadHarness(
        createPreparedReadHandler(({ req }) => {
          if (++prepared === 3) {
            allPrepared.resolve();
          }
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
      const done = Promise.all(requests.map((request) => request.done));
      try {
        await awaitGateBeforeSettlement(
          allPrepared.promise,
          done,
          "readers did not join the producer",
        );
        if (authority === "method authority") {
          revoked.add("revoked");
        } else {
          requests[1]!.client.connect.scopes = [];
        }
      } finally {
        releaseProducer.resolve();
        await done;
      }

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

  it("does not let a pre-invalidation completion replace the new shared result", async () => {
    const entered = createDeferredCore();
    const releaseOld = createDeferredCore();
    let generation = 0;
    const produce = vi.fn(async (respond: RespondFn) => {
      const current = ++generation;
      if (current === 1) {
        entered.resolve();
        await releaseOld.promise;
      }
      respond(true, { generation: current });
    });
    const harness = createReadHarness(createPreparedReadHandler(() => ({ run: produce })));
    const first = harness.request("before");
    let second: ReturnType<typeof harness.request> | undefined;
    try {
      await awaitGateBeforeSettlement(
        entered.promise,
        first.done,
        "original producer did not start",
      );
      harness.invalidate("chat.metadata.changed");
      second = harness.request("after");
      await second.done;
    } finally {
      releaseOld.resolve();
      await first.done;
    }
    const third = harness.request("after-old-completed");
    await third.done;

    expect(produce).toHaveBeenCalledTimes(2);
    expectPayload(first, { generation: 1 });
    expectPayload(second!, { generation: 2 });
    expectPayload(third, { generation: 2 });
  });

  it("expires a response at the absolute ceiling even when recent readers used it", async () => {
    vi.setSystemTime(1_000);
    let generation = 0;
    const produce = vi.fn((respond: RespondFn) => respond(true, { generation: ++generation }));
    const harness = createReadHarness(createPreparedReadHandler(() => ({ run: produce })));
    const first = harness.request("initial");
    await first.done;
    vi.setSystemTime(1_999);
    const lastHit = harness.request("last-hit");
    await lastHit.done;
    vi.setSystemTime(2_000);
    const expired = harness.request("expired");
    await expired.done;

    expect(produce).toHaveBeenCalledTimes(2);
    expectPayload(first, { generation: 1 });
    expectPayload(lastHit, { generation: 1 });
    expectPayload(expired, { generation: 2 });
  });

  it("executes every explicit model refresh when the method's share key opts out", async () => {
    let generation = 0;
    const produce = vi.fn((respond: RespondFn) => respond(true, { generation: ++generation }));
    const harness = createReadHarness(createPreparedReadHandler(() => ({ run: produce })));
    const first = harness.request("refresh-first", { refresh: true });
    await first.done;
    const second = harness.request("refresh-second", { refresh: true });
    await second.done;

    expect(produce).toHaveBeenCalledTimes(2);
    expectPayload(first, { generation: 1 });
    expectPayload(second, { generation: 2 });
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
