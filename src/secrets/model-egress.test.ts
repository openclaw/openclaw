import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createDeferredCore } from "../shared/deferred.js";
import type { SecretEgressProxyHandle } from "./egress-proxy/proxy-server.js";
import { withConfiguredModelEgress } from "./model-egress.js";
import { looksLikeSecretSentinel, resolveSecretSentinel } from "./sentinel.js";

const startProxy = vi.hoisted(() =>
  vi.fn<typeof import("./egress-proxy/proxy-server.js").startSecretEgressProxyServer>(),
);
vi.mock("./egress-proxy/proxy-server.js", () => ({
  startSecretEgressProxyServer: startProxy,
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const credential = "synthetic-model-egress-api-key";
const publicCa = "synthetic-public-ca-bundle";
let config: OpenClawConfig;
let proxy: SecretEgressProxyHandle;
const revoke = vi.fn();

beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubEnv("OPENAI_BASE_URL", undefined);
  vi.stubEnv("OPENCLAW_SECRET_SENTINELS", "off");
  const dir = tempDirs.make("model-egress-test-");
  const secretPath = path.join(dir, "key.txt");
  const caPath = path.join(dir, "ca.pem");
  await fs.writeFile(secretPath, credential, { mode: 0o600 });
  await fs.writeFile(caPath, publicCa);
  config = {
    secrets: {
      providers: { model_key: { source: "file", path: secretPath, mode: "singleValue" } },
    },
    models: {
      providers: {
        openai: {
          apiKey: { source: "file", provider: "model_key", id: "value" },
          baseUrl: "",
          models: [],
        },
      },
    },
  };
  proxy = {
    caCertPath: caPath,
    proxyOrigin: "http://127.0.0.1:12345",
    getCertificateStatus: () => ({
      state: "ready",
      caExpiresAt: "2030-01-01",
      failedCertificates: 0,
    }),
    registerProcess: vi.fn(() => ({
      env: {
        HTTPS_PROXY: "http://openclaw:synthetic-proxy-token@127.0.0.1:12345",
        NODE_EXTRA_CA_CERTS: caPath,
      },
      revoke,
    })),
    stop: vi.fn(async () => {}),
  };
  startProxy.mockResolvedValue(proxy);
});

afterEach(() => vi.unstubAllEnvs());

function runOptions() {
  return { config, provider: "openai", model: "gpt-5.5" };
}

describe("configured model egress", () => {
  it("uses the provider-owned default route and seals a file-backed credential only for its host", async () => {
    // Authored provider config can omit its default transport, even though materialized config has one.
    Reflect.deleteProperty(config.models!.providers!.openai!, "baseUrl");
    const result = await withConfiguredModelEgress(runOptions(), async (egress) => {
      expect(egress).toMatchObject({
        baseUrl: "https://api.openai.com/v1",
        model: "gpt-5.5",
        allowedHosts: ["api.openai.com"],
        caBundle: publicCa,
      });
      expect(looksLikeSecretSentinel(egress.sentinel)).toBe(true);
      expect(resolveSecretSentinel(egress.sentinel)).toBe(credential);
      expect(JSON.stringify(egress)).not.toContain(credential);
      expect(proxy.registerProcess).toHaveBeenCalledWith([
        {
          name: "openai model API key",
          sentinel: egress.sentinel,
          allowedHosts: ["api.openai.com"],
        },
      ]);
      expect(revoke).not.toHaveBeenCalled();
      return 17;
    });
    expect(result).toBe(17);
    expect(revoke).toHaveBeenCalled();
    expect(proxy.stop).toHaveBeenCalledOnce();
    const options = startProxy.mock.calls[0]![0];
    expect(options.allowedHosts).toEqual(["api.openai.com"]);
    await expect(fs.stat(options.caDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("binds a configured compatible endpoint instead of the provider default", async () => {
    config.models!.providers!.openai!.baseUrl = "https://inference.example.test/tenant/v1";
    await withConfiguredModelEgress(runOptions(), async (egress) => {
      expect(egress.baseUrl).toBe("https://inference.example.test/tenant/v1");
      expect(egress.allowedHosts).toEqual(["inference.example.test"]);
    });
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
    expect(stdout.join("")).not.toContain(credential);
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

  it("revokes synchronously on cancellation while the remote job is still settling", async () => {
    const controller = new AbortController();
    const entered = createDeferredCore();
    const settle = createDeferredCore();
    const running = withConfiguredModelEgress(
      { ...runOptions(), signal: controller.signal },
      async () => {
        entered.resolve();
        await settle.promise;
      },
    );
    await entered.promise;
    controller.abort(new Error("job cancelled"));
    expect(revoke).toHaveBeenCalled();
    expect(proxy.stop).not.toHaveBeenCalled();
    settle.resolve();
    await expect(running).rejects.toThrow("job cancelled");
    expect(proxy.stop).toHaveBeenCalledOnce();
  });

  it("refuses late admission after cancellation during proxy preparation", async () => {
    const controller = new AbortController();
    const entered = createDeferredCore();
    const prepared = createDeferredCore();
    startProxy.mockImplementationOnce(async () => {
      entered.resolve();
      await prepared.promise;
      return proxy;
    });
    const run = vi.fn();
    const running = withConfiguredModelEgress({ ...runOptions(), signal: controller.signal }, run);
    await entered.promise;
    controller.abort(new Error("preparation cancelled"));
    prepared.resolve();
    await expect(running).rejects.toThrow("preparation cancelled");
    expect(proxy.registerProcess).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(proxy.stop).toHaveBeenCalledOnce();
  });

  it("revokes and removes the private CA directory when the command fails", async () => {
    await expect(
      withConfiguredModelEgress(runOptions(), async () => {
        throw new Error("remote command failed");
      }),
    ).rejects.toThrow("remote command failed");
    expect(revoke).toHaveBeenCalled();
    expect(proxy.stop).toHaveBeenCalledOnce();
    const options = startProxy.mock.calls[0]![0];
    await expect(fs.stat(options.caDir)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
