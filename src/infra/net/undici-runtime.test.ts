import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { Agent, EnvHttpProxyAgent } = vi.hoisted(() => {
  class Agent {
    constructor(public readonly options?: Record<string, unknown>) {}
  }
  class EnvHttpProxyAgent {
    constructor(public readonly options?: Record<string, unknown>) {}
  }
  return { Agent, EnvHttpProxyAgent };
});

vi.mock("./undici-global-dispatcher.js", () => ({
  getEffectiveUndiciStreamTimeoutMs: vi.fn(() => null as number | null),
}));

import { getEffectiveUndiciStreamTimeoutMs } from "./undici-global-dispatcher.js";
import {
  createHttp1Agent,
  createHttp1EnvHttpProxyAgent,
  TEST_UNDICI_RUNTIME_DEPS_KEY,
} from "./undici-runtime.js";

beforeEach(() => {
  (globalThis as Record<string, unknown>)[TEST_UNDICI_RUNTIME_DEPS_KEY] = {
    Agent,
    EnvHttpProxyAgent,
    FormData: undefined,
    ProxyAgent: class {
      constructor(public readonly url: string) {}
    },
    fetch: vi.fn(),
  };
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>)[TEST_UNDICI_RUNTIME_DEPS_KEY];
  vi.mocked(getEffectiveUndiciStreamTimeoutMs).mockReturnValue(null);
});

describe("createHttp1Agent", () => {
  it("does not inject timeouts when no effective stream timeout has been configured (#69390)", () => {
    vi.mocked(getEffectiveUndiciStreamTimeoutMs).mockReturnValue(null);

    const agent = createHttp1Agent() as unknown as { options?: Record<string, unknown> };

    expect(agent.options?.headersTimeout).toBeUndefined();
    expect(agent.options?.bodyTimeout).toBeUndefined();
    expect(agent.options?.allowH2).toBe(false);
  });

  it("mirrors the effective stream timeout onto pinned dispatchers when unset (#69390)", () => {
    // SSRF-guarded fetches create per-request pinned Agents that do not
    // inherit the global dispatcher timeouts; without this plumbing slow
    // Ollama streams still hit undici's default 300_000 ms headers timeout.
    vi.mocked(getEffectiveUndiciStreamTimeoutMs).mockReturnValue(1_800_000);

    const agent = createHttp1Agent() as unknown as { options?: Record<string, unknown> };

    expect(agent.options?.headersTimeout).toBe(1_800_000);
    expect(agent.options?.bodyTimeout).toBe(1_800_000);
    expect(agent.options?.allowH2).toBe(false);
  });

  it("preserves caller-provided timeouts over the effective stream timeout (#69390)", () => {
    vi.mocked(getEffectiveUndiciStreamTimeoutMs).mockReturnValue(1_800_000);

    const agent = createHttp1Agent({
      headersTimeout: 10_000,
      bodyTimeout: 20_000,
    } as Parameters<typeof createHttp1Agent>[0]) as unknown as {
      options?: Record<string, unknown>;
    };

    expect(agent.options?.headersTimeout).toBe(10_000);
    expect(agent.options?.bodyTimeout).toBe(20_000);
  });

  it("injects only the missing half of the timeout pair (#69390)", () => {
    vi.mocked(getEffectiveUndiciStreamTimeoutMs).mockReturnValue(1_800_000);

    const agent = createHttp1Agent({ headersTimeout: 5_000 } as Parameters<
      typeof createHttp1Agent
    >[0]) as unknown as { options?: Record<string, unknown> };

    expect(agent.options?.headersTimeout).toBe(5_000);
    expect(agent.options?.bodyTimeout).toBe(1_800_000);
  });
});

describe("createHttp1EnvHttpProxyAgent", () => {
  it("mirrors the effective stream timeout onto env-proxy pinned dispatchers (#69390)", () => {
    vi.mocked(getEffectiveUndiciStreamTimeoutMs).mockReturnValue(900_000);

    const agent = createHttp1EnvHttpProxyAgent() as unknown as {
      options?: Record<string, unknown>;
    };

    expect(agent.options?.headersTimeout).toBe(900_000);
    expect(agent.options?.bodyTimeout).toBe(900_000);
    expect(agent.options?.allowH2).toBe(false);
  });
});
