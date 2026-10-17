import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfigWriteOptions } from "../../config/io.types.js";
import { ConfigMutationConflictError } from "../../config/mutation-conflict.js";
import { invalidateGatewayRuntimeConfigSchema } from "../../config/runtime-schema.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { writeRestartSentinel } from "../../infra/restart-sentinel.js";
import { scheduleGatewayRestart } from "../../infra/restart.js";
import { resolveSuggestedWorkerProfile } from "../../plugins/worker-profile-suggestions.js";
import { invalidateConfigGetResponseCache } from "../config-get-response.js";
import { authorizeOperatorScopesForMethod } from "../method-scopes.js";
import { resolveWorkerPlacementDestination } from "../worker-environments/placement-destination.js";
import { createConfigHandlerHarness, createConfigWriteSnapshot } from "./config.test-helpers.js";
import { environmentsHandlers } from "./environments.js";
import { adoptSuggestedWorkerProfile } from "./environments.suggested-profile.js";
import { workerService } from "./environments.test-support.js";

const configWriteMocks = vi.hoisted(() => ({
  commitGatewayConfigWrite: vi.fn(),
  readConfigFileSnapshotForWrite: vi.fn(),
}));
vi.mock("../../plugins/worker-profile-suggestions.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/worker-profile-suggestions.js")>()),
  resolveSuggestedWorkerProfile: vi.fn(),
}));
vi.mock("../../config/io.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/io.js")>()),
  readConfigFileSnapshotForWrite: configWriteMocks.readConfigFileSnapshotForWrite,
}));
// Config validation and secret resolution have their own boundary suites.
vi.mock("../../config/validation.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/validation.js")>()),
  validateConfigObjectRawWithPlugins: (config: OpenClawConfig) => ({
    ok: true,
    config,
    warnings: [],
  }),
  validateConfigObjectWithPlugins: (config: OpenClawConfig) => ({ ok: true, config, warnings: [] }),
}));
vi.mock("../../config/runtime-schema.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/runtime-schema.js")>()),
  loadGatewayRuntimeConfigSchema: () => ({
    schema: { type: "object" },
    uiHints: {},
    version: "test",
  }),
}));
vi.mock("../../secrets/runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../secrets/runtime.js")>()),
  prepareSecretsRuntimeSnapshot: async ({ config }: { config: OpenClawConfig }) => ({ config }),
}));
vi.mock("./config-write-flow.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./config-write-flow.js")>()),
  commitGatewayConfigWrite: configWriteMocks.commitGatewayConfigWrite,
}));
vi.mock("../../infra/restart-sentinel.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/restart-sentinel.js")>()),
  writeRestartSentinel: vi.fn(async () => undefined),
}));
vi.mock("../../infra/restart.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/restart.js")>()),
  scheduleGatewayRestart: vi.fn<typeof scheduleGatewayRestart>(() => ({
    ok: true,
    pid: 1,
    signal: "SIGUSR2",
    reason: "config.patch",
    mode: "signal",
    delayMs: 2_000,
    coalesced: false,
    cooldownMsApplied: 0,
    emitHooksQueued: false,
  })),
}));

let storedConfig: OpenClawConfig;
let storedHash: string;
beforeEach(() => {
  storedConfig = {};
  storedHash = "base-hash";
  vi.mocked(resolveSuggestedWorkerProfile).mockReset();
  configWriteMocks.readConfigFileSnapshotForWrite.mockImplementation(async () => {
    const result = createConfigWriteSnapshot(storedConfig);
    result.snapshot.hash = storedHash;
    return result;
  });
  configWriteMocks.commitGatewayConfigWrite.mockImplementation(
    async ({
      snapshot,
      nextConfig,
      writeOptions,
    }: {
      snapshot: { hash?: string };
      nextConfig: OpenClawConfig;
      writeOptions: ConfigWriteOptions;
    }) => {
      writeOptions.assertCurrent?.();
      writeOptions.assertBeforePublish?.();
      if (snapshot.hash !== storedHash) {
        throw new ConfigMutationConflictError("config changed since last load");
      }
      storedConfig = nextConfig;
      storedHash = "next-hash";
      return {
        path: "/tmp/openclaw.json",
        config: storedConfig,
        hash: storedHash,
        queueFollowUp: vi.fn(),
      };
    },
  );
});
afterEach(() => {
  invalidateGatewayRuntimeConfigSchema();
  invalidateConfigGetResponseCache();
  vi.clearAllMocks();
});

