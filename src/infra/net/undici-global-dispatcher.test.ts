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
    static shouldThrow = false;

    constructor(public readonly options?: Record<string, unknown>) {
      if (EnvHttpProxyAgent.shouldThrow) {
        throw new Error("invalid proxy env");
      }
    }
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

vi.mock("./proxy-env.js", () => ({
  hasEnvHttpProxyConfigured: vi.fn(() => false),
}));

import { hasEnvHttpProxyConfigured } from "./proxy-env.js";
import {
  DEFAULT_UNDICI_STREAM_TIMEOUT_MS,
  ensureGlobalUndiciEnvProxyDispatcher,
  ensureGlobalUndiciStreamTimeouts,
  resetGlobalUndiciStreamTimeoutsForTests,
} from "./undici-global-dispatcher.js";

describe("ensureGlobalUndiciStreamTimeouts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetGlobalUndiciStreamTimeoutsForTests();
    setCurrentDispatcher(new Agent());
    getDefaultAutoSelectFamily.mockReturnValue(undefined);
    vi.mocked(hasEnvHttpProxyConfigured).mockReturnValue(false);
    EnvHttpProxyAgent.shouldThrow = false;
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

  it("upgrades default Agent dispatcher to EnvHttpProxyAgent when env HTTP proxy is configured", () => {
    vi.mocked(hasEnvHttpProxyConfigured).mockReturnValue(true);
    getDefaultAutoSelectFamily.mockReturnValue(true);

    ensureGlobalUndiciStreamTimeouts();

    expect(setGlobalDispatcher).toHaveBeenCalledTimes(1);
    const next = getCurrentDispatcher() as { options?: Record<string, unknown> };
    expect(next).toBeInstanceOf(EnvHttpProxyAgent);
    expect(next.options?.bodyTimeout).toBe(DEFAULT_UNDICI_STREAM_TIMEOUT_MS);
    expect(next.options?.headersTimeout).toBe(DEFAULT_UNDICI_STREAM_TIMEOUT_MS);
    expect(next.options?.connect).toEqual({
      autoSelectFamily: true,
      autoSelectFamilyAttemptTimeout: 300,
    });
  });

  it("does not upgrade default Agent dispatcher when only non-HTTP proxy env is configured", () => {
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

  it("falls back to Agent hardening when env HTTP proxy upgrade fails", () => {
    vi.mocked(hasEnvHttpProxyConfigured).mockReturnValue(true);
    getDefaultAutoSelectFamily.mockReturnValue(true);
    EnvHttpProxyAgent.shouldThrow = true;

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

  it("reinstalls env proxy hardening if the dispatcher later reverts to Agent", () => {
    vi.mocked(hasEnvHttpProxyConfigured).mockReturnValue(true);
    getDefaultAutoSelectFamily.mockReturnValue(true);

    ensureGlobalUndiciStreamTimeouts();
    expect(setGlobalDispatcher).toHaveBeenCalledTimes(1);
    expect(getCurrentDispatcher()).toBeInstanceOf(EnvHttpProxyAgent);

    setCurrentDispatcher(new Agent());
    ensureGlobalUndiciStreamTimeouts();

    expect(setGlobalDispatcher).toHaveBeenCalledTimes(2);
    expect(getCurrentDispatcher()).toBeInstanceOf(EnvHttpProxyAgent);
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

describe("ensureGlobalUndiciEnvProxyDispatcher", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetGlobalUndiciStreamTimeoutsForTests();
    setCurrentDispatcher(new Agent());
    vi.mocked(hasEnvHttpProxyConfigured).mockReturnValue(false);
  });

  it("installs EnvHttpProxyAgent when env HTTP proxy is configured on a default Agent", () => {
    vi.mocked(hasEnvHttpProxyConfigured).mockReturnValue(true);

    ensureGlobalUndiciEnvProxyDispatcher();

    expect(setGlobalDispatcher).toHaveBeenCalledTimes(1);
    expect(getCurrentDispatcher()).toBeInstanceOf(EnvHttpProxyAgent);
  });

  it("does not override unsupported custom proxy dispatcher types", () => {
    vi.mocked(hasEnvHttpProxyConfigured).mockReturnValue(true);
    setCurrentDispatcher(new ProxyAgent("http://proxy.test:8080"));

    ensureGlobalUndiciEnvProxyDispatcher();

    expect(setGlobalDispatcher).not.toHaveBeenCalled();
  });

  it("retries proxy bootstrap after an unsupported dispatcher later becomes a default Agent", () => {
    vi.mocked(hasEnvHttpProxyConfigured).mockReturnValue(true);
    setCurrentDispatcher(new ProxyAgent("http://proxy.test:8080"));

    ensureGlobalUndiciEnvProxyDispatcher();
    expect(setGlobalDispatcher).not.toHaveBeenCalled();

    setCurrentDispatcher(new Agent());
    ensureGlobalUndiciEnvProxyDispatcher();

    expect(setGlobalDispatcher).toHaveBeenCalledTimes(1);
    expect(getCurrentDispatcher()).toBeInstanceOf(EnvHttpProxyAgent);
  });

  it("is idempotent after proxy bootstrap succeeds", () => {
    vi.mocked(hasEnvHttpProxyConfigured).mockReturnValue(true);

    ensureGlobalUndiciEnvProxyDispatcher();
    ensureGlobalUndiciEnvProxyDispatcher();

    expect(setGlobalDispatcher).toHaveBeenCalledTimes(1);
  });

  it("reinstalls env proxy if an external change later reverts the dispatcher to Agent", () => {
    vi.mocked(hasEnvHttpProxyConfigured).mockReturnValue(true);

    ensureGlobalUndiciEnvProxyDispatcher();
    expect(setGlobalDispatcher).toHaveBeenCalledTimes(1);

    setCurrentDispatcher(new Agent());
    ensureGlobalUndiciEnvProxyDispatcher();

    expect(setGlobalDispatcher).toHaveBeenCalledTimes(2);
    expect(getCurrentDispatcher()).toBeInstanceOf(EnvHttpProxyAgent);
  });
});
