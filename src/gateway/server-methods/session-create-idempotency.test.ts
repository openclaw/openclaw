import { afterEach, expect, it, vi } from "vitest";
import { SESSION_CREATE_IDEMPOTENCY_RETENTION_MS } from "../../../packages/gateway-protocol/src/index.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { DEDUPE_MAX } from "../server-constants.js";
import { idempotentSessionCreate } from "./session-create-idempotency.js";
import type {
  GatewayRequestContext,
  GatewayRequestHandler,
  GatewayRequestHandlerOptions,
  RespondFn,
} from "./types.js";

afterEach(() => vi.restoreAllMocks());
const hello = { agentId: "main", idempotencyKey: "create-once", message: "hello" };

function createFixture(handler?: GatewayRequestHandler) {
  const context = { dedupe: new Map() } as GatewayRequestContext;
  const execute = vi.fn<GatewayRequestHandler>(
    handler ??
      ((request) =>
        request.respond(true, { key: `agent:main:${String(request.params.idempotencyKey)}` })),
  );
  const wrapped = idempotentSessionCreate(execute);
  const client = {
    authenticatedUserId: "owner",
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: { id: "test", version: "1", platform: "test", mode: "test" },
      device: {
        id: "device",
        publicKey: "key",
        signature: "signature",
        signedAt: 1,
        nonce: "nonce",
      },
      role: "operator",
      scopes: ["operator.admin", "operator.write"],
    },
  } satisfies NonNullable<GatewayRequestHandlerOptions["client"]>;

  function invoke(
    params: Record<string, unknown> = { agentId: "main", idempotencyKey: "create-once" },
    connection: typeof client = client,
  ) {
    const respond = vi.fn<RespondFn>();
    const request: GatewayRequestHandlerOptions = {
      req: { type: "req", id: "1", method: "sessions.create" },
      params,
      client: connection,
      context,
      respond,
      isWebchatConnect: () => false,
    };
    return { done: Promise.resolve(wrapped(request)), respond };
  }

  async function call(...args: Parameters<typeof invoke>) {
    const { done, respond } = invoke(...args);
    await done;
    return respond;
  }
  const connection = (overrides: Partial<typeof client.connect>) => ({
    ...client,
    connect: { ...client.connect, ...overrides },
  });
  return { client, connection, context, execute, invoke, call };
}

function expectCached(respond: RespondFn, key: string) {
  expect(respond).toHaveBeenCalledWith(true, { key }, undefined, { cached: true });
}

function expectRejected(respond: RespondFn, code: string, message?: unknown) {
  expect(respond).toHaveBeenCalledWith(
    false,
    undefined,
    expect.objectContaining({ code, ...(message ? { message } : {}) }),
  );
}

it("replays reordered requests and added authorization without accepting downgraded scopes", async () => {
  const { client, connection, context, execute, call } = createFixture();
  await call(hello);
  context.dedupe.clear();

  const added = await call(
    { message: "hello", idempotencyKey: "create-once", agentId: "main" },
    connection({ scopes: ["operator.write", "operator.read", "operator.admin"] }),
  );
  expect(execute).toHaveBeenCalledOnce();
  expectCached(added, "agent:main:create-once");

  const downgraded = await call(hello, connection({ scopes: ["operator.write"] }));
  expectRejected(downgraded, "FORBIDDEN", "missing scope: operator.admin");
  expect(execute).toHaveBeenCalledOnce();

  const changedRole = await call(hello, connection({ role: "node" }));
  expectRejected(changedRole, "FORBIDDEN");
  expect(execute).toHaveBeenCalledOnce();

  const conflict = await call({ ...hello, message: "different" });

  expectRejected(conflict, "INVALID_REQUEST");
  expect(execute).toHaveBeenCalledOnce();

  const differentDevice = await call(
    hello,
    connection({ device: { ...client.connect.device, id: "other-device" } }),
  );
  expectCached(differentDevice, "agent:main:create-once");
  expect(execute).toHaveBeenCalledOnce();
});

