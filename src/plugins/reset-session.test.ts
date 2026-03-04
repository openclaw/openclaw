import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResetSessionResult } from "../gateway/session-ops.js";
import {
  clearResetSessionCooldownForTesting,
  createPluginRegistry,
  type PluginRecord,
} from "./registry.js";
import type { PluginRuntime } from "./runtime/types.js";

// ---------------------------------------------------------------------------
// Mock resetSessionByKey (the shared helper that registry.ts dynamically imports)
// and the two other dynamic imports registry.ts uses for key resolution.
// ---------------------------------------------------------------------------

const mockResetSessionByKey =
  vi.fn<
    (params: { key: string; reason?: string; commandSource: string }) => Promise<ResetSessionResult>
  >();

const mockResolveSessionStoreKey = vi.fn(({ sessionKey }: { sessionKey: string }) => sessionKey);

const mockLoadConfig = vi.fn().mockReturnValue({
  session: {},
  hooks: { internal: { enabled: false } },
});

vi.mock("../gateway/session-ops.js", () => ({
  resetSessionByKey: (...args: unknown[]) => mockResetSessionByKey(...(args as [never])),
}));

vi.mock("../gateway/session-utils.js", async (importOriginal) => ({
  ...(await importOriginal()),
  resolveSessionStoreKey: (...args: unknown[]) => mockResolveSessionStoreKey(...(args as [never])),
}));

