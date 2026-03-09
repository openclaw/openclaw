import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  Agent,
  EnvHttpProxyAgent,
  ProxyAgent,
  getGlobalDispatcher,
  setGlobalDispatcher,
  setCurrentDispatcher,
  getCurrentDispatcher,
  getDefaultAutoSelectFamily,
} = vi.hoisted(() => {
  class Agent {
    constructor(public readonly options?: Record<string, unknown>) {}
  }

  class EnvHttpProxyAgent {
    constructor(public readonly options?: Record<string, unknown>) {}
  }

  class ProxyAgent {
    constructor(public readonly url: string) {}
  }

  let currentDispatcher: unknown = new Agent();

  const getGlobalDispatcher = vi.fn(() => currentDispatcher);
  const setGlobalDispatcher = vi.fn((next: unknown) => {
    currentDispatcher = next;
  });
  const setCurrentDispatcher = (next: unknown) => {
    currentDispatcher = next;
  };
  const getCurrentDispatcher = () => currentDispatcher;
  const getDefaultAutoSelectFamily = vi.fn(() => undefined as boolean | undefined);

  return {
    Agent,
    EnvHttpProxyAgent,
    ProxyAgent,
    getGlobalDispatcher,
    setGlobalDispatcher,
    setCurrentDispatcher,
    getCurrentDispatcher,
    getDefaultAutoSelectFamily,
  };
});

vi.mock("undici", () => ({
  Agent,
  EnvHttpProxyAgent,
  getGlobalDispatcher,
  setGlobalDispatcher,
}));

vi.mock("node:net", () => ({
  getDefaultAutoSelectFamily,
}));

import {
  DEFAULT_UNDICI_STREAM_TIMEOUT_MS,
  ensureGlobalUndiciStreamTimeouts,
  resetGlobalUndiciStreamTimeoutsForTests,
} from "./undici-global-dispatcher.js";