it("rejects idempotent creation without a principal or device namespace", async () => {
  const { execute, call } = createFixture();
  const anonymous = await call({ agentId: "main", idempotencyKey: "create-once" }, null as never);

  expectRejected(anonymous, "INVALID_REQUEST", expect.stringContaining("identity"));
  expect(execute).not.toHaveBeenCalled();
});

it("pins in-flight request identity beyond retention and independent of global dedupe pruning", async () => {
  let now = 1_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const release = createDeferredCore();
  const { context, execute, invoke } = createFixture(async (request) => {
    await release.promise;
    request.respond(true, { key: "agent:main:finished" });
  });
  const original = invoke({ ...hello, idempotencyKey: "long-create" });
  await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
  now += SESSION_CREATE_IDEMPOTENCY_RETENTION_MS + 1;
  context.dedupe.clear();

  const conflicting = invoke({ ...hello, idempotencyKey: "long-create", message: "different" });
  await conflicting.done;
  expectRejected(conflicting.respond, "INVALID_REQUEST");

  const joined = invoke({ ...hello, idempotencyKey: "long-create" });
  release.resolve();
  await Promise.all([original.done, joined.done]);
  expect(execute).toHaveBeenCalledOnce();
  expectCached(joined.respond, "agent:main:finished");
});

it("expires only settled successful results and immediately releases failed creates", async () => {
  let now = 1_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const { execute, invoke } = createFixture();
  await invoke().done;
  now += SESSION_CREATE_IDEMPOTENCY_RETENTION_MS - 1;
  await invoke().done;
  expect(execute).toHaveBeenCalledOnce();
  now += 1;
  await invoke().done;
  expect(execute).toHaveBeenCalledTimes(2);

  let fail = true;
  const failed = createFixture((request) => {
    request.respond(!fail, fail ? undefined : { key: "recovered" });
    fail = false;
  });
  await failed.invoke().done;
  await failed.invoke().done;
  expect(failed.execute).toHaveBeenCalledTimes(2);
});

it("enforces capacity per owner without evicting retained successful creations", async () => {
  const { client, execute, invoke, call } = createFixture();
  for (let index = 0; index < DEDUPE_MAX; index += 1) {
    await invoke({ agentId: "main", idempotencyKey: `create-${index}` }).done;
  }
  const overflow = await call({ agentId: "main", idempotencyKey: "overflow" });
  expectRejected(overflow, "UNAVAILABLE", expect.stringContaining("retry"));
  expect(execute).toHaveBeenCalledTimes(DEDUPE_MAX);

  const retained = await call({ agentId: "main", idempotencyKey: "create-0" });
  expectCached(retained, "agent:main:create-0");
  expect(execute).toHaveBeenCalledTimes(DEDUPE_MAX);

  const otherOwner = { ...client, authenticatedUserId: "other-owner" };
  const otherCreation = await call({ agentId: "main", idempotencyKey: "create-0" }, otherOwner);
  expect(otherCreation).toHaveBeenCalledWith(
    true,
    { key: "agent:main:create-0" },
    undefined,
    undefined,
  );
  expect(execute).toHaveBeenCalledTimes(DEDUPE_MAX + 1);

  const otherReplay = await call({ agentId: "main", idempotencyKey: "create-0" }, otherOwner);
  expectCached(otherReplay, "agent:main:create-0");
  expect(execute).toHaveBeenCalledTimes(DEDUPE_MAX + 1);

  for (let index = 1; index < DEDUPE_MAX; index += 1) {
    await invoke({ agentId: "main", idempotencyKey: `create-${index}` }, otherOwner).done;
  }
  const thirdOwner = { ...client, authenticatedUserId: "third-owner" };
  const processOverflow = await call({ agentId: "main", idempotencyKey: "create-0" }, thirdOwner);
  expectRejected(processOverflow, "UNAVAILABLE");
  expect(execute).toHaveBeenCalledTimes(DEDUPE_MAX * 2);
});
