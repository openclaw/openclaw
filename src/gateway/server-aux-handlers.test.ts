import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";

const secretStoreMocks = vi.hoisted(() => ({ writeEntry: vi.fn() }));

// mock-isolation: reload tests keep secret-store writes in test-owned doubles.
vi.mock("../secrets/store/secret-store.js", () => {
  class SecretStoreValidationError extends Error {}
  return {
    deleteSecretStoreEntry: vi.fn(),
    listSecretStoreEntries: vi.fn(() => []),
    purgeExpiredSecretStoreEntries: vi.fn(() => 0),
    SECRET_STORE_VALUE_MAX_BYTES: 64 * 1024,
    SecretStoreValidationError,
    writeSecretStoreEntry: secretStoreMocks.writeEntry,
  };
});
import { createDeferred } from "../../test/helpers/promise.js";
import {
  getRuntimeAuthProfileStoreSnapshotCore,
  setRuntimeAuthProfileStoreSnapshot,
} from "../agents/auth-profiles/runtime-snapshots.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "../agents/prepared-model-runtime.test-support.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  setActiveCredentialDegradedOwner,
  type DegradedSecretOwner,
} from "../secrets/runtime-degraded-state.js";
import {
  activateSecretsRuntimeSnapshot,
  clearSecretsRuntimeSnapshot,
  getActiveSecretsRuntimeSnapshot,
  type PreparedSecretsRuntimeSnapshot,
} from "../secrets/runtime.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import * as reloadPlans from "./config-reload-plan.js";
import type { GatewayReloadPlan } from "./config-reload.js";
import { createGatewayAuxHandlers } from "./server-aux-handlers.js";
import { createHotTailPlan } from "./server-reload-handlers.config.test-support.js";
import * as modelRuntimeReload from "./server-reload-model-runtime-scope.js";
import {
  registerGatewaySecretCredentialReloadCases,
  type CredentialReloadHarnessOptions,
} from "./server-secrets-reload.test-support.js";
import {
  enforceSharedGatewaySessionGenerationForConfigWrite,
  SharedGatewaySessionGenerationState,
} from "./server-shared-auth-generation.js";
import {
  createTestRuntimeSecretsActivator,
  makePreparedSecretsSnapshot as createSourceSnapshot,
} from "./server-startup-config.test-support.js";

const auxiliaries: ReturnType<typeof createGatewayAuxHandlers>[] = [];
let fixture: OpenClawTestState | undefined;

function publishSharedGatewayGeneration(
  state: SharedGatewaySessionGenerationState,
  generation: string,
) {
  enforceSharedGatewaySessionGenerationForConfigWrite({
    state,
    nextConfig: { gateway: { reload: { mode: "off" } } },
    resolveRuntimeSnapshotGeneration: () => generation,
    clients: [],
  });
}

function asConfig(value: unknown): OpenClawConfig {
  return value as OpenClawConfig;
}

function createReloadPlan(overrides?: Partial<GatewayReloadPlan>): GatewayReloadPlan {
  return createHotTailPlan({
    changedPaths: [],
    hotReasons: [],
    ...overrides,
  });
}

function createSnapshot(config: OpenClawConfig): PreparedSecretsRuntimeSnapshot {
  return createSourceSnapshot(config, { sourceConfig: {} });
}

function slackConfig(signingSecret: string) {
  return asConfig({
    channels: { slack: { signingSecret } },
  });
}

function slackZaloConfig(slackSigningSecret: string, zaloWebhookSecret: string) {
  return asConfig({
    channels: {
      slack: { signingSecret: slackSigningSecret },
      zalo: { webhookSecret: zaloWebhookSecret },
    },
  });
}

function activateSnapshot(config: OpenClawConfig) {
  activateSecretsRuntimeSnapshot(createSnapshot(config));
}

function mockResolvedSecrets(config: OpenClawConfig) {
  return vi.fn().mockResolvedValue(createSnapshot(config));
}

