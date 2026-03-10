import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { AuthProfileStore } from "../../agents/auth-profiles/types.js";
import type { RuntimeEnv } from "../../runtime.js";

// ---- hoisted mocks ---------------------------------------------------------

const mocks = vi.hoisted(() => ({
  resolveDefaultAgentId: vi.fn(() => "main"),
  resolveAgentDir: vi.fn((_cfg: unknown, _id: unknown) => "/home/user/.openclaw/agents/main/agent"),
  ensureAuthProfileStore: vi.fn(),
  updateAuthProfileStoreWithLock: vi.fn(),
  loadModelsConfig: vi.fn(),
}));

vi.mock("../../agents/agent-scope.js", () => ({
  resolveDefaultAgentId: mocks.resolveDefaultAgentId,
  resolveAgentDir: mocks.resolveAgentDir,
}));

vi.mock("../../agents/auth-profiles.js", () => ({
  ensureAuthProfileStore: mocks.ensureAuthProfileStore,
  updateAuthProfileStoreWithLock: mocks.updateAuthProfileStoreWithLock,
}));

vi.mock("./load-config.js", () => ({
  loadModelsConfig: mocks.loadModelsConfig,
}));

vi.mock("./shared.js", () => ({
  resolveKnownAgentId: vi.fn(() => null),
}));

// ---- helpers ----------------------------------------------------------------

const { modelsAuthCleanCommand } = await import("./auth-clean.js");

function makeRuntime(): RuntimeEnv & { logs: string[] } {
  const logs: string[] = [];
  return {
    logs,
    log: vi.fn((msg: string) => logs.push(msg)),
    error: vi.fn(),
    exit: vi.fn(),
  };
}

function makeCfg(
  profileIds: string[] = ["anthropic:me.com", "anthropic:gmail"],
  orderIds: string[] = [],
): OpenClawConfig {
  const profiles: Record<string, { provider: string; mode: string }> = {};
  for (const id of profileIds) {
    const provider = id.split(":")[0] ?? "anthropic";
    profiles[id] = { provider, mode: "token" };
  }
  const order: Record<string, string[]> = {};
  if (orderIds.length > 0) {
    order["anthropic"] = orderIds;
  }
  return { auth: { profiles, ...(orderIds.length > 0 ? { order } : {}) } } as OpenClawConfig;
}

function makeStore(
  profileIds: string[],
  extras: Partial<AuthProfileStore> = {},
): AuthProfileStore {
  const profiles: AuthProfileStore["profiles"] = {};
  for (const id of profileIds) {
    const provider = id.split(":")[0] ?? "anthropic";
    profiles[id] = { type: "token", provider, token: `sk-${id}` };
  }
  return { version: 1, profiles, ...extras };
}

/**
 * Capture what the updater closure does when called with a given store.
 * updateAuthProfileStoreWithLock calls params.updater(freshStore) internally;
 * this helper simulates that so we can inspect mutations.
 */
function captureUpdater(storeSeed: AuthProfileStore): {
  result: AuthProfileStore;
  returned: boolean;
} {
  let captured: AuthProfileStore | undefined;
  let returned = false;

  mocks.updateAuthProfileStoreWithLock.mockImplementationOnce(
    async (params: { updater: (s: AuthProfileStore) => boolean }) => {
      const clone = structuredClone(storeSeed);
      returned = params.updater(clone);
      captured = clone;
      return returned ? clone : null;
    },
  );

  return { get result() { return captured!; }, get returned() { return returned; } };
}

// ---- tests ------------------------------------------------------------------

