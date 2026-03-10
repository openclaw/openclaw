import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "../../agents/auth-profiles/types.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { RuntimeEnv } from "../../runtime.js";

// ---- hoisted mocks ---------------------------------------------------------

const mocks = vi.hoisted(() => ({
  resolveDefaultAgentId: vi.fn(() => "main"),
  resolveAgentDir: vi.fn((_cfg: unknown, _id: unknown) => "/home/user/.openclaw/agents/main/agent"),
  ensureAuthProfileStore: vi.fn(),
  updateAuthProfileStoreWithLock: vi.fn(),
  loadAgentLocalAuthProfileStore: vi.fn(),
  loadModelsConfig: vi.fn(),
  resolveKnownAgentId: vi.fn(() => null),
}));

vi.mock("../../agents/agent-scope.js", () => ({
  resolveDefaultAgentId: mocks.resolveDefaultAgentId,
  resolveAgentDir: mocks.resolveAgentDir,
}));

vi.mock("../../agents/auth-profiles.js", () => ({
  ensureAuthProfileStore: mocks.ensureAuthProfileStore,
}));

vi.mock("../../agents/auth-profiles/store.js", () => ({
  updateAuthProfileStoreWithLock: mocks.updateAuthProfileStoreWithLock,
  loadAgentLocalAuthProfileStore: mocks.loadAgentLocalAuthProfileStore,
}));

vi.mock("./load-config.js", () => ({
  loadModelsConfig: mocks.loadModelsConfig,
}));

vi.mock("./shared.js", () => ({
  resolveKnownAgentId: mocks.resolveKnownAgentId,
}));

// ---- helpers ----------------------------------------------------------------

const { modelsAuthCleanCommand } = await import("./auth-clean.js");

