import { beforeEach, describe, expect, it, vi } from "vitest";

// Hoist mock classes before importing the module
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

// Now import the module under test
import {
  DEFAULT_UNDICI_STREAM_TIMEOUT_MS,
  ensureGlobalUndiciStreamTimeouts,
  resetGlobalUndiciStreamTimeoutsForTests,
  expandNoProxyPatterns,
} from "./undici-global-dispatcher.js";

describe("expandNoProxyPatterns", () => {
  it("expands leading dot patterns", () => {
    const result = expandNoProxyPatterns(".example.com");
    expect(result).toContain("example.com");
    expect(result).toContain(".example.com");
  });

  it("auto-adds COS domains", () => {
    const result = expandNoProxyPatterns("localhost");
    expect(result).toContain("myqcloud.com");
    expect(result).toContain(".myqcloud.com");
  });

  it("preserves existing entries", () => {
    const result = expandNoProxyPatterns("example.com,test.org");
    expect(result).toContain("example.com");
    expect(result).toContain("test.org");
  });

  it("handles empty input", () => {
    expect(expandNoProxyPatterns("")).toEqual([]);
    expect(expandNoProxyPatterns("   ")).toEqual([]);
  });

  it("deduplicates entries", () => {
    const result = expandNoProxyPatterns(".myqcloud.com,myqcloud.com");
    expect(result.filter(x => x === "myqcloud.com").length).toBe(1);
    expect(result.filter(x => x === ".myqcloud.com").length).toBe(1);
  });
});

describe("ensureGlobalUndiciStreamTimeouts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
