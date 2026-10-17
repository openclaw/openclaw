import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import type { Dispatcher } from "undici";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const TEST_UNDICI_RUNTIME_DEPS_KEY = "__OPENCLAW_TEST_UNDICI_RUNTIME_DEPS__";
const telegram = "api.telegram.org";
const proxyUrl = "http://127.0.0.1:7890";
const familyOptions = { autoSelectFamily: true, autoSelectFamilyAttemptTimeout: 300 };
const telegramRequest: Dispatcher.DispatchOptions = {
  origin: `https://${telegram}`,
  path: "/getMe",
  method: "GET",
};

const { agentCtor, envHttpProxyAgentCtor, proxyAgentCtor } = vi.hoisted(() => {
  function createMockDispatcher(
    this: { options: unknown; dispatch: Dispatcher["dispatch"] },
    options: unknown,
  ) {
    this.options = options;
    this.dispatch = vi.fn(() => true);
  }
  return {
    agentCtor: vi.fn(createMockDispatcher),
    envHttpProxyAgentCtor: vi.fn(createMockDispatcher),
    proxyAgentCtor: vi.fn(createMockDispatcher),
  };
});

const { getDefaultAutoSelectFamily, isWSL2SyncMock } = vi.hoisted(() => ({
  getDefaultAutoSelectFamily: vi.fn(() => true as boolean | undefined),
  isWSL2SyncMock: vi.fn(() => false),
}));

vi.mock("node:net", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:net")>()),
  getDefaultAutoSelectFamily,
}));

vi.mock("../wsl.js", () => ({ isWSL2Sync: isWSL2SyncMock }));

import type { PinnedHostname } from "./ssrf.js";

let createPinnedDispatcher: typeof import("./ssrf.js").createPinnedDispatcher;

beforeAll(async () => {
  ({ createPinnedDispatcher } = await import("./ssrf.js"));
});

beforeEach(() => {
  vi.clearAllMocks();
  getDefaultAutoSelectFamily.mockReturnValue(true);
  isWSL2SyncMock.mockReturnValue(false);
  (globalThis as Record<string, unknown>)[TEST_UNDICI_RUNTIME_DEPS_KEY] = {
    Agent: agentCtor,
    EnvHttpProxyAgent: envHttpProxyAgentCtor,
    ProxyAgent: proxyAgentCtor,
    fetch: vi.fn(),
  };
});

afterEach(() => {
  Reflect.deleteProperty(globalThis as object, TEST_UNDICI_RUNTIME_DEPS_KEY);
  vi.unstubAllEnvs();
});

function createPinnedTelegramHost(
  lookup: PinnedHostname["lookup"],
  address = "149.154.167.220",
): PinnedHostname {
  return { hostname: telegram, addresses: [address], lookup };
}

function createDispatcherWithPinnedOverride(lookup: PinnedHostname["lookup"]) {
  createPinnedDispatcher(createPinnedTelegramHost(lookup, "149.154.167.221"), {
    mode: "direct",
    pinnedHostname: { hostname: telegram, addresses: ["149.154.167.220"] },
  });

  const call = agentCtor.mock.calls[agentCtor.mock.calls.length - 1];
  return (call?.[0] as { connect?: { lookup?: PinnedHostname["lookup"] } })?.connect?.lookup;
}

const requireRecord = createRequireRecord("record", "expected-label");

function dispatchToOwner(
  dispatcher: Dispatcher,
  request: Dispatcher.DispatchOptions,
  expectedOwner: typeof agentCtor,
): Record<string, unknown> {
  const owners = [agentCtor, envHttpProxyAgentCtor, proxyAgentCtor].flatMap((owner) =>
    owner.mock.instances.map((instance) => {
      const candidate = requireRecord(instance);
      const dispatch = candidate.dispatch;
      if (!vi.isMockFunction(dispatch)) {
        throw new Error("expected dispatcher spy");
      }
      return { owner, options: candidate.options, dispatch, before: dispatch.mock.calls.length };
    }),
  );
  dispatcher.dispatch(request, {});
  const observations = owners.flatMap(({ owner, options, dispatch, before }) =>
    dispatch.mock.calls.slice(before).map((args) => ({ owner, options, args })),
  );
  expect(observations).toEqual([
    expect.objectContaining({ owner: expectedOwner, args: [request, {}] }),
  ]);
  return requireRecord(observations[0]?.options, "dispatched owner options");
}