function makeRuntime(): RuntimeEnv & { logs: string[] } {
  const logs: string[] = [];
  const runtime = {
    logs,
    log: (msg: string) => {
      logs.push(msg);
    },
    error: vi.fn(),
    exit: vi.fn(),
  };
  return runtime as unknown as RuntimeEnv & { logs: string[] };
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

function makeStore(profileIds: string[], extras: Partial<AuthProfileStore> = {}): AuthProfileStore {
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

  return {
    get result() {
      return captured!;
    },
    get returned() {
      return returned;
    },
  };
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

  it("keeps profile referenced only in store.order even when not in cfg", async () => {
    // anthropic:manual is in store.profiles and store.order, but NOT in cfg.
    // The fix ensures store.order-referenced profiles are treated as configured (kept).
    const store = makeStore(["anthropic:me.com", "anthropic:manual"], {
      order: { anthropic: ["anthropic:manual"] },
    });

    mocks.loadModelsConfig.mockResolvedValue(makeCfg(["anthropic:me.com"]));
    mocks.ensureAuthProfileStore.mockReturnValue(store);

    const runtime = makeRuntime();
    await modelsAuthCleanCommand({}, runtime);

    // manual is kept because it's in store.order — no write needed
    expect(mocks.updateAuthProfileStoreWithLock).not.toHaveBeenCalled();
    expect(runtime.logs.join("\n")).toContain("Nothing to clean");
  });

  it("keeps all store.order-referenced profiles alongside cfg-configured ones", async () => {
    // anthropic:manual is in store.order (set via 'models auth order set') but not in cfg.
    // It must be protected, so nothing is stale and the lock is never acquired.
    const store = makeStore(["anthropic:me.com", "anthropic:gmail", "anthropic:manual"], {
      order: { anthropic: ["anthropic:me.com", "anthropic:manual"] },
    });

    mocks.loadModelsConfig.mockResolvedValue(makeCfg(["anthropic:me.com", "anthropic:gmail"]));
    mocks.ensureAuthProfileStore.mockReturnValue(store);

    const runtime = makeRuntime();
    await modelsAuthCleanCommand({}, runtime);

    // All three profiles are kept (me.com/gmail via cfg, manual via store.order)
    expect(mocks.updateAuthProfileStoreWithLock).not.toHaveBeenCalled();
    expect(runtime.logs.join("\n")).toContain("Nothing to clean");
  });

  it("--dry-run does not call updateAuthProfileStoreWithLock", async () => {
    const store = makeStore(["anthropic:me.com", "anthropic:manual"]);

    mocks.loadModelsConfig.mockResolvedValue(makeCfg(["anthropic:me.com"]));
    mocks.ensureAuthProfileStore.mockReturnValue(store);

    await modelsAuthCleanCommand({ dryRun: true }, makeRuntime());

    expect(mocks.updateAuthProfileStoreWithLock).not.toHaveBeenCalled();
  });

  it("--dry-run passes readOnly:true to ensureAuthProfileStore (default agent)", async () => {
    const store = makeStore(["anthropic:me.com", "anthropic:manual"]);

    mocks.loadModelsConfig.mockResolvedValue(makeCfg(["anthropic:me.com"]));
    mocks.ensureAuthProfileStore.mockReturnValue(store);

    await modelsAuthCleanCommand({ dryRun: true }, makeRuntime());

    expect(mocks.ensureAuthProfileStore).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ readOnly: true }),
    );
  });

  it("--dry-run passes readOnly:true to loadAgentLocalAuthProfileStore (non-default agent)", async () => {
    const store = makeStore(["anthropic:me.com"]);

    mocks.loadModelsConfig.mockResolvedValue(makeCfg(["anthropic:me.com"]));
    mocks.resolveKnownAgentId.mockReturnValueOnce("worker");
    mocks.resolveAgentDir.mockReturnValueOnce("/home/user/.openclaw/agents/worker/agent");
    mocks.loadAgentLocalAuthProfileStore.mockReturnValue(store);

    await modelsAuthCleanCommand({ agent: "worker", dryRun: true }, makeRuntime());

    expect(mocks.loadAgentLocalAuthProfileStore).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ readOnly: true }),
    );
    expect(mocks.updateAuthProfileStoreWithLock).not.toHaveBeenCalled();
  });

  it("keeps profiles referenced only in store.order (not in cfg.auth.profiles or cfg.auth.order)", async () => {
    // anthropic:store-override is in store.order (set via 'models auth order set')
    // but NOT in openclaw.json auth.profiles or auth.order — must be treated as kept
    const store = makeStore(["anthropic:me.com", "anthropic:store-override"], {
      order: { anthropic: ["anthropic:me.com", "anthropic:store-override"] },
    });

    mocks.loadModelsConfig.mockResolvedValue(makeCfg(["anthropic:me.com"]));
    mocks.ensureAuthProfileStore.mockReturnValue(store);

    await modelsAuthCleanCommand({}, makeRuntime());

    // Both profiles are kept — no stale entries — lock not acquired
    expect(mocks.updateAuthProfileStoreWithLock).not.toHaveBeenCalled();
  });

  it("removes profiles not in cfg or store.order even when store.order exists", async () => {
    // anthropic:manual is in neither cfg nor store.order — should be removed
    // anthropic:store-override is in store.order — should be kept
    const store = makeStore(["anthropic:me.com", "anthropic:store-override", "anthropic:manual"], {
      order: { anthropic: ["anthropic:me.com", "anthropic:store-override"] },
    });

    mocks.loadModelsConfig.mockResolvedValue(makeCfg(["anthropic:me.com"]));
    mocks.ensureAuthProfileStore.mockReturnValue(store);
    const capture = captureUpdater(store);

    await modelsAuthCleanCommand({}, makeRuntime());

    expect(capture.result.profiles).not.toHaveProperty("anthropic:manual");
    expect(capture.result.profiles).toHaveProperty("anthropic:me.com");
    expect(capture.result.profiles).toHaveProperty("anthropic:store-override");
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
    const plan = JSON.parse(runtime.logs[0]);
    const result = JSON.parse(runtime.logs[1]);

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
    const plan = JSON.parse(runtime.logs[0]);
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

  it("non-default agent: excludes main-only profiles from toRemove", async () => {
    // The agent-local store has agent-profile (configured) and agent-stale (not configured).
    // The merged view returned by ensureAuthProfileStore also includes main-only-profile,
    // which exists only in the main store and is NOT configured.
    // toRemove must contain only agent-stale (from the agent-local store),
    // NOT main-only-profile (which lives in the main store and must not be touched).
    const agentLocalStore = makeStore(["anthropic:agent-profile", "anthropic:agent-stale"]);
    const mergedStore = makeStore([
      "anthropic:agent-profile",
      "anthropic:agent-stale",
      "anthropic:main-only-profile", // exists in main store only, not agent-local
    ]);

    mocks.loadModelsConfig.mockResolvedValue(makeCfg(["anthropic:agent-profile"]));
    // Non-default agent: resolveKnownAgentId returns "worker", default is "main"
    mocks.resolveKnownAgentId.mockReturnValueOnce("worker");
    mocks.resolveAgentDir.mockReturnValueOnce("/home/user/.openclaw/agents/worker/agent");
    // ensureAuthProfileStore is NOT called for non-default agents (loadAgentLocalAuthProfileStore is)
    mocks.loadAgentLocalAuthProfileStore.mockReturnValue(agentLocalStore);
    // The updater receives the merged store (simulating what updateAuthProfileStoreWithLock
    // would pass in production after calling ensureAuthProfileStore internally).
    const capture = captureUpdater(mergedStore);

    const runtime = makeRuntime();
    await modelsAuthCleanCommand({ agent: "worker" }, runtime);

    // toRemove was computed from agentLocalStore only: ["anthropic:agent-stale"]
    expect(capture.result.profiles).not.toHaveProperty("anthropic:agent-stale");
    expect(capture.result.profiles).toHaveProperty("anthropic:agent-profile");
    // main-only-profile was never in toRemove, so the updater left it intact
    expect(capture.result.profiles).toHaveProperty("anthropic:main-only-profile");
    // ensureAuthProfileStore should not have been called for profile-set computation
    expect(mocks.ensureAuthProfileStore).not.toHaveBeenCalled();
  });

  // ---- Fix: agent media profiles without top-level tools.media (P1 #2912273297) ----

  it("collects agent-level media profiles even when cfg.tools.media is absent", async () => {
    // Arrange: no top-level tools.media, but one agent override references a profile.
    // Without the fix, collectMediaProfileIds() returned early on !media and the
    // agent-level profile was treated as stale and added to toRemove.
    const store = makeStore(["anthropic:me.com", "anthropic:media-agent"]);

    mocks.loadModelsConfig.mockResolvedValue({
      ...makeCfg(["anthropic:me.com"]),
      // Deliberately omit tools.media at the top level
      agents: {
        list: [
          {
            id: "worker",
            tools: {
              media: {
                models: [{ model: "gpt-4o", profile: "anthropic:media-agent" }],
              },
            },
          },
        ],
      },
    } as unknown as OpenClawConfig);
    mocks.ensureAuthProfileStore.mockReturnValue(store);

    const runtime = makeRuntime();
    await modelsAuthCleanCommand({}, runtime);

    // anthropic:media-agent is in an agent's tools.media override — must be kept
    expect(mocks.updateAuthProfileStoreWithLock).not.toHaveBeenCalled();
    expect(runtime.logs.join("\n")).toContain("Nothing to clean");
  });

  it("collects agent preferredProfile references without top-level tools.media", async () => {
    // preferredProfile (not just profile) must also be picked up from agent overrides
    const store = makeStore(["anthropic:me.com", "anthropic:preferred-agent"]);

    mocks.loadModelsConfig.mockResolvedValue({
      ...makeCfg(["anthropic:me.com"]),
      agents: {
        list: [
          {
            id: "worker",
            tools: {
              media: {
                image: {
                  models: [{ model: "gpt-4o", preferredProfile: "anthropic:preferred-agent" }],
                },
              },
            },
          },
        ],
      },
    } as unknown as OpenClawConfig);
    mocks.ensureAuthProfileStore.mockReturnValue(store);

    const runtime = makeRuntime();
    await modelsAuthCleanCommand({}, runtime);

    expect(mocks.updateAuthProfileStoreWithLock).not.toHaveBeenCalled();
    expect(runtime.logs.join("\n")).toContain("Nothing to clean");
  });

  // ---- Fix: agentLocalOnly prevents credential scope bleed (Aisle High) ----

  it("non-default agent: passes agentLocalOnly:true to updateAuthProfileStoreWithLock", async () => {
    // Ensures the write path uses agent-local-only loading, preventing main-store
    // profiles from being persisted into the agent-local auth-profiles.json file.
    const agentLocalStore = makeStore(["anthropic:agent-profile", "anthropic:agent-stale"]);

    mocks.loadModelsConfig.mockResolvedValue(makeCfg(["anthropic:agent-profile"]));
    mocks.resolveKnownAgentId.mockReturnValueOnce("worker");
    mocks.resolveAgentDir.mockReturnValueOnce("/home/user/.openclaw/agents/worker/agent");
    mocks.loadAgentLocalAuthProfileStore.mockReturnValue(agentLocalStore);
    captureUpdater(agentLocalStore);

    await modelsAuthCleanCommand({ agent: "worker" }, makeRuntime());

    expect(mocks.updateAuthProfileStoreWithLock).toHaveBeenCalledWith(
      expect.objectContaining({ agentLocalOnly: true }),
    );
  });

  it("default agent: does not set agentLocalOnly on updateAuthProfileStoreWithLock", async () => {
    // Default agent uses the merged store (ensureAuthProfileStore path) — no agentLocalOnly.
    const store = makeStore(["anthropic:me.com", "anthropic:stale"]);

    mocks.loadModelsConfig.mockResolvedValue(makeCfg(["anthropic:me.com"]));
    mocks.ensureAuthProfileStore.mockReturnValue(store);
    captureUpdater(store);

    await modelsAuthCleanCommand({}, makeRuntime());

    const call = mocks.updateAuthProfileStoreWithLock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call?.agentLocalOnly).toBeFalsy();
  });

  // ---- Fix: sanitize ANSI escape codes in profile ID output (Aisle Low) ----

  it("strips ANSI escape sequences from profile IDs in --dry-run output", async () => {
    // A profile ID containing an ANSI color sequence must not reach the terminal raw.
    const maliciousId = "anthropic:\x1b[31mred\x1b[0m";
    const store = makeStore([maliciousId]);

    mocks.loadModelsConfig.mockResolvedValue(makeCfg(["anthropic:safe"]));
    mocks.ensureAuthProfileStore.mockReturnValue(store);

    const runtime = makeRuntime();
    await modelsAuthCleanCommand({ dryRun: true }, runtime);

    const combined = runtime.logs.join("\n");
    // ANSI escape sequences must be stripped
    expect(combined).not.toContain("\x1b[31m");
    expect(combined).not.toContain("\x1b[0m");
    // The non-malicious text should still appear
    expect(combined).toContain("anthropic:");
    expect(combined).toContain("red");
  });

  it("strips newlines from profile IDs in --dry-run output to prevent log forging", async () => {
    // A profile ID "anthropic:legit\nINJECTED LINE" must not produce a separate
    // log entry that starts with "INJECTED LINE" (i.e., must not forge a new line).
    // After sanitization the \n is removed and the injected text is concatenated
    // to the profile ID rather than appearing as a standalone forged log entry.
    const maliciousId = "anthropic:legit\nINJECTED LINE";
    const store = makeStore([maliciousId]);

    mocks.loadModelsConfig.mockResolvedValue(makeCfg(["anthropic:safe"]));
    mocks.ensureAuthProfileStore.mockReturnValue(store);

    const runtime = makeRuntime();
    await modelsAuthCleanCommand({ dryRun: true }, runtime);

    // No log call should start with the injected text (that would mean log forging)
    for (const line of runtime.logs) {
      expect(line).not.toMatch(/^\s*INJECTED LINE/);
    }
    // The sanitized prefix (before the stripped \n) should still appear
    expect(runtime.logs.some((line) => line.includes("anthropic:legit"))).toBe(true);
  });
});
