import assert from "node:assert/strict";
import { beforeEach, expect, it, vi } from "vitest";
import type { GatewayClientHostDeps } from "../../packages/gateway-client/src/client.js";
import type { loadDeviceAuthToken } from "../infra/device-auth-store.js";
import { GatewayClient } from "./client.js";

const fixture = vi.hoisted(() => ({
  hosts: [] as GatewayClientHostDeps[],
  token: "fixture-existing" as string | undefined,
  malformed: false,
  load: vi.fn(),
  store: vi.fn(),
  clear: vi.fn(),
  readOnlyLoad: vi.fn(),
}));
const scope = { deviceId: "fixture-device", role: "operator" };
const issued = { ...scope, token: "fixture-issued", scopes: [] };
const scoped = (origin: boolean) => ({
  ...scope,
  ...(origin ? { gatewayScope: "wss://gateway.example.test" } : {}),
});

vi.mock("../../packages/gateway-client/src/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../packages/gateway-client/src/client.js")>()),
  GatewayClient: class {
    constructor(private readonly options: { hostDeps: GatewayClientHostDeps }) {}
    start = () => fixture.hosts.push(this.options.hostDeps);
  },
}));

vi.mock("../infra/device-auth-store.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/device-auth-store.js")>()),
  loadDeviceAuthToken: fixture.load,
  loadOriginDeviceToken: fixture.load,
  storeDeviceAuthToken: fixture.store,
  storeOriginDeviceToken: fixture.store,
  clearDeviceAuthToken: fixture.clear,
  clearOriginDeviceToken: fixture.clear,
  loadDeviceAuthTokenReadOnly: fixture.readOnlyLoad,
  loadOriginDeviceTokenReadOnly: fixture.readOnlyLoad,
}));

beforeEach(() => {
  Object.assign(fixture, { hosts: [], token: "fixture-existing", malformed: false });
  fixture.load
    .mockReset()
    .mockImplementation((params: Parameters<typeof loadDeviceAuthToken>[0]) => {
      const entry =
        fixture.token === undefined || fixture.malformed
          ? null
          : { token: fixture.token, role: "operator", scopes: [], updatedAtMs: 1 };
      params.onSnapshot?.({ entry, expectedToken: fixture.token ?? null });
      return entry;
    });
  fixture.store.mockReset();
  fixture.clear.mockReset();
  fixture.readOnlyLoad.mockReset();
});

function host(origin: boolean, readOnly = false, explicit = true) {
  const client = new GatewayClient({
    url: "wss://gateway.example.test",
    deviceIdentity: null,
    ...(origin ? { deviceAuthScope: "wss://gateway.example.test" } : {}),
    ...(explicit ? { token: "fixture-shared-auth" } : {}),
    ...(readOnly ? { sharedStateMode: "read-only" } : {}),
  });
  client.start();
  const deps = fixture.hosts[0];
  assert(deps?.loadDeviceAuthToken && deps.storeDeviceAuthToken && deps.clearDeviceAuthToken);
  return {
    load: deps.loadDeviceAuthToken,
    store: deps.storeDeviceAuthToken,
    clear: deps.clearDeviceAuthToken,
  };
}

it.each(
  [false, true].flatMap((origin) => [
    { origin, token: "fixture-existing", malformed: true },
    { origin, token: undefined, malformed: false },
    { origin, token: " fixture-existing ", malformed: false },
  ]),
)(
  "fences rotation with raw token $token (origin: $origin, malformed: $malformed)",
  async ({ token, malformed, origin }) => {
    fixture.token = token;
    fixture.malformed = malformed;
    const deps = host(origin);
    const loaded = await deps.load(scope);
    if (origin || malformed || token === undefined) {
      expect(loaded).toBeNull();
    } else {
      expect(loaded?.token).toBe(token);
    }
    fixture.token = "fixture-newer";
    await deps.store({ ...issued, expectedToken: loaded?.token?.trim() ?? null });
    expect(fixture.store).toHaveBeenCalledWith({
      ...issued,
      ...scoped(origin),
      expectedToken: token ?? null,
    });
  },
);

it.each([false, true])("cleans matching raw token receipts (origin: %s)", async (origin) => {
  fixture.token = " fixture-existing ";
  const deps = host(origin, false, false);
  await deps.load(scope);
  await deps.clear({ ...scope, expectedToken: "fixture-existing" });
  expect(fixture.clear).toHaveBeenLastCalledWith({
    ...scoped(origin),
    expectedToken: "fixture-existing",
    observedToken: " fixture-existing ",
  });
  fixture.token = "fixture-newer";
  await deps.clear({ ...scope, expectedToken: "fixture-issued" });
  expect(fixture.clear).toHaveBeenLastCalledWith({
    ...scoped(origin),
    expectedToken: "fixture-issued",
  });
});

it("keeps explicit read-only origin auth off storage reads and writes", async () => {
  const deps = host(true, true);
  expect(await deps.load(scope)).toBeNull();
  expect(deps.store({ ...issued, expectedToken: null })).toBeUndefined();
  expect(fixture.load).not.toHaveBeenCalled();
  expect(fixture.readOnlyLoad).not.toHaveBeenCalled();
  expect(fixture.store).not.toHaveBeenCalled();
});