describe("createPinnedDispatcher", () => {
  it("reuses the global WSL2 autoSelectFamily policy for pinned dispatchers", () => {
    isWSL2SyncMock.mockReturnValue(true);
    const lookup = vi.fn() as unknown as PinnedHostname["lookup"];
    createPinnedDispatcher(createPinnedTelegramHost(lookup));
    expect(agentCtor).toHaveBeenCalledWith({
      factory: expect.any(Function),
      connect: { ...familyOptions, lookup, autoSelectFamily: false },
      allowH2: false,
    });
  });

  it("replaces the pinned lookup when a dispatcher override hostname is provided", async () => {
    const originalLookup = vi.fn() as unknown as PinnedHostname["lookup"];
    const lookup = createDispatcherWithPinnedOverride(originalLookup);

    expect(lookup).toBeTypeOf("function");
    const result = await new Promise<[unknown, string, number]>((resolve) => {
      lookup?.(telegram, (err, address, family) => {
        resolve([err, address as string, family as number]);
      });
    });

    expect(result).toEqual([null, "149.154.167.220", 4]);
    expect(originalLookup).not.toHaveBeenCalled();
  });

  it("keeps the override bound to the matching hostname only", () => {
    const originalLookupMock = vi.fn(
      (_hostname: string, callback: (err: null, address: string, family: number) => void) => {
        callback(null, "93.184.216.34", 4);
      },
    );
    const originalLookup = originalLookupMock as unknown as PinnedHostname["lookup"];
    const lookup = createDispatcherWithPinnedOverride(originalLookup);
    const callback = vi.fn();
    lookup?.("example.com", callback);

    expect(originalLookupMock).toHaveBeenCalledWith("example.com", expect.any(Function));
    expect(callback).toHaveBeenCalledWith(null, "93.184.216.34", 4);
  });

  it.each([
    [telegram, "149.154.167.221", "127.0.0.1", undefined],
    ["model.lan", "192.168.1.25", "64:ff9b::127.0.0.1", { allowedHostnames: ["model.lan"] }],
  ] as const)("rejects %s override rebound to loopback", (hostname, address, rebound, policy) => {
    expect(() =>
      createPinnedDispatcher(
        { hostname, addresses: [address], lookup: vi.fn() },
        { mode: "direct", pinnedHostname: { hostname, addresses: [rebound] } },
        policy && { allowedHostnames: [...policy.allowedHostnames] },
      ),
    ).toThrow(/private|internal|blocked/i);
  });

  it("keeps env proxy route while pinning the direct no-proxy path", () => {
    vi.stubEnv("http_proxy", proxyUrl);
    vi.stubEnv("https_proxy", "");
    vi.stubEnv("no_proxy", "");
    const lookup = vi.fn() as unknown as PinnedHostname["lookup"];
    const dispatcher = createPinnedDispatcher(createPinnedTelegramHost(lookup), {
      mode: "env-proxy",
      connect: { autoSelectFamily: true, lookup: vi.fn(), ca: "target-ca" },
      proxyTls: { autoSelectFamily: true, ca: "proxy-ca" },
    });
    const proxyOptions = dispatchToOwner(dispatcher, telegramRequest, proxyAgentCtor);
    expect(proxyOptions).toMatchObject({
      uri: proxyUrl,
      allowH2: false,
      proxyTunnel: true,
      proxyTls: { ...familyOptions, ca: "proxy-ca" },
    });
    expect(proxyOptions.proxyTls).not.toHaveProperty("lookup");

    vi.stubEnv("no_proxy", telegram);
    const directOptions = dispatchToOwner(dispatcher, telegramRequest, envHttpProxyAgentCtor);
    expect(directOptions.allowH2).toBe(false);
    expect(directOptions.connect).toEqual({ ...familyOptions, lookup, ca: "target-ca" });
  });

  it("keeps explicit proxy routing intact", () => {
    const lookup = vi.fn() as unknown as PinnedHostname["lookup"];
    const dispatcher = createPinnedDispatcher(createPinnedTelegramHost(lookup), {
      mode: "explicit-proxy",
      proxyUrl,
      proxyTls: { autoSelectFamily: false, ca: "target-ca" },
    });
    const options = dispatchToOwner(dispatcher, telegramRequest, proxyAgentCtor);
    expect(options).toMatchObject({
      uri: proxyUrl,
      proxyTunnel: true,
      proxyTls: familyOptions,
      allowH2: false,
      requestTls: { autoSelectFamily: false, ca: "target-ca", lookup },
    });
    expect(options.proxyTls).not.toHaveProperty("lookup");
    expect(options.proxyTls).not.toHaveProperty("ca");
  });
});
