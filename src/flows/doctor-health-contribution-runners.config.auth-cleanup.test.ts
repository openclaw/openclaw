import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDoctorConfigSnapshot } from "../commands/doctor-config-snapshot.test-helpers.js";
import type { ConfigMutationResult } from "../config/mutate.js";
import { ConfigMutationConflictError } from "../config/mutation-conflict.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { runWriteConfigHealth } from "./doctor-health-contribution-runners.config.js";
import type { DoctorHealthFlowContext } from "./doctor-health-contribution-types.js";

const mocks = vi.hoisted(() => ({
  removeAuthProfilesAcrossOwnerStores: vi.fn(async () => true),
  replaceConfigFile:
    vi.fn<
      (_params: unknown) => Promise<Pick<ConfigMutationResult<unknown>, "path" | "persistedHash">>
    >(),
}));

vi.mock("../agents/auth-profiles.js", () => ({
  removeAuthProfilesAcrossOwnerStores: mocks.removeAuthProfilesAcrossOwnerStores,
}));

vi.mock("../commands/doctor/shared/config-flow-steps.js", () => ({
  restoreDoctorConfigEnvRefs: (cfg: OpenClawConfig) => cfg,
}));

vi.mock("../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/config.js")>()),
  transformConfigFile: async ({
    transform,
    ...options
  }: Parameters<typeof import("../config/config.js").transformConfigFile>[0]) => {
    const { nextConfig } = await transform(
      {},
      { snapshot: createDoctorConfigSnapshot(), previousHash: null, attempt: 0 },
      {},
    );
    return mocks.replaceConfigFile({ ...options, nextConfig });
  },
}));

vi.mock("../config/logging.js", () => ({
  logConfigUpdated: vi.fn(),
}));

vi.mock("../commands/onboard-helpers.js", () => ({
  applyWizardMetadata: (cfg: OpenClawConfig) => cfg,
}));

function createContext(): DoctorHealthFlowContext {
  const cfg = { gateway: { mode: "local" } } satisfies OpenClawConfig;
  return {
    runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    options: {},
    prompter: {} as DoctorHealthFlowContext["prompter"],
    configResult: {
      cfg,
      confirmedConfigSource: { path: "/tmp/openclaw.json", hash: "planning-revision" },
      retiredAuthProfileCleanupPlans: [
        { agentDir: "/tmp/openclaw/agents/main", profileIds: ["anthropic:claude-cli"] },
      ],
    },
    cfg,
    cfgForPersistence: {},
    sourceConfigValid: true,
    configPath: "/tmp/openclaw.json",
  };
}

describe("Doctor retired auth profile cleanup", () => {
  beforeEach(() => {
    mocks.removeAuthProfilesAcrossOwnerStores.mockClear().mockResolvedValue(true);
    mocks.replaceConfigFile.mockReset().mockResolvedValue({
      path: "/tmp/openclaw.json",
      persistedHash: "committed-revision",
    });
  });

  it("removes retired profiles only after the repaired config commits", async () => {
    await runWriteConfigHealth(createContext());

    expect(mocks.replaceConfigFile).toHaveBeenCalledOnce();
    expect(mocks.removeAuthProfilesAcrossOwnerStores).toHaveBeenCalledWith({
      agentDir: "/tmp/openclaw/agents/main",
      cfg: { gateway: { mode: "local" } },
      profileIds: ["anthropic:claude-cli"],
    });
    expect(mocks.replaceConfigFile.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.removeAuthProfilesAcrossOwnerStores.mock.invocationCallOrder[0]!,
    );
  });

  it("keeps retired profiles when the repaired config write fails", async () => {
    mocks.replaceConfigFile.mockRejectedValueOnce(new Error("write failed"));

    await expect(runWriteConfigHealth(createContext())).rejects.toThrow("write failed");

    expect(mocks.removeAuthProfilesAcrossOwnerStores).not.toHaveBeenCalled();
  });

  it("uses each committed receipt for the next write", async () => {
    const ctx = createContext();
    mocks.replaceConfigFile
      .mockResolvedValueOnce({ path: ctx.configPath, persistedHash: "first-revision" })
      .mockResolvedValueOnce({ path: ctx.configPath, persistedHash: "second-revision" });

    expect(await runWriteConfigHealth(ctx, { runPostWriteRepairs: false })).toBe(true);
    expect(ctx.configResult.confirmedConfigSource).toEqual({
      path: ctx.configPath,
      hash: "first-revision",
    });
    ctx.cfg = { gateway: { mode: "local", port: 19090 } };
    expect(await runWriteConfigHealth(ctx)).toBe(true);

    expect(mocks.replaceConfigFile).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        baseHash: "planning-revision",
        writeOptions: expect.objectContaining({ expectedConfigPath: ctx.configPath }),
      }),
    );
    expect(mocks.replaceConfigFile).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        baseHash: "first-revision",
        writeOptions: expect.objectContaining({ expectedConfigPath: ctx.configPath }),
      }),
    );
    expect(ctx.configResult.confirmedConfigSource).toEqual({
      path: ctx.configPath,
      hash: "second-revision",
    });
    expect(ctx.cfgForPersistence).toEqual(ctx.cfg);
    expect(mocks.removeAuthProfilesAcrossOwnerStores).toHaveBeenCalledOnce();
  });

  it.each(["missing", "null", "conflict"] as const)(
    "keeps cleanup and the saved baseline when the receipt is %s",
    async (failure) => {
      const ctx = createContext();
      if (failure === "missing") {
        delete ctx.configResult.confirmedConfigSource;
      } else if (failure === "null") {
        ctx.configResult.confirmedConfigSource = { path: ctx.configPath, hash: null };
      } else {
        mocks.replaceConfigFile.mockRejectedValueOnce(new ConfigMutationConflictError("changed"));
      }
      const receipt = ctx.configResult.confirmedConfigSource;
      const baseline = ctx.cfgForPersistence;

      expect(await runWriteConfigHealth(ctx)).toBe(false);

      expect(ctx.configWriteRefusal).toBe("config-conflict");
      expect(ctx.configResult.confirmedConfigSource).toBe(receipt);
      expect(ctx.cfgForPersistence).toBe(baseline);
      expect(mocks.replaceConfigFile).toHaveBeenCalledTimes(failure === "conflict" ? 1 : 0);
      expect(mocks.removeAuthProfilesAcrossOwnerStores).not.toHaveBeenCalled();
    },
  );

  it("keeps a successful write with a null receipt but fences the next required write", async () => {
    const ctx = createContext();
    mocks.replaceConfigFile.mockResolvedValueOnce({ path: ctx.configPath, persistedHash: null });
    expect(await runWriteConfigHealth(ctx, { runPostWriteRepairs: false })).toBe(true);
    const baseline = ctx.cfgForPersistence;
    expect(baseline).toEqual(ctx.cfg);
    expect(ctx.configResult.confirmedConfigSource).toEqual({ path: ctx.configPath, hash: null });
    expect(await runWriteConfigHealth(ctx, { runPostWriteRepairs: false })).toBe(true);
    ctx.cfg = { gateway: { mode: "local", port: 19090 } };

    expect(await runWriteConfigHealth(ctx)).toBe(false);

    expect(ctx.configWriteRefusal).toBe("config-conflict");
    expect(ctx.cfgForPersistence).toBe(baseline);
    expect(mocks.replaceConfigFile).toHaveBeenCalledOnce();
    expect(mocks.removeAuthProfilesAcrossOwnerStores).not.toHaveBeenCalled();
  });
});