describe("suggested cloud profile adoption", () => {
  const suggested = {
    id: "cloud",
    profile: {
      provider: "crabbox",
      install: "bundle" as const,
      suspendAfter: "45m",
      settings: {
        provider: "aws",
        target: "linux",
        class: "standard",
        ttl: "8h",
        idleTimeout: "45m",
        warmImage: true,
      },
    },
  };

  function adoptionHarness(getRuntimeConfig = () => storedConfig) {
    return createConfigHandlerHarness({
      method: "environments.adoptSuggestedProfile",
      contextOverrides: {
        getRuntimeConfig,
        workerEnvironmentService: {
          ...workerService(),
          startTunnel: async () => {
            throw new Error("Unexpected tunnel creation during profile adoption");
          },
          stopTunnel: async () => {},
        },
        workerPlacementDispatchService: {
          dispatch: async () => {
            throw new Error("Unexpected allocation during profile adoption");
          },
        },
      },
    });
  }

  it.each([undefined, {}])(
    "lists a suggestion without admitting a cloud destination (%j)",
    async (profiles) => {
      storedConfig = { cloudWorkers: { profiles } };
      vi.mocked(resolveSuggestedWorkerProfile).mockResolvedValue(suggested);
      const { options, respond } = createConfigHandlerHarness({
        method: "environments.list",
        params: { projection: "profiles" },
        contextOverrides: { getRuntimeConfig: () => storedConfig },
      });
      await environmentsHandlers["environments.list"]!(options);
      expect(respond).toHaveBeenCalledWith(
        true,
        {
          environments: [],
          suggestedProfile: { id: "cloud", providerId: "crabbox" },
        },
        undefined,
      );
      expect(resolveWorkerPlacementDestination({ cfg: storedConfig, profileId: "cloud" }).ok).toBe(
        false,
      );
      expect(configWriteMocks.commitGatewayConfigWrite).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    "omits suggestions with configured profiles or unavailable discovery (%s)",
    async (configured) => {
      if (configured) {
        storedConfig = { cloudWorkers: { profiles: { custom: { provider: "static-ssh" } } } };
      }
      const { options, respond } = createConfigHandlerHarness({
        method: "environments.list",
        params: { projection: "profiles" },
        contextOverrides: { getRuntimeConfig: () => storedConfig },
      });
      await environmentsHandlers["environments.list"]!(options);
      expect(respond).toHaveBeenCalledWith(true, { environments: [] }, undefined);
      if (configured) {
        expect(resolveSuggestedWorkerProfile).not.toHaveBeenCalled();
      }
    },
  );

  it("requires admin authority to adopt a profile", () => {
    expect(
      authorizeOperatorScopesForMethod("environments.adoptSuggestedProfile", ["operator.write"]),
    ).toEqual({
      allowed: false,
      missingScope: "operator.admin",
    });
  });

  it("saves the refreshed suggestion through config.patch before allowing its dispatch", async () => {
    storedConfig = {
      gateway: { projects: { defaultRepository: { url: "https://github.com/acme/app" } } },
    };
    const unrelated = structuredClone(storedConfig.gateway);
    vi.mocked(resolveSuggestedWorkerProfile).mockResolvedValue(suggested);
    expect(resolveWorkerPlacementDestination({ cfg: storedConfig, profileId: "cloud" }).ok).toBe(
      false,
    );
    const { options, respond } = adoptionHarness();
    await adoptSuggestedWorkerProfile(options);
    expect(storedConfig.cloudWorkers?.profiles).toEqual({ cloud: suggested.profile });
    expect(storedConfig.gateway).toEqual(unrelated);
    expect(resolveSuggestedWorkerProfile).toHaveBeenCalledWith({
      config: expect.any(Object),
      refresh: true,
    });
    expect(resolveWorkerPlacementDestination({ cfg: storedConfig, profileId: "cloud" })).toEqual({
      ok: true,
      value: { profileId: "cloud" },
    });
    expect(respond).toHaveBeenCalledWith(
      true,
      { profile: { id: "cloud", providerId: "crabbox" } },
      undefined,
    );
  });

  it("returns an existing cloud profile untouched without discovery or another write", async () => {
    const existing = { provider: "static-ssh", settings: { host: "example.invalid" } };
    storedConfig = { cloudWorkers: { profiles: { cloud: existing } } };
    const { options, respond } = adoptionHarness();
    await adoptSuggestedWorkerProfile(options);
    expect(resolveSuggestedWorkerProfile).not.toHaveBeenCalled();
    expect(configWriteMocks.commitGatewayConfigWrite).not.toHaveBeenCalled();
    expect(storedConfig.cloudWorkers?.profiles?.cloud).toBe(existing);
    expect(respond).toHaveBeenCalledWith(
      true,
      { profile: { id: "cloud", providerId: "static-ssh" } },
      undefined,
    );
  });

  it("keeps a saved profile unavailable until the restart applies it", async () => {
    storedConfig = { gateway: { reload: { mode: "off" } } };
    let runtimeConfig = structuredClone(storedConfig);
    vi.mocked(resolveSuggestedWorkerProfile).mockResolvedValue(suggested);
    const { options, respond } = adoptionHarness(() => runtimeConfig);

    expect(resolveWorkerPlacementDestination({ cfg: runtimeConfig, profileId: "cloud" }).ok).toBe(
      false,
    );
    await adoptSuggestedWorkerProfile(options);
    expect(storedConfig.cloudWorkers?.profiles?.cloud).toEqual(suggested.profile);
    expect(scheduleGatewayRestart).toHaveBeenCalledOnce();
    expect(writeRestartSentinel).toHaveBeenCalledWith(
      expect.objectContaining({ stats: expect.objectContaining({ requiresRestart: true }) }),
    );
    expect(resolveWorkerPlacementDestination({ cfg: runtimeConfig, profileId: "cloud" }).ok).toBe(
      false,
    );
    const unavailable = [
      false,
      undefined,
      expect.objectContaining({ code: "UNAVAILABLE", message: expect.stringContaining("restart") }),
    ];
    expect(respond.mock.calls).toEqual([unavailable]);

    respond.mockClear();
    await adoptSuggestedWorkerProfile(options);
    expect(respond.mock.calls).toEqual([unavailable]);
    expect(configWriteMocks.commitGatewayConfigWrite).toHaveBeenCalledOnce();

    runtimeConfig = structuredClone(storedConfig);
    respond.mockClear();
    await adoptSuggestedWorkerProfile(options);
    expect(respond.mock.calls).toEqual([
      [true, { profile: { id: "cloud", providerId: "crabbox" } }, undefined],
    ]);
    expect(resolveWorkerPlacementDestination({ cfg: runtimeConfig, profileId: "cloud" }).ok).toBe(
      true,
    );
    expect(configWriteMocks.commitGatewayConfigWrite).toHaveBeenCalledOnce();
    expect(scheduleGatewayRestart).toHaveBeenCalledOnce();
  });

  it("does not write when discovery no longer offers a cloud profile", async () => {
    vi.mocked(resolveSuggestedWorkerProfile).mockResolvedValue(undefined);
    const { options, respond } = adoptionHarness();
    await adoptSuggestedWorkerProfile(options);
    expect(configWriteMocks.commitGatewayConfigWrite).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "UNAVAILABLE",
        message: "No cloud worker profile is available to configure",
      }),
    );
  });

  it("preserves a competing config write after discovery", async () => {
    vi.mocked(resolveSuggestedWorkerProfile).mockImplementation(async () => {
      storedConfig = { cloudWorkers: { profiles: { custom: { provider: "static-ssh" } } } };
      storedHash = "competing-write";
      return suggested;
    });
    const { options, respond } = adoptionHarness();
    await adoptSuggestedWorkerProfile(options);
    expect(configWriteMocks.commitGatewayConfigWrite).not.toHaveBeenCalled();
    expect(storedConfig.cloudWorkers?.profiles).toEqual({ custom: { provider: "static-ssh" } });
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
      undefined,
    );
  });

  it("rechecks request authority at the config publication boundary", async () => {
    vi.mocked(resolveSuggestedWorkerProfile).mockResolvedValue(suggested);
    const { options, respond } = adoptionHarness();
    let current = true;
    options.hasCurrentClientAuthority = () => current;
    configWriteMocks.commitGatewayConfigWrite.mockImplementationOnce(
      async ({ writeOptions }: { writeOptions: ConfigWriteOptions }) => {
        current = false;
        writeOptions.assertCurrent?.();
        writeOptions.assertBeforePublish?.();
        throw new Error("revoked request reached config publication");
      },
    );
    await adoptSuggestedWorkerProfile(options);
    expect(storedConfig.cloudWorkers?.profiles).toBeUndefined();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: "Error: Gateway requester authority changed" }),
    );
  });
});