async function invokeRpc(
  params: {
    handlers: ReturnType<typeof createGatewayAuxHandlers>["extraHandlers"];
    respond: ReturnType<typeof vi.fn>;
  },
  method: "secrets.reload" | "secrets.store.set",
  payload = {},
) {
  await params.handlers[method]({
    req: { type: "req", id: method === "secrets.reload" ? "1" : "store-1", method },
    params: payload,
    client: null,
    isWebchatConnect: () => false,
    respond: params.respond as Parameters<
      ReturnType<typeof createGatewayAuxHandlers>["extraHandlers"]["secrets.reload"]
    >[0]["respond"],
    context: {} as never,
  });
}

function expectReloadFailure(respond: ReturnType<typeof vi.fn>) {
  const [ok, payload, error] = firstRespondCall(respond);
  expect([ok, payload, error?.message ?? ""]).toEqual([false, undefined, "secrets.reload failed"]);
}

function generationState(generation = "gen-old") {
  return new SharedGatewaySessionGenerationState({ current: generation, required: generation });
}

function expectGeneration(state: SharedGatewaySessionGenerationState, generation: string) {
  expect({ current: state.current, required: state.required }).toEqual({
    current: generation,
    required: generation,
  });
}

type RespondCall = [boolean, unknown, { message?: string } | undefined];
type GatewayAuxHandlerParams = Parameters<typeof createGatewayAuxHandlers>[0];
type GatewayChannelManager = GatewayAuxHandlerParams["channelManager"];
type ChannelName = Parameters<GatewayChannelManager["startChannel"]>[0];

function firstRespondCall(respond: ReturnType<typeof vi.fn>): RespondCall {
  const call = respond.mock.calls[0];
  if (!call) {
    throw new Error("expected respond call");
  }
  return call as RespondCall;
}

function buildRestartChannelsPlan(...channels: ChannelName[]) {
  return () =>
    createReloadPlan({
      restartChannels: new Set(channels),
    });
}

type SecretsReloadHarnessParams = {
  prepareRuntimeSecretsSnapshot: Parameters<typeof createTestRuntimeSecretsActivator>[0];
  buildReloadPlan?: (changedPaths: string[]) => GatewayReloadPlan;
  sharedGatewaySessionGenerationState?: GatewayAuxHandlerParams["sharedGatewaySessionGenerationState"];
  resolveSharedGatewaySessionGenerationForConfig?: GatewayAuxHandlerParams["resolveSharedGatewaySessionGenerationForConfig"];
  startChannel?: GatewayChannelManager["startChannel"];
  stopChannel?: GatewayChannelManager["stopChannel"];
  isManuallyStopped?: (channel: ChannelName, accountId: string) => boolean;
  resolveRuntimeAccountId?: (channel: ChannelName, accountId: string) => string | undefined;
  getChannelAutostartSuppression?: GatewayAuxHandlerParams["getChannelAutostartSuppression"];
};

function createSecretsReloadHarness(params: SecretsReloadHarnessParams) {
  const { buildReloadPlan = reloadPlans.buildGatewayReloadPlan } = params;
  vi.spyOn(reloadPlans, "buildGatewayReloadPlan").mockImplementation(buildReloadPlan);
  const respond = vi.fn();
  const startChannel = vi
    .fn<GatewayChannelManager["startChannel"]>()
    .mockImplementation(params.startChannel ?? (async () => new Map()));
  const stopChannel = vi
    .fn<GatewayChannelManager["stopChannel"]>()
    .mockImplementation(params.stopChannel ?? (async () => {}));
  const gatewayAux = createGatewayAuxHandlers({
    scheduler: createTestGatewayScheduler(),
    log: {},
    getNativeApprovalRouteCoordinator: () => undefined,
    activateRuntimeSecrets: createTestRuntimeSecretsActivator(params.prepareRuntimeSecretsSnapshot),
    sharedGatewaySessionGenerationState:
      params.sharedGatewaySessionGenerationState ??
      new SharedGatewaySessionGenerationState({
        current: undefined,
        required: null,
      }),
    resolveSharedGatewaySessionGenerationForConfig:
      params.resolveSharedGatewaySessionGenerationForConfig ?? (() => undefined),
    clients: [],
    channelManager: {
      startChannel,
      stopChannel,
      isManuallyStopped: params.isManuallyStopped ?? (() => false),
      resolveRuntimeAccountId:
        params.resolveRuntimeAccountId ?? ((_channel, accountId) => accountId),
    },
    getChannelAutostartSuppression: params.getChannelAutostartSuppression,
    logChannels: { info: vi.fn() },
  });
  auxiliaries.push(gatewayAux);
  const { extraHandlers } = gatewayAux;

  return {
    ...gatewayAux,
    respond,
    startChannel,
    stopChannel,
    reload: () => invokeRpc({ handlers: extraHandlers, respond }, "secrets.reload"),
  };
}

