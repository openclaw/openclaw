import type { LookupAddress } from "node:dns";
import { Agent, EnvHttpProxyAgent, ProxyAgent } from "undici";
import { afterEach, describe, expect, it, vi } from "vitest";
import { attachModelProviderRequestTransport } from "../agents/provider-request-config.js";
import { closeProviderTransportDispatcherPool } from "../agents/provider-transport-dispatcher-pool.js";
import { buildGuardedModelFetch } from "../agents/provider-transport-fetch.js";
import type { Model } from "../llm/types.js";
import { discoverOpenAICompatibleLocalModels } from "./provider-self-hosted-discovery.js";

const lookupMock = vi.hoisted(() => vi.fn<() => Promise<LookupAddress[]>>());
vi.mock("node:dns/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:dns/promises")>()),
  lookup: lookupMock,
}));

const baseUrl = "http://local-provider.example:8081/v1";
const model: Model<"openai-completions"> = {
  id: "local-model",
  name: "Local model",
  provider: "llama-cpp",
  api: "openai-completions",
  baseUrl,
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8192,
  maxTokens: 256,
};

afterEach(async () => {
  await closeProviderTransportDispatcherPool();
  lookupMock.mockReset();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function discover(allowPrivateNetwork?: boolean) {
  return discoverOpenAICompatibleLocalModels({
    baseUrl,
    allowPrivateNetwork,
    label: "llama-server",
    healthPath: "/health",
    rawResult: true,
  });
}

function infer(allowPrivateNetwork?: boolean) {
  return buildGuardedModelFetch(
    attachModelProviderRequestTransport(model, { allowPrivateNetwork }),
  )(`${baseUrl}/chat/completions`);
}

describe.each([
  { setting: "unset", allowPrivateNetwork: undefined },
  { setting: "disabled", allowPrivateNetwork: false },
  { setting: "enabled", allowPrivateNetwork: true },
])("provider network opt-in $setting", ({ allowPrivateNetwork }) => {
  it.each([
    { address: "169.254.1.2", defaultAllowed: false, strictAllowed: false },
    { address: "fe80::12", defaultAllowed: false, strictAllowed: false },
    { address: "169.254.169.254", defaultAllowed: false, strictAllowed: false },
    { address: "100.100.100.200", defaultAllowed: false, strictAllowed: false },
    { address: "fd00:ec2::254", defaultAllowed: false, strictAllowed: false },
    { address: "::ffff:169.254.169.254", defaultAllowed: false, strictAllowed: false },
    { address: "192.168.1.2", defaultAllowed: true, strictAllowed: false },
    { address: "93.184.216.34", defaultAllowed: true, strictAllowed: true },
  ])("admits $address identically for discovery and inference", async (testCase) => {
    lookupMock.mockResolvedValue([
      { address: testCase.address, family: testCase.address.includes(":") ? 6 : 4 },
    ]);
    const fetch = vi.fn(async () => Response.json({ data: [{ id: "local-model" }] }));
    vi.stubGlobal("__OPENCLAW_TEST_UNDICI_RUNTIME_DEPS__", {
      Agent,
      EnvHttpProxyAgent,
      ProxyAgent,
      fetch,
    });
    const allowed =
      allowPrivateNetwork === true ||
      (allowPrivateNetwork === false ? testCase.strictAllowed : testCase.defaultAllowed);

    const discovery = await discover(allowPrivateNetwork);
    if (allowed) {
      expect(discovery).toMatchObject({
        kind: "success",
        rows: [{ model: { id: "local-model" } }],
      });
      expect(fetch).toHaveBeenCalledTimes(3);
      fetch.mockClear();
      const response = await infer(allowPrivateNetwork);
      expect(await response.json()).toEqual({ data: [{ id: "local-model" }] });
      expect(fetch).toHaveBeenCalledTimes(1);
    } else {
      expect(discovery).toMatchObject({ kind: "unreachable", error: expect.any(Error) });
      await expect(infer(allowPrivateNetwork)).rejects.toThrow(/private\/internal\/special-use/);
      expect(fetch).not.toHaveBeenCalled();
    }
  });

  it("keeps the inference guard on cross-host redirects during discovery", async () => {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const fetch = vi.fn(
      async () =>
        new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest" } }),
    );
    vi.stubGlobal("__OPENCLAW_TEST_UNDICI_RUNTIME_DEPS__", {
      Agent,
      EnvHttpProxyAgent,
      ProxyAgent,
      fetch,
    });

    expect(await discover(allowPrivateNetwork)).toMatchObject({ kind: "unreachable" });
    expect(fetch).toHaveBeenCalledTimes(1);
    fetch.mockClear();
    await expect(infer(allowPrivateNetwork)).rejects.toThrow(/not in allowlist/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
