import { EnvHttpProxyAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyProxyFromEnv } from "./proxy-setup.js";

describe("applyProxyFromEnv", () => {
  let originalDispatcher: ReturnType<typeof getGlobalDispatcher>;

  beforeEach(() => {
    originalDispatcher = getGlobalDispatcher();
  });

  afterEach(() => {
    setGlobalDispatcher(originalDispatcher);
    delete process.env.HTTP_PROXY;
    delete process.env.HTTPS_PROXY;
    delete process.env.http_proxy;
    delete process.env.https_proxy;
  });

  it("sets EnvHttpProxyAgent when HTTPS_PROXY is set", () => {
    process.env.HTTPS_PROXY = "http://proxy.example.com:8080";
    applyProxyFromEnv();
    expect(getGlobalDispatcher()).toBeInstanceOf(EnvHttpProxyAgent);
  });

  it("sets EnvHttpProxyAgent when HTTP_PROXY is set", () => {
    process.env.HTTP_PROXY = "http://proxy.example.com:8080";
    applyProxyFromEnv();
    expect(getGlobalDispatcher()).toBeInstanceOf(EnvHttpProxyAgent);
  });

  it("sets EnvHttpProxyAgent when lowercase https_proxy is set", () => {
    process.env.https_proxy = "http://proxy.example.com:8080";
    applyProxyFromEnv();
    expect(getGlobalDispatcher()).toBeInstanceOf(EnvHttpProxyAgent);
  });

  it("does not change dispatcher when no proxy env vars are set", () => {
    const before = getGlobalDispatcher();
    applyProxyFromEnv();
    expect(getGlobalDispatcher()).toBe(before);
  });

  it("respects NO_PROXY for localhost traffic", () => {
    process.env.HTTPS_PROXY = "http://proxy.example.com:8080";
    process.env.NO_PROXY = "localhost,127.0.0.1";
    applyProxyFromEnv();
    expect(getGlobalDispatcher()).toBeInstanceOf(EnvHttpProxyAgent);
  });
});