function createRotationHarness(
  previous: OpenClawConfig,
  next: OpenClawConfig,
  params: Omit<SecretsReloadHarnessParams, "prepareRuntimeSecretsSnapshot"> = {},
) {
  activateSnapshot(previous);
  return createSecretsReloadHarness({
    prepareRuntimeSecretsSnapshot: mockResolvedSecrets(next),
    ...params,
  });
}

function createCredentialReloadHarness(options: CredentialReloadHarnessOptions = {}) {
  const ownerAccountId = options.ownerAccountId ?? "ops";
  const owner: DegradedSecretOwner = {
    ownerKind: "account",
    ownerId: `slack:${ownerAccountId}`,
    state: "unavailable",
    paths: ["env.SERVICE_ACCOUNT_FILE"],
    refKeys: [],
    reason: "credential file is unavailable",
  };
  const config = slackConfig("unchanged-secret");
  activateSnapshot(config);
  setActiveCredentialDegradedOwner(owner);
  const startChannel = vi.fn().mockImplementation(async () => {
    if (options.createFailure) {
      throw options.createFailure(owner);
    }
    return new Map();
  });
  const stopChannel = vi.fn().mockResolvedValue(undefined);
  const isManuallyStopped = vi.fn(() => options.manualStop ?? false);
  return {
    ...createSecretsReloadHarness({
      prepareRuntimeSecretsSnapshot: mockResolvedSecrets(config),
      buildReloadPlan: () => createReloadPlan(),
      startChannel,
      stopChannel,
      isManuallyStopped,
      resolveRuntimeAccountId: () => options.runtimeAccountId ?? ownerAccountId,
    }),
    owner,
    startChannel,
    stopChannel,
    isManuallyStopped,
  };
}

// Other helpers leak skip flags at import; isolate channel reloads from worker import order.
beforeEach(async () => {
  if (fixture) {
    throw new Error("Previous auxiliary owner cleanup did not finish");
  }
  fixture = await createOpenClawTestState({ label: "gateway-aux-secrets-reload" });
  // These channel-only snapshots are not model fixtures; the real publication boundary is
  // exercised in server-secrets-reload.model-runtime.test.ts.
  vi.spyOn(modelRuntimeReload, "refreshModelRuntimeAfterHotReload").mockResolvedValue(undefined);
  await resetPreparedModelRuntimeSnapshotsForTest();
  delete process.env.OPENCLAW_SKIP_CHANNELS;
  delete process.env.OPENCLAW_SKIP_PROVIDERS;
  secretStoreMocks.writeEntry.mockReset();
});

afterEach(async () => {
  for (const aux of auxiliaries) {
    await aux.stopOperatorInteractions();
  }
  auxiliaries.length = 0;
  vi.restoreAllMocks();
  await resetPreparedModelRuntimeSnapshotsForTest();
  clearSecretsRuntimeSnapshot();
  await fixture?.cleanup();
  fixture = undefined;
  delete process.env.OPENCLAW_SKIP_CHANNELS;
  delete process.env.OPENCLAW_SKIP_PROVIDERS;
});