vi.mock("../config/config.js", async (importOriginal) => ({
  ...(await importOriginal()),
  loadConfig: (...args: unknown[]) => mockLoadConfig(...args),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let keyCounter = 0;
function uniqueKey(prefix = "test") {
  return `${prefix}-${++keyCounter}-${randomUUID().slice(0, 8)}`;
}

function makePluginRecord(id = "test-plugin"): PluginRecord {
  return {
    id,
    name: id,
    source: `/tmp/${id}/index.js`,
    origin: "global",
    enabled: true,
    status: "loaded",
    toolNames: [],
    hookNames: [],
    channelIds: [],
    providerIds: [],
    gatewayMethods: [],
    cliCommands: [],
    services: [],
    commands: [],
    httpRoutes: 0,
    hookCount: 0,
    configSchema: false,
  };
}

const dummyLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

const dummyRuntime = {
  version: "test",
} as unknown as PluginRuntime;

function mockSuccessResult(key: string): ResetSessionResult {
  return {
    ok: true,
    key,
    entry: {
      sessionId: randomUUID(),
      updatedAt: Date.now(),
      systemSent: false,
      abortedLastRun: false,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      totalTokensFresh: true,
    },
  };
}

function setupSuccessMock(key: string) {
  mockResetSessionByKey.mockResolvedValue(mockSuccessResult(key));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("api.resetSession", () => {
  let api: ReturnType<ReturnType<typeof createPluginRegistry>["createApi"]>;

  beforeEach(() => {
    vi.clearAllMocks();
    clearResetSessionCooldownForTesting();

    const reg = createPluginRegistry({
      logger: dummyLogger,
      runtime: dummyRuntime,
    });
    const record = makePluginRecord();
    reg.registry.plugins.push(record);
    api = reg.createApi(record, {
      config: { hooks: { internal: { enabled: false } } } as unknown as typeof api.config,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns error for empty key", async () => {
    const result = await api.resetSession("");
    expect(result.ok).toBe(false);
    expect(result.error).toBe("key required");
    expect(result.key).toBe("");
    expect(mockResetSessionByKey).not.toHaveBeenCalled();
  });

  it("returns error for whitespace-only key", async () => {
    const result = await api.resetSession("   ");
    expect(result.ok).toBe(false);
    expect(result.error).toBe("key required");
    expect(mockResetSessionByKey).not.toHaveBeenCalled();
  });

  it("creates a new session ID on successful reset", async () => {
    const key = uniqueKey("new-session");
    setupSuccessMock(key);
    const result = await api.resetSession(key);
    expect(result.ok).toBe(true);
    expect(result.key).toBe(key);
    expect(result.sessionId).toBeDefined();
  });

  it("passes correct commandSource to resetSessionByKey", async () => {
    const key = uniqueKey("source");
    setupSuccessMock(key);
    await api.resetSession(key);

    expect(mockResetSessionByKey).toHaveBeenCalledWith(
      expect.objectContaining({
        commandSource: "plugin:test-plugin",
      }),
    );
  });

  it('passes reason "reset" to resetSessionByKey', async () => {
    const key = uniqueKey("reset-reason");
    setupSuccessMock(key);
    await api.resetSession(key, "reset");

    expect(mockResetSessionByKey).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "reset",
      }),
    );
  });

  it('defaults reason to "new" (undefined) when not specified', async () => {
    const key = uniqueKey("default-reason");
    setupSuccessMock(key);
    await api.resetSession(key);

    expect(mockResetSessionByKey).toHaveBeenCalledWith(
      expect.objectContaining({
        key,
        reason: undefined,
      }),
    );
  });

  it("returns error when resetSessionByKey returns not ok", async () => {
    const key = uniqueKey("not-ok");
    mockResetSessionByKey.mockResolvedValue({
      ok: false,
      key,
      error: "Session is still active; try again in a moment.",
    });

    const result = await api.resetSession(key);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("still active");
  });

  it("cooldown blocks rapid resets on the same key", async () => {
    const key = uniqueKey("cooldown");
    setupSuccessMock(key);

    const result1 = await api.resetSession(key);
    expect(result1.ok).toBe(true);

    const result2 = await api.resetSession(key);
    expect(result2.ok).toBe(false);
    expect(result2.error).toContain("reset cooldown");
    // resetSessionByKey should only have been called once (first call)
    expect(mockResetSessionByKey).toHaveBeenCalledTimes(1);
  });

  it("cooldown allows resets on different keys", async () => {
    const keyA = uniqueKey("cd-a");
    const keyB = uniqueKey("cd-b");

    mockResetSessionByKey.mockResolvedValueOnce(mockSuccessResult(keyA));
    const result1 = await api.resetSession(keyA);
    expect(result1.ok).toBe(true);

    mockResetSessionByKey.mockResolvedValueOnce(mockSuccessResult(keyB));
    const result2 = await api.resetSession(keyB);
    expect(result2.ok).toBe(true);

    expect(mockResetSessionByKey).toHaveBeenCalledTimes(2);
  });

  it("returns error on unexpected exceptions", async () => {
    const key = uniqueKey("error");
    mockResetSessionByKey.mockRejectedValueOnce(new Error("unexpected failure"));

    const result = await api.resetSession(key);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("unexpected failure");
  });

  it("trims key before processing", async () => {
    const key = uniqueKey("trim");
    setupSuccessMock(key);
    await api.resetSession(`  ${key}  `);

    expect(mockResetSessionByKey).toHaveBeenCalledWith(
      expect.objectContaining({
        key,
      }),
    );
  });

  it("returns sessionId from successful result", async () => {
    const key = uniqueKey("session-id");
    const expectedId = randomUUID();
    mockResetSessionByKey.mockResolvedValue({
      ok: true,
      key,
      entry: {
        sessionId: expectedId,
        updatedAt: Date.now(),
        systemSent: false,
        abortedLastRun: false,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        totalTokensFresh: true,
      },
    });

    const result = await api.resetSession(key);
    expect(result.ok).toBe(true);
    expect(result.sessionId).toBe(expectedId);
  });

  it("uses loadConfig for cooldown key resolution", async () => {
    const key = uniqueKey("config");
    setupSuccessMock(key);
    await api.resetSession(key);

    expect(mockLoadConfig).toHaveBeenCalled();
  });

  it("uses canonical key for cooldown tracking", async () => {
    const rawKey = uniqueKey("raw");
    const canonicalKey = `canonical:${rawKey}`;
    mockResolveSessionStoreKey.mockReturnValueOnce(canonicalKey).mockReturnValueOnce(canonicalKey);
    setupSuccessMock(rawKey);

    const result1 = await api.resetSession(rawKey);
    expect(result1.ok).toBe(true);

    // Second call with same raw key should hit cooldown via canonical key
    const result2 = await api.resetSession(rawKey);
    expect(result2.ok).toBe(false);
    expect(result2.error).toContain("reset cooldown");
    expect(result2.key).toBe(canonicalKey);
  });

  it("wraps non-Error exceptions as strings", async () => {
    const key = uniqueKey("non-error");
    mockResetSessionByKey.mockRejectedValueOnce("string error");

    const result = await api.resetSession(key);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("string error");
  });

  it("calls resetSessionByKey with the trimmed key", async () => {
    const key = uniqueKey("trimmed-call");
    setupSuccessMock(key);
    await api.resetSession(`\t${key}\n`);

    expect(mockResetSessionByKey).toHaveBeenCalledWith(expect.objectContaining({ key }));
  });

  it("returns error for non-string key", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- testing runtime guard for untyped callers
    const result = await api.resetSession(42 as any);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("key must be a string");
    expect(mockResetSessionByKey).not.toHaveBeenCalled();
  });
});
