import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type OwnerDisplaySecretPersistState,
  persistGeneratedOwnerDisplaySecret,
} from "./io.owner-display-secret.js";
import type { OpenClawConfig } from "./types.openclaw.js";

function createState(): OwnerDisplaySecretPersistState {
  return {
    pendingByPath: new Map<string, string>(),
    persistInFlight: new Set<string>(),
    persistWarned: new Set<string>(),
  };
}

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("persistGeneratedOwnerDisplaySecret", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("persists generated owner display secrets once and clears state on success", async () => {
    const state = createState();
    const configPath = "/tmp/openclaw.json";
    const config = {
      commands: {
        ownerDisplay: "hash",
        ownerDisplaySecret: "generated-owner-secret",
      },
    } as OpenClawConfig;
    const persistConfig = vi.fn(async () => undefined);

    const result = persistGeneratedOwnerDisplaySecret({
      config,
      configPath,
      generatedSecret: "generated-owner-secret",
      logger: { warn: vi.fn() },
      state,
      persistConfig,
    });

    expect(result).toBe(config);
    expect(state.pendingByPath.get(configPath)).toBe("generated-owner-secret");
    expect(state.persistInFlight.has(configPath)).toBe(true);
    expect(persistConfig).toHaveBeenCalledTimes(1);
    expect(persistConfig).toHaveBeenCalledWith(config, {
      expectedConfigPath: configPath,
    });

    await flushAsyncWork();

    expect(state.pendingByPath.has(configPath)).toBe(false);
    expect(state.persistInFlight.has(configPath)).toBe(false);
    expect(state.persistWarned.has(configPath)).toBe(false);
  });

  it("warns once and keeps the generated secret pending when persistence fails", async () => {
    const state = createState();
    const configPath = "/tmp/openclaw.json";
    const config = {
      commands: {
        ownerDisplay: "hash",
        ownerDisplaySecret: "generated-owner-secret",
      },
    } as OpenClawConfig;
    const warn = vi.fn();
    const persistConfig = vi.fn(async () => {
      throw new Error("disk full");
    });

    persistGeneratedOwnerDisplaySecret({
      config,
      configPath,
      generatedSecret: "generated-owner-secret",
      logger: { warn },
      state,
      persistConfig,
    });

    await flushAsyncWork();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("Failed to persist auto-generated commands.ownerDisplaySecret"),
    );
    expect(state.pendingByPath.get(configPath)).toBe("generated-owner-secret");
    expect(state.persistInFlight.has(configPath)).toBe(false);
    expect(state.persistWarned.has(configPath)).toBe(true);

    persistGeneratedOwnerDisplaySecret({
      config,
      configPath,
      generatedSecret: "generated-owner-secret",
      logger: { warn },
      state,
      persistConfig,
    });

    await flushAsyncWork();

    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("clears pending state when no generated secret is present", () => {
    const state = createState();
    const configPath = "/tmp/openclaw.json";
    state.pendingByPath.set(configPath, "stale-secret");
    state.persistWarned.add(configPath);
    const config = {
      commands: {
        ownerDisplay: "hash",
        ownerDisplaySecret: "existing-secret",
      },
    } as OpenClawConfig;

    const result = persistGeneratedOwnerDisplaySecret({
      config,
      configPath,
      logger: { warn: vi.fn() },
      state,
      persistConfig: vi.fn(async () => undefined),
    });

    expect(result).toBe(config);
    expect(state.pendingByPath.has(configPath)).toBe(false);
    expect(state.persistWarned.has(configPath)).toBe(false);
  });
});
