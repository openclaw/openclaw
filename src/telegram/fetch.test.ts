import { afterEach, describe, expect, it, vi } from "vitest";

describe("resolveTelegramFetch", () => {
  const originalFetch = globalThis.fetch;

  const loadModule = async () => {
    vi.resetModules();
    // Mock undici Agent
    const AgentMock = vi.fn().mockImplementation(() => ({}));
    vi.doMock("undici", () => ({
      Agent: AgentMock,
    }));
    const mod = await import("./fetch.js");
    return { resolveTelegramFetch: mod.resolveTelegramFetch, AgentMock };
  };

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    if (originalFetch) {
      globalThis.fetch = originalFetch;
    } else {
      delete (globalThis as { fetch?: typeof fetch }).fetch;
    }
  });

  it("returns wrapped global fetch when available", async () => {
    const fetchMock = vi.fn(async () => ({}));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const { resolveTelegramFetch } = await loadModule();
    const resolved = resolveTelegramFetch();
    expect(resolved).toBeTypeOf("function");
  });

  it("prefers proxy fetch when provided", async () => {
    const fetchMock = vi.fn(async () => ({}));
    const { resolveTelegramFetch } = await loadModule();
    const resolved = resolveTelegramFetch(fetchMock as unknown as typeof fetch);
    expect(resolved).toBeTypeOf("function");
  });

  it("creates undici Agent with autoSelectFamily disabled when forced via env", async () => {
    // Force autoSelectFamily=false regardless of Node version
    vi.stubEnv("OPENCLAW_TELEGRAM_DISABLE_AUTO_SELECT_FAMILY", "1");
    globalThis.fetch = vi.fn(async () => ({})) as unknown as typeof fetch;
    const { resolveTelegramFetch, AgentMock } = await loadModule();
    resolveTelegramFetch();
    // Agent should be created with autoSelectFamily: false in connect options
    expect(AgentMock).toHaveBeenCalledWith({
      connect: {
        autoSelectFamily: false,
      },
    });
  });

  it("does not create Agent when autoSelectFamily is explicitly enabled", async () => {
    vi.stubEnv("OPENCLAW_TELEGRAM_ENABLE_AUTO_SELECT_FAMILY", "1");
    globalThis.fetch = vi.fn(async () => ({})) as unknown as typeof fetch;
    const { resolveTelegramFetch, AgentMock } = await loadModule();
    resolveTelegramFetch();
    // Agent should not be created when autoSelectFamily is enabled
    expect(AgentMock).not.toHaveBeenCalled();
  });

  it("returns wrapped fetch that passes dispatcher option", async () => {
    // Force autoSelectFamily=false to ensure dispatcher is used
    vi.stubEnv("OPENCLAW_TELEGRAM_DISABLE_AUTO_SELECT_FAMILY", "1");
    const fetchMock = vi.fn(async () => ({ ok: true }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const { resolveTelegramFetch } = await loadModule();
    const resolved = resolveTelegramFetch();
    expect(resolved).toBeTypeOf("function");

    // Call the wrapped fetch
    await resolved!("https://api.telegram.org/test", { method: "GET" });

    // Verify dispatcher was passed
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.telegram.org/test",
      expect.objectContaining({
        method: "GET",
        dispatcher: expect.anything(),
      }),
    );
  });

  it("env disable override forces IPv4-preferred fetch", async () => {
    vi.stubEnv("OPENCLAW_TELEGRAM_DISABLE_AUTO_SELECT_FAMILY", "1");
    globalThis.fetch = vi.fn(async () => ({})) as unknown as typeof fetch;
    const { resolveTelegramFetch, AgentMock } = await loadModule();
    resolveTelegramFetch(undefined, { network: { autoSelectFamily: true } });
    // Env override should force Agent creation even with config saying otherwise
    expect(AgentMock).toHaveBeenCalledWith({
      connect: {
        autoSelectFamily: false,
      },
    });
  });
});