describe("gateway aux handlers", () => {
  it.each(["crash-loop safe mode", "channel skip flag"])(
    "refuses reload restarts under %s",
    async (suppression) => {
      if (suppression === "channel skip flag") {
        process.env.OPENCLAW_SKIP_CHANNELS = "1";
      }
      const { reload, respond, startChannel, stopChannel } = createRotationHarness(
        slackConfig("old-slack-secret"),
        slackConfig("new-slack-secret"),
        {
          buildReloadPlan: buildRestartChannelsPlan("slack"),
          getChannelAutostartSuppression: () =>
            suppression === "crash-loop safe mode"
              ? { reason: "crash-loop-breaker", message: "safe mode" }
              : null,
        },
      );

      await reload();

      expect(stopChannel).not.toHaveBeenCalled();
      expect(startChannel).not.toHaveBeenCalled();
      expect(respond).toHaveBeenCalledExactlyOnceWith(false, undefined, {
        code: "UNAVAILABLE",
        message: "secrets.reload failed",
      });
      expect(getActiveSecretsRuntimeSnapshot()?.config).toEqual(slackConfig("old-slack-secret"));
    },
  );

  registerGatewaySecretCredentialReloadCases(createCredentialReloadHarness);

  it("does not restart account targets already covered by a whole-channel target", async () => {
    const { reload, startChannel, stopChannel } = createRotationHarness(
      slackConfig("old-secret"),
      slackConfig("new-secret"),
      {
        buildReloadPlan: () =>
          createReloadPlan({
            restartChannels: new Set(["slack"]),
            restartChannelAccounts: new Map([["slack", new Set(["ops"])]]),
          }),
      },
    );

    await reload();

    expect(stopChannel.mock.calls).toEqual([["slack"]]);
    expect(startChannel.mock.calls).toEqual([["slack", undefined, { reason: "secrets-reload" }]]);
  });

  it("coalesces concurrent secrets.reload calls so channels are not restarted twice", async () => {
    const buildReloadPlan = vi.fn(buildRestartChannelsPlan("slack"));
    activateSnapshot(slackConfig("old-slack-secret"));

    const preparedFirst = createSnapshot(slackConfig("new-slack-secret"));
    const activationOrder: string[] = [];
    const prepareRuntimeSecretsSnapshot = vi.fn().mockImplementationOnce(async () => {
      activationOrder.push("first-start");
      // Let a concurrent caller enter if the handler is not serialized.
      await Promise.resolve();
      await Promise.resolve();
      activationOrder.push("first-end");
      return preparedFirst;
    });
    const { reload, respond, startChannel, stopChannel } = createSecretsReloadHarness({
      prepareRuntimeSecretsSnapshot,
      buildReloadPlan,
    });

    await Promise.all([reload(), reload()]);

    expect(activationOrder).toEqual(["first-start", "first-end"]);
    expect(prepareRuntimeSecretsSnapshot).toHaveBeenCalledTimes(1);
    expect(buildReloadPlan).toHaveBeenCalledExactlyOnceWith(["channels.slack.signingSecret"]);
    expect(stopChannel.mock.calls).toEqual([["slack"]]);
    expect(startChannel.mock.calls).toEqual([["slack", undefined, { reason: "secrets-reload" }]]);
    expect(respond).toHaveBeenNthCalledWith(1, true, { ok: true, warningCount: 0 });
    expect(respond).toHaveBeenNthCalledWith(2, true, { ok: true, warningCount: 0 });
  });

  it("runs a trailing refresh when a referenced store mutation overlaps reload", async () => {
    const sourceConfig = asConfig({
      models: {
        providers: {
          test: {
            apiKey: { source: "store", provider: "default", id: "SERVICE_API_KEY" },
            models: [],
          },
        },
      },
    });
    activateSecretsRuntimeSnapshot(createSourceSnapshot(sourceConfig));
    const { promise: firstBlocked, resolve: releaseFirst } = createDeferred();
    const { promise: firstEntered, resolve: firstStarted } = createDeferred();
    const prepareRuntimeSecretsSnapshot = vi
      .fn()
      .mockImplementationOnce(async () => {
        firstStarted?.();
        await firstBlocked;
        return createSourceSnapshot(sourceConfig);
      })
      .mockResolvedValue(createSourceSnapshot(sourceConfig));
    const { extraHandlers, reload } = createSecretsReloadHarness({ prepareRuntimeSecretsSnapshot });
    const reloadPromise = reload();
    await firstEntered;

    const setRespond = vi.fn();
    const setPromise = invokeRpc(
      { handlers: extraHandlers, respond: setRespond },
      "secrets.store.set",
      {
        name: "SERVICE_API_KEY",
        value: "next-value",
        kind: "secret",
      },
    );
    await vi.waitFor(() => expect(secretStoreMocks.writeEntry).toHaveBeenCalledOnce());
    expect(prepareRuntimeSecretsSnapshot).toHaveBeenCalledTimes(1);
    releaseFirst?.();
    await Promise.all([reloadPromise, setPromise]);

    expect(prepareRuntimeSecretsSnapshot).toHaveBeenCalledTimes(2);
    expect(prepareRuntimeSecretsSnapshot.mock.calls[1]?.[0]).toMatchObject({
      forceColdRefKeys: new Set(["store:default:SERVICE_API_KEY"]),
    });
    expect(setRespond).toHaveBeenCalledWith(true, {
      ok: true,
      reloaded: true,
      warningCount: 0,
    });
  });

  it("retries from the canonical source when it changes during secrets.reload preparation", async () => {
    const initialConfig = slackConfig("initial-secret");
    const canonicalConfig = slackConfig("canonical-secret");
    activateSecretsRuntimeSnapshot(createSourceSnapshot(initialConfig));
    const prepareRuntimeSecretsSnapshot = vi.fn(async ({ config }: { config: OpenClawConfig }) => {
      if (prepareRuntimeSecretsSnapshot.mock.calls.length === 1) {
        activateSecretsRuntimeSnapshot(createSourceSnapshot(canonicalConfig));
      }
      return createSourceSnapshot(config);
    });
    const { reload, respond } = createSecretsReloadHarness({ prepareRuntimeSecretsSnapshot });

    await reload();

    expect(prepareRuntimeSecretsSnapshot.mock.calls.map(([{ config }]) => config)).toEqual([
      initialConfig,
      canonicalConfig,
    ]);
    expect(getActiveSecretsRuntimeSnapshot()?.sourceConfig).toEqual(canonicalConfig);
    expect(firstRespondCall(respond)[0]).toBe(true);
  });

  it("rolls back only exact stopped accounts when a later account restart fails", async () => {
    const authAgentDir = "/tmp/openclaw-secrets-reload-concurrent-oauth";
    const buildReloadPlan = () =>
      createReloadPlan({
        restartChannelAccounts: new Map([
          ["slack", new Set(["ops"])],
          ["zalo", new Set(["alerts"])],
        ]),
      });
    activateSnapshot(slackZaloConfig("old-slack-secret", "old-zalo-secret"));
    const prepareRuntimeSecretsSnapshot = mockResolvedSecrets(
      slackZaloConfig("new-slack-secret", "new-zalo-secret"),
    );
    const stopChannel = vi.fn().mockResolvedValue(undefined);
    const startChannel = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(async () => {
        setRuntimeAuthProfileStoreSnapshot(
          {
            version: 1,
            profiles: {
              "openai:default": {
                type: "oauth",
                provider: "openai",
                access: "access-new",
                refresh: "refresh-new",
                expires: Date.now() + 60_000,
              },
            },
          },
          authAgentDir,
        );
        throw new Error("zalo refused to start");
      })
      .mockResolvedValue(undefined);
    const sharedGatewaySessionGenerationState = generationState();

    const { reload, respond } = createSecretsReloadHarness({
      prepareRuntimeSecretsSnapshot,
      buildReloadPlan,
      sharedGatewaySessionGenerationState,
      resolveSharedGatewaySessionGenerationForConfig: () => "gen-new",
      startChannel,
      stopChannel,
    });

    await reload();

    expect(stopChannel.mock.calls).toEqual([
      ["slack", "ops", { manual: false }],
      ["zalo", "alerts", { manual: false }],
      ["slack", "ops", { manual: false }],
    ]);
    expect(startChannel.mock.calls).toEqual([
      ["slack", "ops", { reason: "secrets-reload", preserveManualStop: true }],
      ["zalo", "alerts", { reason: "secrets-reload", preserveManualStop: true }],
      ["slack", "ops", { reason: "secrets-reload", preserveManualStop: true }],
      ["zalo", "alerts", { reason: "secrets-reload", preserveManualStop: true }],
    ]);
    expect(respond.mock.calls).toHaveLength(1);
    expectReloadFailure(respond);
    expect(getActiveSecretsRuntimeSnapshot()?.config).toEqual(
      slackZaloConfig("old-slack-secret", "old-zalo-secret"),
    );
    expectGeneration(sharedGatewaySessionGenerationState, "gen-old");
    expect(
      getRuntimeAuthProfileStoreSnapshotCore(authAgentDir)?.profiles["openai:default"],
    ).toMatchObject({ access: "access-new", refresh: "refresh-new" });
  });

  it.each(["snapshot and generation", "generation only"] as const)(
    "rolls back failed reload without overwriting newer %s",
    async (superseded) => {
      const snapshotChanged = superseded === "snapshot and generation";
      const snapshot = snapshotChanged ? createSnapshot : createSourceSnapshot;
      const initialConfig = slackConfig("old-slack-secret");
      const concurrentConfig = slackConfig("concurrent-secret");
      activateSecretsRuntimeSnapshot(snapshot(initialConfig));
      const sharedGatewaySessionGenerationState = generationState();
      const startChannel = vi
        .fn()
        .mockImplementationOnce(async () => {
          if (snapshotChanged) {
            activateSecretsRuntimeSnapshot(snapshot(concurrentConfig));
          }
          publishSharedGatewayGeneration(sharedGatewaySessionGenerationState, "gen-concurrent");
          throw new Error("slack refused to start");
        })
        .mockResolvedValue(undefined);
      const { reload, respond, stopChannel } = createSecretsReloadHarness({
        prepareRuntimeSecretsSnapshot: vi.fn(async () => snapshot(slackConfig("reload-secret"))),
        buildReloadPlan: () =>
          snapshotChanged
            ? createReloadPlan({ restartChannelAccounts: new Map([["slack", new Set(["ops"])]]) })
            : buildRestartChannelsPlan("slack")(),
        sharedGatewaySessionGenerationState,
        resolveSharedGatewaySessionGenerationForConfig: () => "gen-reload",
        startChannel,
      });

      await reload();

      expect(firstRespondCall(respond)[0]).toBe(false);
      expect(startChannel).toHaveBeenCalledTimes(2);
      if (snapshotChanged) {
        expect(stopChannel.mock.calls).toEqual([["slack", "ops", { manual: false }]]);
        expect(startChannel.mock.calls).toEqual([
          ["slack", "ops", { reason: "secrets-reload", preserveManualStop: true }],
          ["slack", "ops", { reason: "secrets-reload", preserveManualStop: true }],
        ]);
      }
      expect(getActiveSecretsRuntimeSnapshot()?.config).toEqual(
        snapshotChanged ? concurrentConfig : initialConfig,
      );
      expectGeneration(sharedGatewaySessionGenerationState, "gen-concurrent");
    },
  );

  it("attempts restart on rollback even when stopChannel itself throws mid-reload", async () => {
    // A rejecting stop hook may already have closed the socket.
    const buildReloadPlan = buildRestartChannelsPlan("slack", "zalo");
    activateSnapshot(slackZaloConfig("old-slack-secret", "old-zalo-secret"));
    const prepareRuntimeSecretsSnapshot = mockResolvedSecrets(
      slackZaloConfig("new-slack-secret", "new-zalo-secret"),
    );
    const stopChannel = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("zalo stop hook failed after socket close"));
    const startChannel = vi.fn().mockResolvedValue(new Map());
    const { reload, respond } = createSecretsReloadHarness({
      prepareRuntimeSecretsSnapshot,
      buildReloadPlan,
      startChannel,
      stopChannel,
    });

    await reload();

    expect(startChannel.mock.calls.map(([ch]) => ch)).toEqual(["slack", "slack", "zalo"]);
    expect(respond.mock.calls).toHaveLength(1);
    expect(firstRespondCall(respond)[0]).toBe(false);
  });
});
