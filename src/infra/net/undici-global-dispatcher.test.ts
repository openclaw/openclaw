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
  withTemporaryEnvProxyDispatcher,
} from "./undici-global-dispatcher.js";

describe("ensureGlobalUndiciStreamTimeouts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
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
});

describe("withTemporaryEnvProxyDispatcher", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    setCurrentDispatcher(new Agent());
    getDefaultAutoSelectFamily.mockReturnValue(undefined);
  });

  it("temporarily installs EnvHttpProxyAgent when proxy env is configured", async () => {
    vi.stubEnv("HTTPS_PROXY", "http://proxy.test:8080");
    const seenDispatchers: unknown[] = [];

    await withTemporaryEnvProxyDispatcher(async () => {
      seenDispatchers.push(getCurrentDispatcher());
    });

    expect(setGlobalDispatcher).toHaveBeenCalledTimes(2);
    expect(seenDispatchers[0]).toBeInstanceOf(EnvHttpProxyAgent);
    expect(getCurrentDispatcher()).toBeInstanceOf(Agent);
  });

  it("does nothing when proxy env is absent", async () => {
    await withTemporaryEnvProxyDispatcher(async () => {});

    expect(setGlobalDispatcher).not.toHaveBeenCalled();
    expect(getCurrentDispatcher()).toBeInstanceOf(Agent);
  });

  it("keeps existing EnvHttpProxyAgent dispatcher untouched", async () => {
    vi.stubEnv("HTTP_PROXY", "http://proxy.test:8080");
    setCurrentDispatcher(new EnvHttpProxyAgent());

    await withTemporaryEnvProxyDispatcher(async () => {});

    expect(setGlobalDispatcher).not.toHaveBeenCalled();
    expect(getCurrentDispatcher()).toBeInstanceOf(EnvHttpProxyAgent);
  });

  it("does not override unsupported custom proxy dispatchers", async () => {
    vi.stubEnv("HTTPS_PROXY", "http://proxy.test:8080");
    const customDispatcher = new ProxyAgent("http://custom-proxy.test:8080");
    setCurrentDispatcher(customDispatcher);

    await withTemporaryEnvProxyDispatcher(async () => {
      expect(getCurrentDispatcher()).toBe(customDispatcher);
    });

    expect(setGlobalDispatcher).not.toHaveBeenCalled();
    expect(getCurrentDispatcher()).toBe(customDispatcher);
  });

  it("keeps nested temporary proxy scopes composable", async () => {
    vi.stubEnv("HTTPS_PROXY", "http://proxy.test:8080");
    const seenDispatchers: unknown[] = [];

    await withTemporaryEnvProxyDispatcher(async () => {
      seenDispatchers.push(getCurrentDispatcher());

      await withTemporaryEnvProxyDispatcher(async () => {
        seenDispatchers.push(getCurrentDispatcher());
      });

      seenDispatchers.push(getCurrentDispatcher());
    });

    expect(setGlobalDispatcher).toHaveBeenCalledTimes(2);
    expect(seenDispatchers[0]).toBeInstanceOf(EnvHttpProxyAgent);
    expect(seenDispatchers[1]).toBeInstanceOf(EnvHttpProxyAgent);
    expect(seenDispatchers[1]).toBe(seenDispatchers[0]);
    expect(seenDispatchers[2]).toBe(seenDispatchers[0]);
    expect(getCurrentDispatcher()).toBeInstanceOf(Agent);
  });

  it("restores the previous dispatcher after errors", async () => {
    vi.stubEnv("HTTP_PROXY", "http://proxy.test:8080");

    await expect(
      withTemporaryEnvProxyDispatcher(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(setGlobalDispatcher).toHaveBeenCalledTimes(2);
    expect(getCurrentDispatcher()).toBeInstanceOf(Agent);
  });
});
