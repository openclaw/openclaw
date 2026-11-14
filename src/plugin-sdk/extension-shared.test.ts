// Extension shared tests cover plugin-safe shared runtime helpers and proxy configuration.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execNodeEvalSync } from "../test-utils/node-process.js";

const createAmbientNodeProxyAgentMock = vi.hoisted(() =>
  vi.fn((): { proxy: true } | undefined => ({ proxy: true })),
);
const hasAmbientNodeProxyConfiguredMock = vi.hoisted(() => vi.fn(() => true));
const loadProxylineMock = vi.hoisted(() => vi.fn());

vi.mock("../infra/net/proxyline-runtime.js", () => ({
  loadProxyline: loadProxylineMock,
}));

import { resolveAmbientNodeProxyAgent } from "./extension-shared.js";

it("leaves Proxyline unloaded for generic SDK helpers in a fresh process", () => {
  const output = execNodeEvalSync(
    `
      import assert from "node:assert/strict";
      import { registerHooks } from "node:module";
      let loads = 0;
      const hook = registerHooks({
        resolve(specifier, context, nextResolve) {
          if (specifier === "@openclaw/proxyline") loads++;
          return nextResolve(specifier, context);
        },
      });
      let agent;
      try {
        const shared = await import(${JSON.stringify(new URL("./extension-shared.ts", import.meta.url).href)});
        assert.equal(loads, 0, "generic SDK imports must leave Proxyline unloaded");
        const deferred = shared.createDeferred();
        deferred.resolve("ready");
        assert.equal(await deferred.promise, "ready");
        assert.equal(shared.formatPluginConfigIssue(undefined), "invalid config");
        assert.equal(loads, 0, "generic SDK helpers must leave Proxyline unloaded");
        for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
          "http_proxy", "https_proxy", "all_proxy", "no_proxy", "OPENCLAW_PROXY_ACTIVE"]) {
          delete process.env[key];
        }
        process.env.HTTPS_PROXY = "http://upper.example.test:8080";
        process.env.https_proxy = "http://lower.example.test:8080";
        agent = await shared.resolveAmbientNodeProxyAgent();
        assert.ok(agent);
        assert.equal(loads, 1, "proxy resolution must load the real factory");
        assert.equal(agent.getProxyForUrl(new URL("https://target.example.test/")),
          "http://lower.example.test:8080/");
        console.log("ok");
      } finally {
        agent?.destroy();
        hook.deregister();
      }
    `,
    { imports: ["tsx"] },
  );
  expect(output.trim()).toBe("ok");
});

describe("resolveAmbientNodeProxyAgent", () => {
  const envKeys = [
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "https_proxy",
    "http_proxy",
    "OPENCLAW_PROXY_ACTIVE",
    "OPENCLAW_PROXY_CA_FILE",
  ] as const;
  const tempDirs: string[] = [];

  beforeEach(() => {
    createAmbientNodeProxyAgentMock.mockReset().mockReturnValue({ proxy: true });
    hasAmbientNodeProxyConfiguredMock.mockReset().mockReturnValue(true);
    loadProxylineMock.mockReset().mockReturnValue({
      createAmbientNodeProxyAgent: createAmbientNodeProxyAgentMock,
      hasAmbientNodeProxyConfigured: hasAmbientNodeProxyConfiguredMock,
    });
    for (const key of envKeys) {
      vi.stubEnv(key, "");
    }
  });

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
    vi.unstubAllEnvs();
  });

  function writeTempCa(contents: string): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), "openclaw-extension-shared-proxy-ca-"));
    tempDirs.push(dir);
    const caFile = path.join(dir, "proxy-ca.pem");
    writeFileSync(caFile, contents, "utf8");
    return caFile;
  }

  it("does not create an agent when ambient proxy detection is false", async () => {
    hasAmbientNodeProxyConfiguredMock.mockReturnValue(false);
    const onUsingProxy = vi.fn();

    expect(await resolveAmbientNodeProxyAgent({ onUsingProxy })).toBeUndefined();
    expect(loadProxylineMock).toHaveBeenCalledOnce();
    expect(hasAmbientNodeProxyConfiguredMock).toHaveBeenCalledExactlyOnceWith({
      protocol: "https",
    });
    expect(createAmbientNodeProxyAgentMock).not.toHaveBeenCalled();
    expect(onUsingProxy).not.toHaveBeenCalled();
  });

  it.each(["http", "https"] as const)("preserves the selected %s protocol", async (protocol) => {
    const onUsingProxy = vi.fn();

    expect(await resolveAmbientNodeProxyAgent({ protocol, onUsingProxy })).toEqual({
      proxy: true,
    });
    expect(hasAmbientNodeProxyConfiguredMock).toHaveBeenCalledExactlyOnceWith({ protocol });
    expect(createAmbientNodeProxyAgentMock).toHaveBeenCalledExactlyOnceWith({ protocol });
    expect(onUsingProxy).toHaveBeenCalledOnce();
  });

  it("does not report proxy use when the factory returns no agent", async () => {
    createAmbientNodeProxyAgentMock.mockReturnValue(undefined);
    const onUsingProxy = vi.fn();

    expect(await resolveAmbientNodeProxyAgent({ onUsingProxy })).toBeUndefined();
    expect(onUsingProxy).not.toHaveBeenCalled();
  });

  it("preserves detection failures as rejected calls", async () => {
    const failure = new Error("proxy detection failed");
    hasAmbientNodeProxyConfiguredMock.mockImplementation(() => {
      throw failure;
    });
    const onError = vi.fn();

    await expect(resolveAmbientNodeProxyAgent({ onError })).rejects.toBe(failure);
    expect(onError).not.toHaveBeenCalled();
    expect(createAmbientNodeProxyAgentMock).not.toHaveBeenCalled();
  });

  it("reports factory failures without reporting proxy use", async () => {
    const failure = new Error("proxy agent failed");
    createAmbientNodeProxyAgentMock.mockImplementation(() => {
      throw failure;
    });
    const onError = vi.fn();
    const onUsingProxy = vi.fn();

    expect(await resolveAmbientNodeProxyAgent({ onError, onUsingProxy })).toBeUndefined();
    expect(onError).toHaveBeenCalledExactlyOnceWith(failure);
    expect(onUsingProxy).not.toHaveBeenCalled();
  });

  it("adds managed proxy CA trust to ambient Node proxy agents", async () => {
    const caFile = writeTempCa("extension-shared-managed-proxy-ca");
    vi.stubEnv("https_proxy", "https://proxy.example:8443");
    vi.stubEnv("OPENCLAW_PROXY_ACTIVE", "1");
    vi.stubEnv("OPENCLAW_PROXY_CA_FILE", caFile);

    const agent = await resolveAmbientNodeProxyAgent<{ proxy: true }>();

    expect(agent).toEqual({ proxy: true });
    expect(createAmbientNodeProxyAgentMock).toHaveBeenCalledWith({
      protocol: "https",
      proxyTls: { ca: "extension-shared-managed-proxy-ca" },
    });
  });
});
