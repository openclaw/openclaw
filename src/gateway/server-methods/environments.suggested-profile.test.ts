import { afterEach, beforeEach, expect, it, vi } from "vitest";
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
import { workerService } from "./environments.test-support.js";
import { expectRpcResult } from "./rpc-response.test-support.js";

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
  loadGatewayConfigRedactionHints: () => undefined,
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
function expectDestination(config: OpenClawConfig, ok: boolean) {
  expect(resolveWorkerPlacementDestination({ cfg: config, profileId: "cloud" }).ok).toBe(ok);
}
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

const suggested = {
  id: "cloud",
  profile: {
    provider: "crabbox",
    install: "bundle" as const,
    settings: { provider: "aws" },
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

const profileScenarios: {
  profiles: NonNullable<OpenClawConfig["cloudWorkers"]>["profiles"];
  suggested: boolean;
}[] = [
  { profiles: undefined, suggested: true },
  { profiles: undefined, suggested: false },
  { profiles: { custom: { provider: "static-ssh" } }, suggested: false },
];
it.each(profileScenarios)(
  "lists $profiles with suggestion=$suggested without admitting a destination",
  async ({ profiles, suggested: available }) => {
    storedConfig = { cloudWorkers: { profiles } };
    vi.mocked(resolveSuggestedWorkerProfile).mockResolvedValue(available ? suggested : undefined);
    const { options, respond } = createConfigHandlerHarness({
      method: "environments.list",
      params: { projection: "profiles" },
      contextOverrides: { getRuntimeConfig: () => storedConfig },
    });
    await environmentsHandlers["environments.list"]!(options);
    expectRpcResult(respond, {
      environments: [],
      ...(available ? { suggestedProfile: { id: "cloud", providerId: "crabbox" } } : {}),
    });
    expectDestination(storedConfig, false);
    expect(configWriteMocks.commitGatewayConfigWrite).not.toHaveBeenCalled();
    if (profiles && "custom" in profiles) {
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

it("preserves an existing cloud profile without resolving or writing a suggestion", async () => {
  const existing = { provider: "static-ssh", settings: { host: "example.invalid" } };
  storedConfig = { cloudWorkers: { profiles: { cloud: existing } } };
  vi.mocked(resolveSuggestedWorkerProfile).mockResolvedValue(suggested);
  const { options, respond } = adoptionHarness();
  await environmentsHandlers["environments.adoptSuggestedProfile"]!(options);
  expect(resolveSuggestedWorkerProfile).not.toHaveBeenCalled();
  expect(configWriteMocks.commitGatewayConfigWrite).not.toHaveBeenCalled();
  expect(storedConfig.cloudWorkers?.profiles?.cloud).toBe(existing);
  expectRpcResult(respond, { profile: { id: "cloud", providerId: "static-ssh" } });
});

it("keeps a saved profile unavailable until the restart applies it", async () => {
  storedConfig = { gateway: { reload: { mode: "off" } } };
  let runtimeConfig = structuredClone(storedConfig);
  vi.mocked(resolveSuggestedWorkerProfile).mockResolvedValue(suggested);
  const { options, respond } = adoptionHarness(() => runtimeConfig);

  expectDestination(runtimeConfig, false);
  await environmentsHandlers["environments.adoptSuggestedProfile"]!(options);
  expect(storedConfig.cloudWorkers?.profiles?.cloud).toEqual(suggested.profile);
  expect(storedConfig.gateway).toEqual({ reload: { mode: "off" } });
  expect(scheduleGatewayRestart).toHaveBeenCalledOnce();
  expect(writeRestartSentinel).toHaveBeenCalledWith(
    expect.objectContaining({ stats: expect.objectContaining({ requiresRestart: true }) }),
  );
  expectDestination(runtimeConfig, false);
  const unavailable = [
    false,
    undefined,
    expect.objectContaining({ code: "UNAVAILABLE", message: expect.stringContaining("restart") }),
  ];
  expect(respond.mock.calls).toEqual([unavailable]);

  respond.mockClear();
  await environmentsHandlers["environments.adoptSuggestedProfile"]!(options);
  expect(respond.mock.calls).toEqual([unavailable]);
  expect(configWriteMocks.commitGatewayConfigWrite).toHaveBeenCalledOnce();

  runtimeConfig = structuredClone(storedConfig);
  respond.mockClear();
  await environmentsHandlers["environments.adoptSuggestedProfile"]!(options);
  expect(respond.mock.calls).toEqual([
    [true, { profile: { id: "cloud", providerId: "crabbox" } }, undefined],
  ]);
  expect(resolveWorkerPlacementDestination({ cfg: runtimeConfig, profileId: "cloud" })).toEqual({
    ok: true,
    value: { profileId: "cloud" },
  });
  expect(configWriteMocks.commitGatewayConfigWrite).toHaveBeenCalledOnce();
  expect(scheduleGatewayRestart).toHaveBeenCalledOnce();
});

it.each(["unavailable", "conflict", "revoked"] as const)(
  "refuses profile adoption after %s without overwriting config",
  async (reason) => {
    vi.mocked(resolveSuggestedWorkerProfile).mockImplementation(async () => {
      if (reason === "conflict") {
        storedConfig = { cloudWorkers: { profiles: { custom: { provider: "static-ssh" } } } };
        storedHash = "competing-write";
      }
      return reason === "unavailable" ? undefined : suggested;
    });
    const { options, respond } = adoptionHarness();
    if (reason === "revoked") {
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
    }
    await environmentsHandlers["environments.adoptSuggestedProfile"]!(options);
    expect(storedConfig.cloudWorkers?.profiles).toEqual(
      reason === "conflict" ? { custom: { provider: "static-ssh" } } : undefined,
    );
    if (reason !== "revoked") {
      expect(configWriteMocks.commitGatewayConfigWrite).not.toHaveBeenCalled();
    }
    const error =
      reason === "conflict"
        ? { code: "INVALID_REQUEST" }
        : reason === "revoked"
          ? { message: "Error: Gateway requester authority changed" }
          : { code: "UNAVAILABLE", message: "No cloud worker profile is available to configure" };
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining(error),
      ...(reason === "conflict" ? [undefined] : []),
    );
  },
);
