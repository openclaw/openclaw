import assert from "node:assert/strict";
import { beforeEach, expect, it, vi } from "vitest";
import type { GatewayClientHostDeps } from "../../packages/gateway-client/src/index.js";
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

vi.mock("../../packages/gateway-client/src/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../packages/gateway-client/src/index.js")>()),
  GatewayClient: class {
    constructor(private readonly options: { hostDeps: GatewayClientHostDeps }) {}

    start() {
      fixture.hosts.push(this.options.hostDeps);
    }
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
  fixture.hosts.length = 0;
  fixture.token = "fixture-existing";
  fixture.malformed = false;
  fixture.load
    .mockReset()
    .mockImplementation((params: Parameters<typeof loadDeviceAuthToken>[0]) => {
      const entry =
        fixture.token === undefined || fixture.malformed
          ? null
          : {
              token: fixture.token,
              role: "operator",
              scopes: [],
              updatedAtMs: 1,
            };
      params.onSnapshot?.({ entry, expectedToken: fixture.token ?? null });
      return entry;
    });
  fixture.store
    .mockReset()
    .mockImplementation((params: { token: string; expectedToken?: string | null }) => {
      if (
        params.expectedToken === undefined ||
        (params.expectedToken === null
          ? fixture.token === undefined
          : params.expectedToken === fixture.token)
      ) {
        fixture.token = params.token;
        return { token: params.token, role: "operator", scopes: [], updatedAtMs: 1 };
      }
      return null;
    });
  fixture.clear
    .mockReset()
    .mockImplementation((params: { expectedToken?: string; observedToken?: string }) => {
      if (
        params.expectedToken === fixture.token ||
        (params.observedToken?.trim() === params.expectedToken &&
          params.observedToken === fixture.token)
      ) {
        fixture.token = undefined;
        return true;
      }
      return false;
    });
  fixture.readOnlyLoad.mockReset();
});

function host(origin: boolean, readOnly = false, explicit = true) {
  const client = new GatewayClient({
    url: "wss://gateway.example.test",
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

const observations = [
  { name: "valid", token: "fixture-existing", malformed: false },
  { name: "malformed scopes", token: "fixture-existing", malformed: true },
  { name: "absent", token: undefined, malformed: false },
  { name: "raw whitespace", token: " fixture-existing ", malformed: false },
];

it.each(
  observations.flatMap(({ name, token, malformed }) =>
    [false, true].flatMap((origin) =>
      [false, true].map((rotated) => ({ name, token, malformed, origin, rotated })),
    ),
  ),
)(
  "uses exact $name comparison privately (origin: $origin, rotated: $rotated)",
  async ({ token, malformed, origin, rotated }) => {
    fixture.token = token;
    fixture.malformed = malformed;
    const deps = host(origin);
    const scope = { deviceId: "fixture-device", role: "operator" };
    const loaded = await deps.load(scope);
    if (origin || malformed || token === undefined) {
      expect(loaded).toBeNull();
    } else {
      expect(loaded?.token).toBe(token);
    }
    if (rotated) {
      fixture.token = "fixture-newer";
    }
    const stored = await deps.store({
      ...scope,
      token: "fixture-issued",
      scopes: [],
      expectedToken: loaded?.token?.trim() ?? null,
    });
    expect(stored).toEqual(
      rotated
        ? null
        : {
            token: "fixture-issued",
            role: "operator",
            scopes: [],
            updatedAtMs: 1,
          },
    );
    expect(fixture.store).toHaveBeenCalledWith({
      ...scope,
      ...(origin ? { gatewayScope: "wss://gateway.example.test" } : {}),
      token: "fixture-issued",
      scopes: [],
      expectedToken: token ?? null,
    });
    expect(fixture.token).toBe(rotated ? "fixture-newer" : "fixture-issued");
  },
);

it.each([false, true])(
  "cleans exact raw legacy bytes without redirecting receipt cleanup (origin: %s)",
  async (origin) => {
    fixture.token = " fixture-existing ";
    const deps = host(origin, false, false);
    const scope = { deviceId: "fixture-device", role: "operator" };
    await deps.load(scope);
    expect(await deps.clear({ ...scope, expectedToken: "fixture-existing" })).toBe(true);
    expect(fixture.token).toBeUndefined();
    expect(fixture.clear).toHaveBeenLastCalledWith({
      ...scope,
      ...(origin ? { gatewayScope: "wss://gateway.example.test" } : {}),
      expectedToken: "fixture-existing",
      observedToken: " fixture-existing ",
    });
    fixture.token = "fixture-newer";
    expect(await deps.clear({ ...scope, expectedToken: "fixture-issued" })).toBe(false);
    expect(fixture.token).toBe("fixture-newer");
    expect(fixture.clear).toHaveBeenLastCalledWith({
      ...scope,
      ...(origin ? { gatewayScope: "wss://gateway.example.test" } : {}),
      expectedToken: "fixture-issued",
    });
  },
);

it("keeps explicit read-only origin auth off storage reads and writes", async () => {
  const deps = host(true, true);
  const scope = { deviceId: "fixture-device", role: "operator" };
  expect(await deps.load(scope)).toBeNull();
  expect(
    deps.store({ ...scope, token: "fixture-issued", scopes: [], expectedToken: null }),
  ).toBeUndefined();
  expect(fixture.load).not.toHaveBeenCalled();
  expect(fixture.readOnlyLoad).not.toHaveBeenCalled();
  expect(fixture.store).not.toHaveBeenCalled();
});