describe("ensureGlobalUndiciStreamTimeouts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    vi.stubEnv("HTTP_PROXY", "");
    vi.stubEnv("HTTPS_PROXY", "");
    vi.stubEnv("ALL_PROXY", "");
    vi.stubEnv("http_proxy", "");
    vi.stubEnv("https_proxy", "");
    vi.stubEnv("all_proxy", "");
    resetGlobalUndiciStreamTimeoutsForTests();
    setCurrentDispatcher(new Agent());
    getDefaultAutoSelectFamily.mockReturnValue(undefined);
  });

  it("replaces default Agent dispatcher with extended stream timeouts", () => {
    getDefaultAutoSelectFamily.mockReturnValue(true);

    ensureGlobalUndiciStreamTimeouts();

    expect(setGlobalDispatcher).toHaveBeenCalledTimes(1);
    const next = getCurrentDispatcher() as { options?: Record<string, unknown> };
    expect(next).toBeInstanceOf(Agent);
    expect(next.options?.bodyTimeout).toBe(DEFAULT_UNDICI_STREAM_TIMEOUT_MS);
    expect(next.options?.headersTimeout).toBe(DEFAULT_UNDICI_STREAM_TIMEOUT_MS);
    expect(next.options?.connect).toEqual({
      autoSelectFamily: true,
      autoSelectFamilyAttemptTimeout: 300,
    });
  });

  it("replaces EnvHttpProxyAgent dispatcher while preserving env-proxy mode", () => {
    getDefaultAutoSelectFamily.mockReturnValue(false);
    setCurrentDispatcher(new EnvHttpProxyAgent());

    ensureGlobalUndiciStreamTimeouts();

    expect(setGlobalDispatcher).toHaveBeenCalledTimes(1);
    const next = getCurrentDispatcher() as { options?: Record<string, unknown> };
    expect(next).toBeInstanceOf(EnvHttpProxyAgent);
    expect(next.options?.bodyTimeout).toBe(DEFAULT_UNDICI_STREAM_TIMEOUT_MS);
    expect(next.options?.headersTimeout).toBe(DEFAULT_UNDICI_STREAM_TIMEOUT_MS);
    expect(next.options?.connect).toEqual({
      autoSelectFamily: false,
      autoSelectFamilyAttemptTimeout: 300,
    });
  });

  it("upgrades default Agent dispatcher to EnvHttpProxyAgent when HTTP(S) proxy env is configured", () => {
    vi.stubEnv("HTTPS_PROXY", "http://proxy.test:8080");

    ensureGlobalUndiciStreamTimeouts();

    expect(setGlobalDispatcher).toHaveBeenCalledTimes(1);
    const next = getCurrentDispatcher() as { options?: Record<string, unknown> };
    expect(next).toBeInstanceOf(EnvHttpProxyAgent);
    expect(next.options?.bodyTimeout).toBe(DEFAULT_UNDICI_STREAM_TIMEOUT_MS);
    expect(next.options?.headersTimeout).toBe(DEFAULT_UNDICI_STREAM_TIMEOUT_MS);
  });

  it("does not upgrade default Agent dispatcher when only ALL_PROXY is configured", () => {
    vi.stubEnv("ALL_PROXY", "socks5://proxy.test:1080");

    ensureGlobalUndiciStreamTimeouts();

    expect(setGlobalDispatcher).toHaveBeenCalledTimes(1);
    const next = getCurrentDispatcher() as { options?: Record<string, unknown> };
    expect(next).toBeInstanceOf(Agent);
    expect(next.options?.bodyTimeout).toBe(DEFAULT_UNDICI_STREAM_TIMEOUT_MS);
    expect(next.options?.headersTimeout).toBe(DEFAULT_UNDICI_STREAM_TIMEOUT_MS);
  });

  it("does not override unsupported custom proxy dispatcher types", () => {
    setCurrentDispatcher(new ProxyAgent("http://proxy.test:8080"));

    ensureGlobalUndiciStreamTimeouts();

    expect(setGlobalDispatcher).not.toHaveBeenCalled();
  });

  it("is idempotent for unchanged dispatcher kind and network policy", () => {
    getDefaultAutoSelectFamily.mockReturnValue(true);

    ensureGlobalUndiciStreamTimeouts();
    ensureGlobalUndiciStreamTimeouts();

    expect(setGlobalDispatcher).toHaveBeenCalledTimes(1);
  });

  it("re-applies when autoSelectFamily decision changes", () => {
    getDefaultAutoSelectFamily.mockReturnValue(true);
    ensureGlobalUndiciStreamTimeouts();

    getDefaultAutoSelectFamily.mockReturnValue(false);
    ensureGlobalUndiciStreamTimeouts();

    expect(setGlobalDispatcher).toHaveBeenCalledTimes(2);
    const next = getCurrentDispatcher() as { options?: Record<string, unknown> };
    expect(next.options?.connect).toEqual({
      autoSelectFamily: false,
      autoSelectFamilyAttemptTimeout: 300,
    });
  });

  it("re-applies after another subsystem replaces the env proxy dispatcher", () => {
    vi.stubEnv("HTTPS_PROXY", "http://proxy.test:8080");

    ensureGlobalUndiciStreamTimeouts();
    expect(setGlobalDispatcher).toHaveBeenCalledTimes(1);

    setCurrentDispatcher(new EnvHttpProxyAgent({ connect: { autoSelectFamily: false } }));

    ensureGlobalUndiciStreamTimeouts();

    expect(setGlobalDispatcher).toHaveBeenCalledTimes(2);
    const next = getCurrentDispatcher() as { options?: Record<string, unknown> };
    expect(next).toBeInstanceOf(EnvHttpProxyAgent);
    expect(next.options?.bodyTimeout).toBe(DEFAULT_UNDICI_STREAM_TIMEOUT_MS);
    expect(next.options?.headersTimeout).toBe(DEFAULT_UNDICI_STREAM_TIMEOUT_MS);
  });
});