describe("modelsAuthCleanCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("removes stale profiles from profiles, usageStats, and lastGood", async () => {
    const store = makeStore(["anthropic:me.com", "anthropic:gmail", "anthropic:manual"], {
      usageStats: {
        "anthropic:manual": { lastUsed: 1000, errorCount: 1 },
        "anthropic:me.com": { lastUsed: 2000, errorCount: 0 },
      },
      lastGood: { anthropic: "anthropic:manual" },
    });

    mocks.loadModelsConfig.mockResolvedValue(makeCfg(["anthropic:me.com", "anthropic:gmail"]));
    mocks.ensureAuthProfileStore.mockReturnValue(store);
    const capture = captureUpdater(store);

    const runtime = makeRuntime();
    await modelsAuthCleanCommand({}, runtime);

    expect(capture.result.profiles).not.toHaveProperty("anthropic:manual");
    expect(capture.result.profiles).toHaveProperty("anthropic:me.com");
    expect(capture.result.profiles).toHaveProperty("anthropic:gmail");
    expect(capture.result.usageStats).not.toHaveProperty("anthropic:manual");
    expect(capture.result.usageStats).toHaveProperty("anthropic:me.com");
    expect(capture.result.lastGood).not.toHaveProperty("anthropic");
  });

  it("removes stale ids from order and deletes the key when the array becomes empty", async () => {
    const store = makeStore(["anthropic:me.com", "anthropic:manual"], {
      order: { anthropic: ["anthropic:manual"] },
    });

    mocks.loadModelsConfig.mockResolvedValue(makeCfg(["anthropic:me.com"]));
    mocks.ensureAuthProfileStore.mockReturnValue(store);
    const capture = captureUpdater(store);

    await modelsAuthCleanCommand({}, makeRuntime());

    // order key deleted entirely because filtered list became empty
    expect(capture.result.order).toBeUndefined();
  });

  it("keeps a non-empty order array when only some ids are stale", async () => {
    const store = makeStore(["anthropic:me.com", "anthropic:gmail", "anthropic:manual"], {
      order: { anthropic: ["anthropic:me.com", "anthropic:manual"] },
    });

    mocks.loadModelsConfig.mockResolvedValue(makeCfg(["anthropic:me.com", "anthropic:gmail"]));
    mocks.ensureAuthProfileStore.mockReturnValue(store);
    const capture = captureUpdater(store);

    await modelsAuthCleanCommand({}, makeRuntime());

    expect(capture.result.order?.["anthropic"]).toEqual(["anthropic:me.com"]);
  });

  it("--dry-run does not call updateAuthProfileStoreWithLock", async () => {
    const store = makeStore(["anthropic:me.com", "anthropic:manual"]);

    mocks.loadModelsConfig.mockResolvedValue(makeCfg(["anthropic:me.com"]));
    mocks.ensureAuthProfileStore.mockReturnValue(store);

    await modelsAuthCleanCommand({ dryRun: true }, makeRuntime());

    expect(mocks.updateAuthProfileStoreWithLock).not.toHaveBeenCalled();
  });

  it("--dry-run logs the plan without writing", async () => {
    const store = makeStore(["anthropic:me.com", "anthropic:manual"]);

    mocks.loadModelsConfig.mockResolvedValue(makeCfg(["anthropic:me.com"]));
    mocks.ensureAuthProfileStore.mockReturnValue(store);

    const runtime = makeRuntime();
    await modelsAuthCleanCommand({ dryRun: true }, runtime);

    const combined = runtime.logs.join("\n");
    expect(combined).toContain("anthropic:manual");
    expect(combined).toContain("dry run");
  });

  it("does nothing when all store profiles are configured", async () => {
    const store = makeStore(["anthropic:me.com", "anthropic:gmail"]);

    mocks.loadModelsConfig.mockResolvedValue(makeCfg(["anthropic:me.com", "anthropic:gmail"]));
    mocks.ensureAuthProfileStore.mockReturnValue(store);

    const runtime = makeRuntime();
    await modelsAuthCleanCommand({}, runtime);

    expect(mocks.updateAuthProfileStoreWithLock).not.toHaveBeenCalled();
    expect(runtime.logs.join("\n")).toContain("Nothing to clean");
  });

  it("treats profiles referenced in auth.order as configured (not stale)", async () => {
    // anthropic:legacy is in auth.order but not in auth.profiles — should be preserved
    const store = makeStore(["anthropic:me.com", "anthropic:legacy"]);

    const cfg = makeCfg(["anthropic:me.com"], ["anthropic:me.com", "anthropic:legacy"]);
    mocks.loadModelsConfig.mockResolvedValue(cfg);
    mocks.ensureAuthProfileStore.mockReturnValue(store);

    await modelsAuthCleanCommand({}, makeRuntime());

    // Nothing stale — updateAuthProfileStoreWithLock should not be called
    expect(mocks.updateAuthProfileStoreWithLock).not.toHaveBeenCalled();
  });

  it("throws when openclaw.json has no configured auth and store has profiles", async () => {
    const store = makeStore(["anthropic:me.com"]);

    mocks.loadModelsConfig.mockResolvedValue({ auth: {} } as OpenClawConfig);
    mocks.ensureAuthProfileStore.mockReturnValue(store);

    await expect(modelsAuthCleanCommand({}, makeRuntime())).rejects.toThrow(
      /no configured auth profiles/i,
    );
    expect(mocks.updateAuthProfileStoreWithLock).not.toHaveBeenCalled();
  });

  it("--dry-run with no configured auth logs warning instead of throwing", async () => {
    const store = makeStore(["anthropic:me.com"]);

    mocks.loadModelsConfig.mockResolvedValue({ auth: {} } as OpenClawConfig);
    mocks.ensureAuthProfileStore.mockReturnValue(store);

    const runtime = makeRuntime();
    await modelsAuthCleanCommand({ dryRun: true }, runtime);

    expect(mocks.updateAuthProfileStoreWithLock).not.toHaveBeenCalled();
    expect(runtime.logs.join("\n")).toMatch(/warning/i);
  });

  it("--json emits plan object then {ok, removed} result after write", async () => {
    const store = makeStore(["anthropic:me.com", "anthropic:manual"]);

    mocks.loadModelsConfig.mockResolvedValue(makeCfg(["anthropic:me.com"]));
    mocks.ensureAuthProfileStore.mockReturnValue(store);
    captureUpdater(store);

    const runtime = makeRuntime();
    await modelsAuthCleanCommand({ json: true }, runtime);

    expect(runtime.logs.length).toBe(2);
    const plan = JSON.parse(runtime.logs[0]!);
    const result = JSON.parse(runtime.logs[1]!);

    expect(plan).toMatchObject({ toRemove: ["anthropic:manual"], dryRun: false });
    expect(result).toMatchObject({ ok: true, removed: 1 });
  });

  it("--json --dry-run emits only the plan object", async () => {
    const store = makeStore(["anthropic:me.com", "anthropic:manual"]);

    mocks.loadModelsConfig.mockResolvedValue(makeCfg(["anthropic:me.com"]));
    mocks.ensureAuthProfileStore.mockReturnValue(store);

    const runtime = makeRuntime();
    await modelsAuthCleanCommand({ json: true, dryRun: true }, runtime);

    expect(runtime.logs.length).toBe(1);
    const plan = JSON.parse(runtime.logs[0]!);
    expect(plan).toMatchObject({ toRemove: ["anthropic:manual"], dryRun: true });
    expect(mocks.updateAuthProfileStoreWithLock).not.toHaveBeenCalled();
  });

  it("reports actualRemoved from inside the lock, not the pre-lock estimate", async () => {
    // Simulate gateway concurrently removing anthropic:manual before lock acquired
    const store = makeStore(["anthropic:me.com", "anthropic:manual"]);
    const storeAtLockTime = makeStore(["anthropic:me.com"]); // manual already gone

    mocks.loadModelsConfig.mockResolvedValue(makeCfg(["anthropic:me.com"]));
    mocks.ensureAuthProfileStore.mockReturnValue(store);

    // updater receives the already-cleaned store
    mocks.updateAuthProfileStoreWithLock.mockImplementationOnce(
      async (params: { updater: (s: AuthProfileStore) => boolean }) => {
        const clone = structuredClone(storeAtLockTime);
        params.updater(clone);
        return clone; // something returned = success
      },
    );

    const runtime = makeRuntime();
    await modelsAuthCleanCommand({}, runtime);

    // actualRemoved should be 0 (nothing was there to delete under the lock)
    expect(runtime.logs.join("\n")).toContain("Removed 0 stale profile(s)");
  });

  it("throws when updateAuthProfileStoreWithLock returns null (lock busy)", async () => {
    const store = makeStore(["anthropic:me.com", "anthropic:manual"]);

    mocks.loadModelsConfig.mockResolvedValue(makeCfg(["anthropic:me.com"]));
    mocks.ensureAuthProfileStore.mockReturnValue(store);
    mocks.updateAuthProfileStoreWithLock.mockResolvedValueOnce(null);

    await expect(modelsAuthCleanCommand({}, makeRuntime())).rejects.toThrow(/lock busy/i);
  });
});
