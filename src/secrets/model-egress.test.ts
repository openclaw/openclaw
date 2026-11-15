import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createDeferredCore } from "../shared/deferred.js";
import { publicCa, startProxy, useEgressProxyMock } from "./egress.test-support.js";
import { withConfiguredModelEgress } from "./model-egress.js";
import { resolveSecretSentinel } from "./sentinel.js";

const credential = "synthetic-model-egress-api-key";
const apiKey = { source: "env", provider: "default", id: "MODEL_EGRESS_API_KEY" } as const;
let config: OpenClawConfig;
const { proxy } = useEgressProxyMock();

beforeEach(() => {
  vi.stubEnv("OPENAI_BASE_URL", undefined);
  vi.stubEnv("OPENCLAW_SECRET_SENTINELS", "off");
  vi.stubEnv("MODEL_EGRESS_API_KEY", credential);
  config = { models: { providers: { openai: { apiKey, baseUrl: "", models: [] } } } };
});

afterEach(() => vi.unstubAllEnvs());

function runOptions() {
  return { config, provider: "openai", model: "gpt-5.5" };
}

it.each([
  [undefined, "https://api.openai.com/v1", "api.openai.com"],
  [
    "https://inference.example.test/tenant/v1",
    "https://inference.example.test/tenant/v1",
    "inference.example.test",
  ],
])("seals the credential only for the selected route %s", async (configured, baseUrl, host) => {
  if (configured) {
    config.models!.providers!.openai!.baseUrl = configured;
  } else {
    Reflect.deleteProperty(config.models!.providers!.openai!, "baseUrl");
  }
  const result = await withConfiguredModelEgress(runOptions(), async (egress) => {
    expect(egress).toMatchObject({
      baseUrl,
      model: "gpt-5.5",
      allowedHosts: [host],
      caBundle: publicCa,
    });
    expect(resolveSecretSentinel(egress.sentinel)).toBe(credential);
    expect(JSON.stringify(egress)).not.toContain(credential);
    return 17;
  });
  expect(result).toBe(17);
  expect(startProxy.mock.calls[0]![0].allowedHosts).toEqual([host]);
});

it("streams progress before completion and redacts credentials split between chunks", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  await withConfiguredModelEgress(
    {
      ...runOptions(),
      onOutput: (text, stream) => (stream === "stdout" ? stdout : stderr).push(text),
    },
    async (egress) => {
      egress.onOutputChunk!(Buffer.from("ready "), "stdout");
      expect(stdout.join("")).toBe("ready ");
      egress.onOutputChunk!(Buffer.from(credential.slice(0, 8)), "stdout");
      egress.onOutputChunk!(Buffer.from(credential.slice(8)), "stdout");
      egress.onOutputChunk!(Buffer.from("diagnostic"), "stderr");
      expect(stdout.join("")).toBe("ready <redacted>");
      expect(stderr.join("")).toBe("diagnostic");
    },
  );
});

it.each([
  ["literal or profile credential", { apiKey: "profile-id" }],
  ["OAuth authentication", { auth: "oauth" }],
  ["custom headers", { headers: { Authorization: "synthetic-header" } }],
  ["custom request transport", { request: { proxy: { url: "http://proxy.example.test" } } }],
  ["unencrypted endpoint", { baseUrl: "http://api.openai.com/v1" }],
  ["unsupported endpoint port", { baseUrl: "https://inference.example.test:8443/v1" }],
  ["credential-bearing endpoint", { baseUrl: "https://user:password@inference.example.test/v1" }],
  ["subscription route", { api: "openai-chatgpt-responses" }],
])("rejects %s before starting a proxy", async (_label, override) => {
  Object.assign(config.models!.providers!.openai!, override);
  const run = vi.fn();
  await expect(withConfiguredModelEgress(runOptions(), run)).rejects.toThrow();
  expect(startProxy).not.toHaveBeenCalled();
  expect(run).not.toHaveBeenCalled();
});

it("fences model cancellation before proxy preparation settles", async () => {
  const controller = new AbortController();
  const entered = createDeferredCore();
  const settle = createDeferredCore();
  startProxy.mockImplementationOnce(async () => {
    entered.resolve();
    await settle.promise;
    return proxy;
  });
  const run = vi.fn();
  const running = withConfiguredModelEgress({ ...runOptions(), signal: controller.signal }, run);
  await entered.promise;
  controller.abort(new Error("job cancelled"));
  expect(proxy.stop).not.toHaveBeenCalled();
  settle.resolve();
  await expect(running).rejects.toThrow("job cancelled");
  expect(proxy.registerProcess).not.toHaveBeenCalled();
  expect(run).not.toHaveBeenCalled();
  expect(proxy.stop).toHaveBeenCalledOnce();
});
