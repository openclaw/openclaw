import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createInfoWarnErrorLogger as mockLogSecretsForTest } from "../../test/helpers/mock-logger.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { loadAuthProfileStoreWithoutExternalProfilesAsync } from "../agents/auth-profiles.js";
import { createAuthProfileStoreFixture } from "../agents/auth-profiles/credential-fixtures.test-support.js";
import {
  getRuntimeAuthProfileStoreCredentialsRevision,
  getRuntimeAuthProfileStoreSnapshotCore,
  prepareRuntimeAuthProfileStoreSnapshots,
  setRuntimeAuthProfileStoreSnapshot,
} from "../agents/auth-profiles/runtime-snapshots.js";
import { writePersistedAuthProfileStoreRaw } from "../agents/auth-profiles/sqlite.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../config/types.js";
import {
  flushDiagnosticsTimeline,
  measureDiagnosticsTimelineSpan,
} from "../infra/diagnostics-timeline.js";
import { refResolutionError } from "../secrets/resolve-errors.js";
import { associateSecretResolutionErrorOwners } from "../secrets/runtime-degraded-state.js";
import {
  activateProviderAuthRuntimeSnapshot,
  activateSecretsRuntimeSnapshotState,
  activateSecretsRuntimeSnapshotStateIfCurrent,
  clearSecretsRuntimeSnapshotState,
  getActiveSecretsRuntimeSnapshotState,
  getActiveSecretsRuntimeSnapshotRevisionState,
} from "../secrets/runtime-state.js";
import type { PreparedSecretsRuntimeSnapshot } from "../secrets/runtime.js";
import { captureEnv, withEnvAsync } from "../test-utils/env.js";
import { prepareGatewayStartupConfig } from "./server-startup-config-helpers.js";
import { createRuntimeSecretsActivator } from "./server-startup-config.js";
import { makePreparedSecretsSnapshot as preparedSnapshot } from "./server-startup-config.test-support.js";
import { buildTestConfigSnapshot } from "./test-helpers.config-snapshots.js";

type PrepareRuntimeSecretsSnapshotForTest =
  typeof import("../secrets/runtime.js").prepareSecretsRuntimeSnapshot;
type ActivateRuntimeSecretsSnapshotForTest =
  typeof import("../secrets/runtime.js").activateSecretsRuntimeSnapshot;

type GatewayStartupSecretsRuntimeMock = {
  runtimeImport: () => void;
  loadAuthStore?: typeof loadAuthProfileStoreWithoutExternalProfilesAsync;
  prepareRuntimeSecretsSnapshot: PrepareRuntimeSecretsSnapshotForTest;
  activateRuntimeSecretsSnapshot: ActivateRuntimeSecretsSnapshotForTest;
};

type GatewayStartupLogMock = ReturnType<typeof mockLogSecretsForTest>;

type GatewayStartupStateEmitterMock = ReturnType<
  typeof vi.fn<(code: string, message: string, cfg: OpenClawConfig) => void>
>;

const DEGRADED = "SECRETS_RELOADER_DEGRADED";
const RECOVERED = "SECRETS_RELOADER_RECOVERED";
const RELOAD = { reason: "reload", activate: true } as const;
const DEFERRED_RELOAD = { ...RELOAD, deferStatePublication: true } as const;
const PREFLIGHT_RELOAD = {
  reason: "reload",
  activate: false,
  publishFailureAsDegraded: true,
} as const;
const RESOLVED_GATEWAY_TOKEN = "resolved-gateway-token";
const autoCleanupTempDirs = useAutoCleanupTempDirTracker(afterEach);

type SecretOwner = NonNullable<PreparedSecretsRuntimeSnapshot["degradedOwners"]>[number];

function providerOwner(overrides: Partial<SecretOwner> = {}): SecretOwner {
  return {
    ownerKind: "provider",
    ownerId: "openai",
    state: "unavailable",
    degradationState: "stale",
    paths: ["models.providers.openai.apiKey"],
    refKeys: ["env:default:OPENAI_API_KEY"],
    reason: "secret reference was not found",
    ...overrides,
  };
}

function associateFailure(
  error: Error,
  owner: SecretOwner,
  source: "config" | "auth-store" = "config",
) {
  associateSecretResolutionErrorOwners(error, [
    {
      ...owner,
      degradationState: owner.degradationState ?? "cold",
      failureMatched: true,
      source,
    },
  ]);
}

function activateSecretsRuntimeSnapshotForTest(snapshot: PreparedSecretsRuntimeSnapshot): void {
  activateSecretsRuntimeSnapshotState({
    snapshot,
    refreshContext: null,
    refreshHandler: null,
  });
}

function publishProvider(
  snapshot: PreparedSecretsRuntimeSnapshot,
  preserveActivationLineage = false,
) {
  const expectedRevision = getActiveSecretsRuntimeSnapshotRevisionState();
  return activateProviderAuthRuntimeSnapshot({
    snapshot,
    expectedRevision,
    activateSnapshotIfCurrent: () =>
      activateSecretsRuntimeSnapshotStateIfCurrent({
        snapshot,
        expectedRevision,
        refreshContext: null,
        refreshHandler: null,
        preserveActivationLineage,
      }),
  });
}

async function activateDeferred(
  activator: ReturnType<typeof createRuntimeSecretsActivator>,
  snapshot: PreparedSecretsRuntimeSnapshot,
) {
  await expect(
    activator.activatePreparedSnapshotIfCurrent(
      snapshot,
      getActiveSecretsRuntimeSnapshotRevisionState(),
      DEFERRED_RELOAD,
    ),
  ).resolves.toBe(snapshot);
}

function providerConfig(refId?: string): OpenClawConfig {
  return gatewayTokenConfig({
    models: {
      providers: {
        openai: {
          apiKey: refId ? { source: "env", provider: "default", id: refId } : "fixture",
          models: [],
          baseUrl: "https://api.openai.com/v1",
        },
      },
    },
  });
}

function gatewayTokenConfig(config: OpenClawConfig): OpenClawConfig {
  return {
    ...config,
    gateway: {
      ...config.gateway,
      auth: {
        ...config.gateway?.auth,
        mode: config.gateway?.auth?.mode ?? "token",
        token: config.gateway?.auth?.token ?? "startup-test-token",
      },
    },
  };
}

function asConfig(value: unknown): OpenClawConfig {
  return value as OpenClawConfig;
}

function buildSnapshot(config: OpenClawConfig): ConfigFileSnapshot {
  const raw = `${JSON.stringify(config, null, 2)}\n`;
  return buildTestConfigSnapshot({
    path: "/tmp/openclaw-startup-secrets-test.json",
    exists: true,
    raw,
    parsed: config,
    valid: true,
    config,
    issues: [],
    legacyIssues: [],
  });
}

function preparedSnapshotWithGatewayToken(
  config: OpenClawConfig,
  token = RESOLVED_GATEWAY_TOKEN,
): PreparedSecretsRuntimeSnapshot {
  return {
    ...preparedSnapshot(config),
    config: {
      ...config,
      gateway: {
        ...config.gateway,
        auth: {
          ...config.gateway?.auth,
          token,
        },
      },
    },
  };
}

function gatewaySecretRefSnapshot(): ConfigFileSnapshot {
  return buildSnapshot({
    secrets: {
      providers: {
        default: { source: "env" },
      },
    },
    gateway: {
      auth: {
        mode: "token",
        token: { source: "env", provider: "default", id: "GATEWAY_TOKEN_REF" },
      },
    },
  });
}

function runtimeSecretsActivatorForTest(params: {
  prepareRuntimeSecretsSnapshot?: PrepareRuntimeSecretsSnapshotForTest;
  activateRuntimeSecretsSnapshot?: ActivateRuntimeSecretsSnapshotForTest;
  emitStateEvent?: GatewayStartupStateEmitterMock;
  logSecrets?: GatewayStartupLogMock;
}) {
  const defaultActivatorOptions = runtimeSecretsActivatorOptionsForTest();
  return createRuntimeSecretsActivator({
    logSecrets: params.logSecrets ?? defaultActivatorOptions.logSecrets,
    emitStateEvent: params.emitStateEvent ?? defaultActivatorOptions.emitStateEvent,
    prepareRuntimeSecretsSnapshot:
      params.prepareRuntimeSecretsSnapshot ??
      vi.fn<PrepareRuntimeSecretsSnapshotForTest>(async ({ config }) => preparedSnapshot(config)),
    activateRuntimeSecretsSnapshot: params.activateRuntimeSecretsSnapshot ?? vi.fn(),
  });
}

function runtimeSecretsActivatorOptionsForTest() {
  return {
    logSecrets: mockLogSecretsForTest(),
    emitStateEvent: vi.fn<(code: string, message: string, cfg: OpenClawConfig) => void>(),
  };
}

function readTimelineEvents(filePath: string): Array<Record<string, unknown>> {
  flushDiagnosticsTimeline();
  return readFileSync(filePath, "utf8")
    .trim()
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function installDiagnosticsTimelineEnv() {
  const root = autoCleanupTempDirs.make("openclaw-startup-secrets-timeline-");
  const timelinePath = path.join(root, "timeline.jsonl");
  const env = captureEnv(["OPENCLAW_DIAGNOSTICS", "OPENCLAW_DIAGNOSTICS_TIMELINE_PATH"]);
  process.env.OPENCLAW_DIAGNOSTICS = "timeline";
  process.env.OPENCLAW_DIAGNOSTICS_TIMELINE_PATH = timelinePath;
  return {
    timelinePath,
    cleanup: () => {
      flushDiagnosticsTimeline();
      env.restore();
    },
  };
}

/** Isolate discovery so ambient auth stores cannot force the slow path. */
function installIsolatedStartupFastPathEnv() {
  const root = autoCleanupTempDirs.make("openclaw-startup-fast-path-env-");
  const env = captureEnv([
    "OPENCLAW_HOME",
    "OPENCLAW_STATE_DIR",
    "OPENCLAW_CONFIG_PATH",
    "OPENCLAW_OAUTH_DIR",
  ]);
  process.env.OPENCLAW_HOME = path.join(root, "home");
  process.env.OPENCLAW_STATE_DIR = path.join(root, "state");
  process.env.OPENCLAW_CONFIG_PATH = path.join(root, "state", "openclaw.json");
  process.env.OPENCLAW_OAUTH_DIR = path.join(root, "credentials");
  return { cleanup: () => env.restore() };
}

function installGatewayStartupSecretsRuntimeMock(state: GatewayStartupSecretsRuntimeMock) {
  (
    globalThis as typeof globalThis & {
      __gatewayStartupSecretsRuntimeMock?: typeof state;
    }
  )["__gatewayStartupSecretsRuntimeMock"] = state;
  vi.doMock("../agents/auth-profiles.js", () => ({
    loadAuthProfileStoreWithoutExternalProfilesAsync:
      state.loadAuthStore ?? vi.fn(() => createAuthProfileStoreFixture({})),
  }));
  vi.doMock("../secrets/runtime.js", () => {
    const runtimeState = (
      globalThis as typeof globalThis & {
        __gatewayStartupSecretsRuntimeMock?: typeof state;
      }
    )["__gatewayStartupSecretsRuntimeMock"];
    if (!runtimeState) {
      throw new Error("missing gateway startup secrets runtime mock");
    }
    runtimeState.runtimeImport();
    return {
      prepareSecretsRuntimeSnapshot: runtimeState.prepareRuntimeSecretsSnapshot,
      activateSecretsRuntimeSnapshot: runtimeState.activateRuntimeSecretsSnapshot,
      preflightActiveSecretsRuntimeSnapshotRefresh: async ({
        sourceConfig,
      }: {
        sourceConfig: OpenClawConfig;
      }) => await runtimeState.prepareRuntimeSecretsSnapshot({ config: sourceConfig }),
      refreshActiveSecretsRuntimeSnapshotForConfig: async ({
        sourceConfig,
        preflightResult,
      }: {
        sourceConfig: OpenClawConfig;
        preflightResult?: unknown;
      }) => {
        const snapshot =
          preflightResult && typeof preflightResult === "object"
            ? (preflightResult as PreparedSecretsRuntimeSnapshot)
            : await runtimeState.prepareRuntimeSecretsSnapshot({ config: sourceConfig });
        runtimeState.activateRuntimeSecretsSnapshot(snapshot);
        return true;
      },
    };
  });
}

function cleanupGatewayStartupSecretsRuntimeMock(): void {
  vi.doUnmock("../agents/auth-profiles.js");
  vi.doUnmock("../secrets/runtime.js");
  delete (
    globalThis as typeof globalThis & {
      __gatewayStartupSecretsRuntimeMock?: unknown;
    }
  )["__gatewayStartupSecretsRuntimeMock"];
}

async function activateImportedStartupConfig(config: OpenClawConfig, env?: NodeJS.ProcessEnv) {
  const { createRuntimeSecretsActivator: createActivator } =
    await import("./server-startup-config.js");
  return await createActivator(runtimeSecretsActivatorOptionsForTest())(
    gatewayTokenConfig(config),
    {
      reason: "startup",
      activate: true,
      env,
    },
  );
}

describe("gateway startup config secret preflight", () => {
  const channelEnv = captureEnv(["OPENCLAW_SKIP_CHANNELS", "OPENCLAW_SKIP_PROVIDERS"]);
  afterEach(() => {
    clearSecretsRuntimeSnapshotState();
    channelEnv.restore();
  });

  it.each([true, false])(
    "keeps reload recovery scoped to the remaining owners (provider failed first: %s)",
    async (providerFirst) => {
      const config = providerConfig();
      const providerDegraded = {
        ...preparedSnapshot(config),
        degradedOwners: [providerOwner({ reason: "secret provider failed" })],
      };
      const failure = new Error("gateway secret unavailable");
      associateFailure(
        failure,
        providerOwner({
          ownerKind: "gateway",
          ownerId: "ingress-auth",
          paths: ["gateway.auth.token"],
          refKeys: ["env:default:GATEWAY_TOKEN"],
          degradationState: "cold",
        }),
      );
      const emitStateEvent = vi.fn();
      const activateRuntimeSecrets = runtimeSecretsActivatorForTest({
        emitStateEvent,
        prepareRuntimeSecretsSnapshot: vi
          .fn<PrepareRuntimeSecretsSnapshotForTest>()
          .mockRejectedValueOnce(failure)
          .mockResolvedValueOnce(providerDegraded),
        activateRuntimeSecretsSnapshot: activateSecretsRuntimeSnapshotForTest,
      });
      activateSecretsRuntimeSnapshotForTest(preparedSnapshot(config));
      if (providerFirst) {
        await expect(publishProvider(providerDegraded)).resolves.toBe(true);
      }
      await expect(activateRuntimeSecrets(config, PREFLIGHT_RELOAD)).rejects.toThrow(
        failure.message,
      );
      if (!providerFirst) {
        await activateRuntimeSecrets(config, RELOAD);
      }
      await expect(publishProvider(preparedSnapshot(config))).resolves.toBe(true);
      expect(emitStateEvent.mock.calls.map((call) => call[0])).toEqual(
        providerFirst ? [DEGRADED] : [DEGRADED, RECOVERED],
      );
      if (!providerFirst) {
        expect(emitStateEvent).toHaveBeenLastCalledWith(
          RECOVERED,
          "Secret resolution recovered.",
          config,
        );
      }
    },
  );

  it("publishes prepared degradation only after the reload transaction commits", async () => {
    const initial = preparedSnapshot(gatewayTokenConfig({}));
    const degradedSnapshot = (token: string): PreparedSecretsRuntimeSnapshot => ({
      ...preparedSnapshotWithGatewayToken(initial.sourceConfig, token),
      warnings: [
        {
          code: "SECRETS_OWNER_UNAVAILABLE",
          path: "models.providers.openai.apiKey",
          message: "Secret owner provider:openai is using last-known-good.",
        },
      ],
      degradedOwners: [providerOwner()],
    });
    const rolledBackCandidate = degradedSnapshot("rolled-back-token");
    const committedCandidate = degradedSnapshot("committed-token");
    const emitStateEvent = vi.fn();
    const logSecrets = mockLogSecretsForTest();
    const activateRuntimeSecrets = runtimeSecretsActivatorForTest({
      activateRuntimeSecretsSnapshot: activateSecretsRuntimeSnapshotForTest,
      emitStateEvent,
      logSecrets,
    });
    activateSecretsRuntimeSnapshotForTest(initial);

    await activateDeferred(activateRuntimeSecrets, rolledBackCandidate);
    expect(emitStateEvent).not.toHaveBeenCalled();
    expect(logSecrets.warn).not.toHaveBeenCalled();

    activateSecretsRuntimeSnapshotForTest(initial);
    await activateDeferred(activateRuntimeSecrets, committedCandidate);
    expect(emitStateEvent).not.toHaveBeenCalled();
    expect(logSecrets.warn).not.toHaveBeenCalled();

    activateRuntimeSecrets.publishStateTransition(rolledBackCandidate);
    expect(emitStateEvent).not.toHaveBeenCalled();
    expect(logSecrets.warn).not.toHaveBeenCalled();

    activateRuntimeSecrets.publishStateTransition(committedCandidate);
    expect(emitStateEvent).toHaveBeenCalledOnce();
    expect(emitStateEvent).toHaveBeenCalledWith(
      DEGRADED,
      "Secret resolution degraded one or more owners; healthy owners were refreshed.",
      committedCandidate.config,
    );
    expect(logSecrets.warn).toHaveBeenCalledTimes(2);
    expect(logSecrets.warn).toHaveBeenCalledWith(
      "[SECRETS_OWNER_UNAVAILABLE] Secret owner provider:openai is using last-known-good.",
    );
    expect(logSecrets.warn).toHaveBeenCalledWith(
      expect.stringContaining("[SECRETS_DEGRADED] stale provider:openai"),
      expect.objectContaining({ event: "secrets.degraded", state: "stale" }),
    );
  });

  it("publishes deferred degradation after a provider-auth descendant activation", async () => {
    const config = providerConfig();
    const initial = preparedSnapshot(config);
    const degraded = {
      ...preparedSnapshot(initial.sourceConfig),
      degradedOwners: [
        providerOwner({
          ownerKind: "capability",
          ownerId: "tts",
          degradationState: "cold",
          paths: ["tts.providers.elevenlabs.apiKey"],
          refKeys: ["env:default:ELEVENLABS_API_KEY"],
        }),
      ],
    };
    const emitStateEvent = vi.fn();
    const activateRuntimeSecrets = runtimeSecretsActivatorForTest({
      emitStateEvent,
      activateRuntimeSecretsSnapshot: activateSecretsRuntimeSnapshotForTest,
    });
    activateSecretsRuntimeSnapshotForTest(initial);
    await activateDeferred(activateRuntimeSecrets, degraded);
    const descendant: PreparedSecretsRuntimeSnapshot = structuredClone(degraded);
    descendant.degradedOwners?.push(providerOwner());

    await expect(publishProvider(descendant, true)).resolves.toBe(true);
    expect(emitStateEvent).not.toHaveBeenCalled();

    activateRuntimeSecrets.publishStateTransition(degraded);
    expect(emitStateEvent.mock.calls.map((call) => call[0])).toEqual([DEGRADED]);
  });

  it("recovers prior full degradation when a deferred degraded snapshot is healed", async () => {
    const config = providerConfig();
    const initial = preparedSnapshot(config);
    const fullDegraded = {
      ...preparedSnapshot(config),
      degradedOwners: [
        providerOwner({
          ownerKind: "capability",
          ownerId: "tts",
          degradationState: "cold",
          paths: ["tts.providers.elevenlabs.apiKey"],
          refKeys: ["env:default:ELEVENLABS_API_KEY"],
        }),
      ],
    };
    const providerDegraded = {
      ...preparedSnapshot(config),
      degradedOwners: [providerOwner()],
    };
    const emitStateEvent = vi.fn();
    const activateRuntimeSecrets = runtimeSecretsActivatorForTest({
      emitStateEvent,
      activateRuntimeSecretsSnapshot: activateSecretsRuntimeSnapshotForTest,
    });
    activateSecretsRuntimeSnapshotForTest(initial);
    await activateRuntimeSecrets.activatePreparedSnapshot(fullDegraded, RELOAD);
    await activateDeferred(activateRuntimeSecrets, providerDegraded);
    const recovered = preparedSnapshot(config);

    await expect(publishProvider(recovered, true)).resolves.toBe(true);
    expect(emitStateEvent.mock.calls.map((call) => call[0])).toEqual([DEGRADED]);

    activateRuntimeSecrets.publishStateTransition(providerDegraded);
    expect(emitStateEvent.mock.calls.map((call) => call[0])).toEqual([DEGRADED, RECOVERED]);
  });

  it("publishes source-only recovery after a provider-auth descendant activation", async () => {
    const stableConfig = providerConfig("OPENAI_STABLE");
    const failedConfig = structuredClone(stableConfig);
    failedConfig.models!.providers!.openai!.apiKey = {
      source: "env",
      provider: "default",
      id: "OPENAI_CHANGED",
    };
    const failure = new Error("provider secret unavailable");
    associateFailure(
      failure,
      providerOwner({
        refKeys: ["env:default:OPENAI_CHANGED"],
        degradationState: "cold",
      }),
    );
    const emitStateEvent = vi.fn();
    const activateRuntimeSecrets = runtimeSecretsActivatorForTest({
      emitStateEvent,
      prepareRuntimeSecretsSnapshot: vi.fn(async () => {
        throw failure;
      }),
      activateRuntimeSecretsSnapshot: activateSecretsRuntimeSnapshotForTest,
    });
    const initial = preparedSnapshot(stableConfig);
    activateSecretsRuntimeSnapshotForTest(initial);
    await expect(activateRuntimeSecrets(failedConfig, PREFLIGHT_RELOAD)).rejects.toBe(failure);

    const sourceOnly = preparedSnapshot(stableConfig);
    activateSecretsRuntimeSnapshotForTest(sourceOnly);
    const committedRevision = getActiveSecretsRuntimeSnapshotRevisionState();
    const descendant = structuredClone(sourceOnly);
    expect(
      activateSecretsRuntimeSnapshotStateIfCurrent({
        snapshot: descendant,
        expectedRevision: committedRevision,
        refreshContext: null,
        refreshHandler: null,
        preserveActivationLineage: true,
      }),
    ).toBe(true);

    activateRuntimeSecrets.publishStateTransition(sourceOnly, {
      sourceOnly: true,
      expectedRevision: committedRevision,
    });
    expect(emitStateEvent.mock.calls.map((call) => call[0])).toEqual([DEGRADED, RECOVERED]);
  });

  it.each(["same source", "secrets changed", "credentials changed", "admission closed"] as const)(
    "settles source observation inside the activation lock before publication (%s)",
    async (scenario) => {
      const initial = preparedSnapshot(gatewayTokenConfig({}));
      const candidate = preparedSnapshotWithGatewayToken(initial.sourceConfig, "candidate-token");
      const later = preparedSnapshotWithGatewayToken(initial.sourceConfig, "later-token");
      const activator = runtimeSecretsActivatorForTest({
        activateRuntimeSecretsSnapshot: activateSecretsRuntimeSnapshotForTest,
      });
      const activate = activator.activatePreparedSnapshotIfCurrent;
      activateSecretsRuntimeSnapshotForTest(initial);
      const holding = createDeferred();
      const unlock = createDeferred();
      const readEntered = createDeferred();
      const finishRead = createDeferred();
      const first = activate(
        initial,
        getActiveSecretsRuntimeSnapshotRevisionState(),
        RELOAD,
        async () => {
          holding.resolve();
          await unlock.promise;
        },
      );
      let pending:
        | Promise<{ value?: PreparedSecretsRuntimeSnapshot | null; error?: unknown }>
        | undefined;
      const publish = vi.fn();
      let readStarted = false;
      const agentDir = autoCleanupTempDirs.make("openclaw-lock-auth-");
      let sourceCurrent = false;
      let admissionCurrent = true;
      try {
        await holding.promise;
        pending = activate(
          candidate,
          getActiveSecretsRuntimeSnapshotRevisionState(),
          RELOAD,
          publish,
          () => sourceCurrent && admissionCurrent,
          async () => {
            readStarted = true;
            readEntered.resolve();
            await finishRead.promise;
            sourceCurrent = true;
          },
        ).then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
        await Promise.resolve();
        expect(readStarted).toBe(false);
        unlock.resolve();
        await readEntered.promise;
        expect(publish).not.toHaveBeenCalled();
        expect(getActiveSecretsRuntimeSnapshotState()?.config).toEqual(initial.config);
        if (scenario === "secrets changed") {
          activateSecretsRuntimeSnapshotForTest(later);
        }
        if (scenario === "credentials changed") {
          setRuntimeAuthProfileStoreSnapshot(
            createAuthProfileStoreFixture({
              "openai:observation-test": {
                type: "api_key",
                provider: "openai",
                key: "synthetic-new-key",
              },
            }),
            agentDir,
          );
        }
        if (scenario === "admission closed") {
          admissionCurrent = false;
        }
        finishRead.resolve();
        const result = await pending;
        expect(result).toMatchObject({ value: scenario === "same source" ? candidate : null });
        expect(publish).toHaveBeenCalledTimes(scenario === "same source" ? 1 : 0);
        if (scenario === "credentials changed") {
          expect(
            getRuntimeAuthProfileStoreSnapshotCore(agentDir)?.profiles["openai:observation-test"],
          ).toMatchObject({ key: "synthetic-new-key" });
        }
        expect(getActiveSecretsRuntimeSnapshotState()?.config).toEqual(
          (scenario === "same source"
            ? candidate
            : scenario === "secrets changed"
              ? later
              : initial
          ).config,
        );
      } finally {
        unlock.resolve();
        finishRead.resolve();
        await Promise.all([first, pending]);
      }
    },
  );

  it("omits secret preparation error messages from diagnostics timeline spans", async () => {
    const timelineEnv = installDiagnosticsTimelineEnv();
    try {
      const failure = new Error(
        'Secret provider "default" is not configured for GATEWAY_TOKEN_REF.',
      );
      const prepareRuntimeSecretsSnapshot = vi.fn(async () => {
        throw failure;
      });

      const activateRuntimeSecrets = runtimeSecretsActivatorForTest({
        prepareRuntimeSecretsSnapshot,
      });

      await expect(
        prepareGatewayStartupConfig({
          configSnapshot: gatewaySecretRefSnapshot(),
          activateRuntimeSecrets,
          measure: (name, run, options) =>
            measureDiagnosticsTimelineSpan(name, run, {
              env: process.env,
              omitErrorMessage: options?.omitErrorMessage,
              phase: "startup",
            }),
        }),
      ).rejects.toMatchObject({
        message: expect.stringContaining(failure.message),
        cause: failure,
      });

      const events = readTimelineEvents(timelineEnv.timelinePath);
      expect(events.find((event) => event.name === "secrets.prepare")?.attributes).toEqual({
        activate: false,
        gatewayAuthSecretRef: true,
        reason: "startup",
      });
      const errorEvents = events.filter((event) => event.type === "span.error");
      expect(errorEvents.map((event) => event.name)).toEqual([
        "secrets.prepare",
        "config.auth.secret-preflight",
      ]);
      for (const event of errorEvents) {
        expect(event.phase).toBe("startup");
        expect(event.errorName).toBe("Error");
        expect(event.errorMessage).toBeUndefined();
      }
      expect(JSON.stringify(events)).not.toContain("GATEWAY_TOKEN_REF");
      expect(JSON.stringify(events)).not.toContain("default");
    } finally {
      timelineEnv.cleanup();
    }
  });

  it("wraps startup secret activation failures without emitting reload state events", async () => {
    const error = refResolutionError({
      code: "SECRET_REF_NOT_FOUND",
      source: "env",
      provider: "default",
      refId: "PRIVATE_STARTUP_AUTH_REF",
      message: 'Environment variable "PRIVATE_STARTUP_AUTH_REF" is missing or empty.',
    });
    associateFailure(
      error,
      providerOwner({
        ownerKind: "gateway",
        ownerId: "auth",
        paths: ["gateway.auth.token"],
        refKeys: ["env:default:PRIVATE_STARTUP_AUTH_REF"],
        degradationState: "cold",
      }),
    );
    const prepareRuntimeSecretsSnapshot = vi.fn(async () => {
      throw error;
    });
    const emitStateEvent = vi.fn();
    const logSecrets = mockLogSecretsForTest();
    const activateRuntimeSecrets = runtimeSecretsActivatorForTest({
      emitStateEvent,
      logSecrets,
      prepareRuntimeSecretsSnapshot,
    });

    const startupFailure = await activateRuntimeSecrets(gatewayTokenConfig({}), {
      reason: "startup",
      activate: false,
    }).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(startupFailure).toBeInstanceOf(Error);
    expect(String(startupFailure)).toBe("Error: Startup failed: required secrets are unavailable.");
    expect((startupFailure as Error).cause).toBeUndefined();
    expect(String(startupFailure)).not.toContain("PRIVATE_STARTUP_AUTH_REF");
    expect(logSecrets.warn).toHaveBeenCalledWith(
      "[SECRETS_DEGRADED] cold gateway:auth: secret reference was not found. " +
        "Retry: openclaw secrets reload.",
      {
        event: "secrets.degraded",
        ownerKind: "gateway",
        ownerId: "auth",
        reason: "secret reference was not found",
        state: "cold",
        retryHint: "openclaw secrets reload",
      },
    );
    expect(JSON.stringify(logSecrets.warn.mock.calls)).not.toContain("PRIVATE_STARTUP_AUTH_REF");
    expect(emitStateEvent).not.toHaveBeenCalled();
  });

  it("publishes one provider outage diagnostic with its affected owner list", async () => {
    const sourceConfig: OpenClawConfig = {};
    const providerFailures = [{ source: "exec" as const, provider: "vault" }];
    const prepared = {
      ...preparedSnapshot(sourceConfig),
      warnings: [
        {
          code: "SECRETS_OWNER_UNAVAILABLE" as const,
          path: "models.providers.openai.apiKey",
          message: "Secret owner provider:openai is configured-unavailable.",
        },
        {
          code: "SECRETS_OWNER_UNAVAILABLE" as const,
          path: "tts.providers.elevenlabs.apiKey",
          message: "Secret owner capability:tts is configured-unavailable.",
        },
      ],
      degradedOwners: [
        providerOwner({
          degradationState: "cold",
          refKeys: ["exec:vault:models/openai"],
          reason: "secret provider failed",
          providerFailures,
        }),
        providerOwner({
          ownerKind: "capability",
          ownerId: "tts",
          paths: ["tts.providers.elevenlabs.apiKey"],
          refKeys: ["exec:vault:tts/elevenlabs"],
          reason: "secret provider failed",
          providerFailures,
        }),
      ],
    };
    const logSecrets = mockLogSecretsForTest();
    const activateRuntimeSecrets = runtimeSecretsActivatorForTest({
      logSecrets,
      prepareRuntimeSecretsSnapshot: vi.fn(async () => prepared),
    });

    await activateRuntimeSecrets(sourceConfig, { reason: "startup", activate: true });

    expect(logSecrets.warn).toHaveBeenCalledOnce();
    expect(logSecrets.warn).toHaveBeenCalledWith(
      "[SECRETS_PROVIDER_DEGRADED] exec:vault: secret provider failed. " +
        "Affected owners: stale capability:tts, cold provider:openai. " +
        "Retry: openclaw secrets reload.",
      {
        event: "secrets.provider_degraded",
        source: "exec",
        provider: "vault",
        reason: "secret provider failed",
        affectedOwners: [
          { ownerKind: "capability", ownerId: "tts", state: "stale" },
          { ownerKind: "provider", ownerId: "openai", state: "cold" },
        ],
        retryHint: "openclaw secrets reload",
      },
    );
  });

  it.each(["reload"] as const)(
    "rejects invalid resolved values without publishing degradation during %s",
    async (reason) => {
      activateSecretsRuntimeSnapshotForTest(preparedSnapshot(gatewayTokenConfig({})));
      const invalidSecretError = new Error(
        "tts.providers.elevenlabs.apiKey resolved to a non-string or empty value.",
      );
      associateFailure(
        invalidSecretError,
        providerOwner({
          ownerKind: "capability",
          ownerId: "tts",
          paths: ["tts.providers.elevenlabs.apiKey"],
          refKeys: ["file:ttsfile:/private/value"],
          reason: "resolved secret value was invalid",
        }),
      );
      const prepareRuntimeSecretsSnapshot = vi.fn(async () => {
        throw invalidSecretError;
      });
      const emitStateEvent = vi.fn();
      const logSecrets = mockLogSecretsForTest();
      const activateRuntimeSecrets = runtimeSecretsActivatorForTest({
        prepareRuntimeSecretsSnapshot,
        emitStateEvent,
        logSecrets,
      });

      await expect(
        activateRuntimeSecrets(gatewayTokenConfig({}), {
          reason,
          activate: false,
          publishFailureAsDegraded: true,
        }),
      ).rejects.toThrow(invalidSecretError.message);

      expect(logSecrets.warn).not.toHaveBeenCalled();
      expect(emitStateEvent).not.toHaveBeenCalled();
    },
  );

  it("does not publish typed degradation after reload ownership expires", async () => {
    activateSecretsRuntimeSnapshotForTest(preparedSnapshot(gatewayTokenConfig({})));
    const failure = refResolutionError({
      code: "SECRET_REF_NOT_FOUND",
      source: "env",
      provider: "default",
      refId: "EXPIRED_RELOAD_REF",
      message: "expired reload fixture",
    });
    associateFailure(
      failure,
      providerOwner({
        ownerKind: "capability",
        ownerId: "tts",
        paths: ["tts.providers.elevenlabs.apiKey"],
        refKeys: ["env:default:EXPIRED_RELOAD_REF"],
      }),
    );
    const emitStateEvent = vi.fn();
    const logSecrets = mockLogSecretsForTest();
    const activateRuntimeSecrets = runtimeSecretsActivatorForTest({
      prepareRuntimeSecretsSnapshot: vi.fn(async () => {
        throw failure;
      }),
      emitStateEvent,
      logSecrets,
    });

    await expect(
      activateRuntimeSecrets(gatewayTokenConfig({}), {
        reason: "reload",
        activate: false,
        publishFailureAsDegraded: true,
        canPublishFailureAsDegraded: () => false,
      }),
    ).rejects.toThrow(failure.message);

    expect(logSecrets.warn).not.toHaveBeenCalled();
    expect(emitStateEvent).not.toHaveBeenCalled();
  });

  it("publishes a redacted unknown-owner warning for an unmapped typed reload failure", async () => {
    activateSecretsRuntimeSnapshotForTest(preparedSnapshot(gatewayTokenConfig({})));
    const missingSecretError = refResolutionError({
      code: "SECRET_REF_NOT_FOUND",
      source: "env",
      provider: "default",
      refId: "PRIVATE_UNMAPPED_REF",
      message: 'Environment variable "PRIVATE_UNMAPPED_REF" is missing or empty.',
    });
    const prepareRuntimeSecretsSnapshot = vi.fn(async () => {
      throw missingSecretError;
    });
    const emitStateEvent = vi.fn();
    const logSecrets = mockLogSecretsForTest();
    const activateRuntimeSecrets = runtimeSecretsActivatorForTest({
      prepareRuntimeSecretsSnapshot,
      emitStateEvent,
      logSecrets,
    });

    await expect(activateRuntimeSecrets(gatewayTokenConfig({}), PREFLIGHT_RELOAD)).rejects.toThrow(
      missingSecretError.message,
    );

    expect(logSecrets.warn).toHaveBeenCalledWith(
      "[SECRETS_DEGRADED] cold unknown:unmapped: secret reference was not found. " +
        "Retry: openclaw secrets reload.",
      {
        event: "secrets.degraded",
        ownerKind: "unknown",
        ownerId: "unmapped",
        reason: "secret reference was not found",
        state: "cold",
        retryHint: "openclaw secrets reload",
      },
    );
    expect(JSON.stringify(logSecrets.warn.mock.calls)).not.toContain("PRIVATE_UNMAPPED_REF");
    expect(emitStateEvent).toHaveBeenCalledWith(
      DEGRADED,
      "Secret resolution failed; runtime remains on the last-known-good snapshot.",
      expect.anything(),
    );
  });

  it("does not enable cold-start degradation while a runtime snapshot is active", async () => {
    activateSecretsRuntimeSnapshotForTest(preparedSnapshot(gatewayTokenConfig({})));
    const missingSecretError = new Error(
      'Environment variable "ELEVENLABS_API_KEY" is missing or empty.',
    );
    const prepareRuntimeSecretsSnapshot = vi.fn(async () => {
      throw missingSecretError;
    });
    const activateRuntimeSecretsSnapshot = vi.fn();
    const activateRuntimeSecrets = runtimeSecretsActivatorForTest({
      prepareRuntimeSecretsSnapshot,
      activateRuntimeSecretsSnapshot,
    });

    await expect(
      activateRuntimeSecrets(gatewayTokenConfig({}), {
        reason: "startup",
        activate: false,
      }),
    ).rejects.toThrow("Startup failed: required secrets are unavailable.");

    expect(prepareRuntimeSecretsSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ allowUnavailableSecretOwners: false }),
    );
    expect(activateRuntimeSecretsSnapshot).not.toHaveBeenCalled();
  });

  it("emits one-shot degraded and recovered events during secret reload transitions", async () => {
    const missingSecretError = new Error(
      'Environment variable "OPENAI_API_KEY" is missing or empty.',
    );
    let shouldResolve = false;
    const sourceConfig = providerConfig("OPENAI_API_KEY");
    const activeSnapshot = preparedSnapshot(sourceConfig);
    activeSnapshot.config.models!.providers!.openai!.apiKey = "test-api-key";
    activateSecretsRuntimeSnapshotForTest(activeSnapshot);
    associateFailure(missingSecretError, providerOwner());
    const prepareRuntimeSecretsSnapshot = vi.fn(async ({ config }) => {
      if (!shouldResolve) {
        throw missingSecretError;
      }
      return preparedSnapshot(config);
    });
    const emitStateEvent = vi.fn();
    const logSecrets = mockLogSecretsForTest();
    const activateRuntimeSecrets = runtimeSecretsActivatorForTest({
      logSecrets,
      emitStateEvent,
      prepareRuntimeSecretsSnapshot,
      activateRuntimeSecretsSnapshot: activateSecretsRuntimeSnapshotForTest,
    });

    await expect(activateRuntimeSecrets(sourceConfig, PREFLIGHT_RELOAD)).rejects.toThrow(
      missingSecretError.message,
    );
    await expect(activateRuntimeSecrets(sourceConfig, PREFLIGHT_RELOAD)).rejects.toThrow(
      missingSecretError.message,
    );
    shouldResolve = true;
    const activeRevision = getActiveSecretsRuntimeSnapshotRevisionState();
    const prepared = await activateRuntimeSecrets(sourceConfig, {
      reason: "restart-check",
      activate: false,
    });
    expect(emitStateEvent).toHaveBeenCalledTimes(1);

    await expect(
      activateRuntimeSecrets.activatePreparedSnapshotIfCurrent(prepared, activeRevision, RELOAD),
    ).resolves.toMatchObject({ config: sourceConfig });
    expect(emitStateEvent.mock.calls.map((call) => call[0])).toEqual([DEGRADED, RECOVERED]);
    expect(emitStateEvent.mock.calls[0]?.[1]).toBe(
      "Secret resolution failed; runtime remains on the last-known-good snapshot.",
    );
    expect(logSecrets.error).not.toHaveBeenCalled();
    expect(logSecrets.warn).toHaveBeenCalledTimes(2);
    expect(logSecrets.warn).toHaveBeenCalledWith(
      "[SECRETS_DEGRADED] stale provider:openai: secret reference was not found. " +
        "Retry: openclaw secrets reload.",
      {
        event: "secrets.degraded",
        ownerKind: "provider",
        ownerId: "openai",
        reason: "secret reference was not found",
        state: "stale",
        retryHint: "openclaw secrets reload",
      },
    );
    expect(JSON.stringify(logSecrets.warn.mock.calls)).not.toContain("OPENAI_API_KEY");
    expect(logSecrets.info).toHaveBeenCalledWith(
      "[SECRETS_RELOADER_RECOVERED] Secret resolution recovered.",
    );

    shouldResolve = false;
    await expect(activateRuntimeSecrets(sourceConfig, PREFLIGHT_RELOAD)).rejects.toThrow(
      missingSecretError.message,
    );
    shouldResolve = true;
    const sourceOnlyRevision = getActiveSecretsRuntimeSnapshotRevisionState();
    const sourceOnly = await activateRuntimeSecrets(sourceConfig, PREFLIGHT_RELOAD);
    await expect(
      activateRuntimeSecrets.activatePreparedSnapshotIfCurrent(
        sourceOnly,
        sourceOnlyRevision,
        DEFERRED_RELOAD,
      ),
    ).resolves.toMatchObject({ config: sourceConfig });
    expect(emitStateEvent.mock.calls.map((call) => call[0])).toEqual([
      DEGRADED,
      RECOVERED,
      DEGRADED,
    ]);
    shouldResolve = false;
    await expect(activateRuntimeSecrets(sourceConfig, PREFLIGHT_RELOAD)).rejects.toThrow(
      missingSecretError.message,
    );
    activateRuntimeSecrets.publishStateTransition(sourceOnly);
    expect(emitStateEvent.mock.calls.map((call) => call[0])).toEqual([
      DEGRADED,
      RECOVERED,
      DEGRADED,
    ]);
    shouldResolve = true;
    const newerRevision = getActiveSecretsRuntimeSnapshotRevisionState();
    const newerPrepared = await activateRuntimeSecrets(sourceConfig, {
      reason: "reload",
      activate: false,
    });
    await expect(
      activateRuntimeSecrets.activatePreparedSnapshotIfCurrent(
        newerPrepared,
        newerRevision,
        RELOAD,
      ),
    ).resolves.toMatchObject({ config: sourceConfig });
    expect(emitStateEvent.mock.calls.map((call) => call[0])).toEqual([
      DEGRADED,
      RECOVERED,
      DEGRADED,
      RECOVERED,
    ]);

    const changedSourceConfig: OpenClawConfig = structuredClone(sourceConfig);
    changedSourceConfig.models!.providers!.openai!.apiKey = {
      source: "env",
      provider: "default",
      id: "OPENAI_API_KEY_NEXT",
    };
    associateFailure(
      missingSecretError,
      providerOwner({
        refKeys: ["env:default:OPENAI_API_KEY_NEXT"],
        degradationState: "cold",
      }),
    );
    shouldResolve = false;
    await expect(activateRuntimeSecrets(changedSourceConfig, PREFLIGHT_RELOAD)).rejects.toThrow(
      missingSecretError.message,
    );
    const revertedSnapshot = getActiveSecretsRuntimeSnapshotState()!;
    const revertedRevision = getActiveSecretsRuntimeSnapshotRevisionState();
    await expect(
      activateRuntimeSecrets.activatePreparedSnapshotIfCurrent(
        revertedSnapshot,
        revertedRevision,
        DEFERRED_RELOAD,
      ),
    ).resolves.toMatchObject({ sourceConfig });
    activateRuntimeSecrets.publishStateTransition(revertedSnapshot, {
      sourceOnly: true,
    });
    expect(emitStateEvent.mock.calls.map((call) => call[0]).slice(-2)).toEqual([
      DEGRADED,
      RECOVERED,
    ]);
  });

  it("does not recover auth-store degradation from a config-only source reversion", async () => {
    const stableConfig = providerConfig("OPENAI_STABLE");
    const changedConfig = structuredClone(stableConfig);
    changedConfig.models!.providers!.openai!.apiKey = {
      source: "env",
      provider: "default",
      id: "OPENAI_CHANGED",
    };
    const configFailure = new Error("config secret failed");
    associateFailure(
      configFailure,
      providerOwner({
        refKeys: ["env:default:OPENAI_CHANGED"],
        degradationState: "cold",
      }),
    );
    const authStoreFailure = new Error("auth store secret failed");
    associateFailure(
      authStoreFailure,
      providerOwner({
        ownerKind: "account",
        ownerId: "auth-profile-owner",
        paths: ["/tmp/agent.auth-profiles.openai:default.key"],
        refKeys: ["env:default:AUTH_PROFILE_KEY"],
      }),
      "auth-store",
    );
    const emitStateEvent = vi.fn();
    let nextFailure = configFailure;
    const activateRuntimeSecrets = runtimeSecretsActivatorForTest({
      emitStateEvent,
      prepareRuntimeSecretsSnapshot: vi.fn(async () => {
        throw nextFailure;
      }),
      activateRuntimeSecretsSnapshot: activateSecretsRuntimeSnapshotForTest,
    });
    activateSecretsRuntimeSnapshotForTest(preparedSnapshot(stableConfig));

    await expect(activateRuntimeSecrets(changedConfig, PREFLIGHT_RELOAD)).rejects.toBe(
      configFailure,
    );
    nextFailure = authStoreFailure;
    await expect(activateRuntimeSecrets(changedConfig, PREFLIGHT_RELOAD)).rejects.toBe(
      authStoreFailure,
    );

    const revertedSnapshot = preparedSnapshot(stableConfig);
    await activateDeferred(activateRuntimeSecrets, revertedSnapshot);
    activateRuntimeSecrets.publishStateTransition(revertedSnapshot, {
      sourceOnly: true,
    });
    expect(emitStateEvent.mock.calls.map((call) => call[0])).toEqual([DEGRADED]);

    const fullyResolvedSnapshot = preparedSnapshot(stableConfig);
    await activateDeferred(activateRuntimeSecrets, fullyResolvedSnapshot);
    activateRuntimeSecrets.publishStateTransition(fullyResolvedSnapshot);
    expect(emitStateEvent.mock.calls.map((call) => call[0])).toEqual([DEGRADED, RECOVERED]);

    nextFailure = authStoreFailure;
    await expect(activateRuntimeSecrets(changedConfig, PREFLIGHT_RELOAD)).rejects.toBe(
      authStoreFailure,
    );
    nextFailure = configFailure;
    await expect(activateRuntimeSecrets(changedConfig, PREFLIGHT_RELOAD)).rejects.toBe(
      configFailure,
    );

    const secondRevertedSnapshot = preparedSnapshot(stableConfig);
    await activateDeferred(activateRuntimeSecrets, secondRevertedSnapshot);
    activateRuntimeSecrets.publishStateTransition(secondRevertedSnapshot, {
      sourceOnly: true,
    });
    expect(emitStateEvent.mock.calls.map((call) => call[0])).toEqual([
      DEGRADED,
      RECOVERED,
      DEGRADED,
    ]);
  });

  it("rejects a known weak gateway token resolved during secret activation", async () => {
    const sourceConfig = gatewayTokenConfig(gatewaySecretRefSnapshot().config);
    const prepareRuntimeSecretsSnapshot = vi.fn(async () =>
      preparedSnapshotWithGatewayToken(sourceConfig, "change-me-to-a-long-random-token"),
    );
    const activateRuntimeSecretsSnapshot = vi.fn();
    const activateRuntimeSecrets = runtimeSecretsActivatorForTest({
      prepareRuntimeSecretsSnapshot,
      activateRuntimeSecretsSnapshot,
    });

    await expect(activateRuntimeSecrets(sourceConfig, RELOAD)).rejects.toThrow(
      /published example placeholder/,
    );
    expect(activateRuntimeSecretsSnapshot).not.toHaveBeenCalled();
  });

  it("prunes channel refs from startup secret preflight when channels are skipped", async () => {
    process.env.OPENCLAW_SKIP_CHANNELS = "1";
    const prepareRuntimeSecretsSnapshot = vi.fn<PrepareRuntimeSecretsSnapshotForTest>(
      async ({ config }) => preparedSnapshot(config),
    );
    const activateRuntimeSecrets = runtimeSecretsActivatorForTest({
      prepareRuntimeSecretsSnapshot,
    });
    const config = gatewayTokenConfig(
      asConfig({
        channels: {
          telegram: {
            botToken: { source: "env", provider: "default", id: "TELEGRAM_BOT_TOKEN" },
          },
        },
      }),
    );

    const result = await activateRuntimeSecrets(config, {
      reason: "startup",
      activate: false,
    });
    expect(typeof result.config.gateway).toBe("object");
    const preflightInput = prepareRuntimeSecretsSnapshot.mock.calls[0]![0];
    expect(preflightInput.config?.channels).toBeUndefined();
    expect(preflightInput.loadAuthStore).toBe(loadAuthProfileStoreWithoutExternalProfilesAsync);
  });

  it("honors startup auth overrides before secret preflight gating", async () => {
    const prepareRuntimeSecretsSnapshot = vi.fn<PrepareRuntimeSecretsSnapshotForTest>(
      async ({ config }) => preparedSnapshot(config),
    );
    const result = await prepareGatewayStartupConfig({
      configSnapshot: gatewaySecretRefSnapshot(),
      authOverride: {
        mode: "password",
        password: "override-password", // pragma: allowlist secret
      },
      activateRuntimeSecrets: runtimeSecretsActivatorForTest({
        prepareRuntimeSecretsSnapshot,
      }),
    });

    expect(result.auth.mode).toBe("password");
    expect(result.auth.password).toBe("override-password");
    const preflightInput = prepareRuntimeSecretsSnapshot.mock.calls[0]![0];
    expect(preflightInput.config?.gateway?.auth?.mode).toBe("password");
    expect(preflightInput.config?.gateway?.auth?.password).toBe("override-password");
    expect(preflightInput.loadAuthStore).toBe(loadAuthProfileStoreWithoutExternalProfilesAsync);
    expect(getActiveSecretsRuntimeSnapshotState()?.config.gateway?.auth?.password).toBe(
      "override-password",
    );
  });

  it("falls back to a fresh startup activation when the preflight snapshot source is not reusable", async () => {
    const prepareRuntimeSecretsSnapshot = vi.fn(async ({ config }) => ({
      ...preparedSnapshot(
        prepareRuntimeSecretsSnapshot.mock.calls.length === 1
          ? {
              ...config,
              diagnostics: {
                enabled: true,
              },
            }
          : config,
      ),
      config: preparedSnapshotWithGatewayToken(config).config,
    }));
    const result = await prepareGatewayStartupConfig({
      configSnapshot: gatewaySecretRefSnapshot(),
      activateRuntimeSecrets: runtimeSecretsActivatorForTest({
        prepareRuntimeSecretsSnapshot,
      }),
    });
    expect(result.auth).toMatchObject({ mode: "token", token: RESOLVED_GATEWAY_TOKEN });
    expect(prepareRuntimeSecretsSnapshot).toHaveBeenCalledTimes(2);
    expect(getActiveSecretsRuntimeSnapshotState()?.config.gateway?.auth?.token).toBe(
      RESOLVED_GATEWAY_TOKEN,
    );
  });

  it("activates no-SecretRef startup config without importing the full secrets runtime", async () => {
    vi.resetModules();
    const agentDir = autoCleanupTempDirs.make("openclaw-startup-fast-path-");
    const isolatedEnv = installIsolatedStartupFastPathEnv();
    const startupConfig: OpenClawConfig = { agents: { entries: { default: { agentDir } } } };
    const runtimeImport = vi.fn();
    const prepareRuntimeSecretsSnapshot = vi.fn<PrepareRuntimeSecretsSnapshotForTest>(
      async ({ config }) => preparedSnapshot(config),
    );
    const activateRuntimeSecretsSnapshot = vi.fn();
    const loadAuthProfileStoreWithoutExternalProfilesAsyncMock = vi.fn(async () =>
      createAuthProfileStoreFixture({}),
    );
    installGatewayStartupSecretsRuntimeMock({
      runtimeImport,
      prepareRuntimeSecretsSnapshot,
      activateRuntimeSecretsSnapshot,
      loadAuthStore: loadAuthProfileStoreWithoutExternalProfilesAsyncMock,
    });

    try {
      const {
        clearSecretsRuntimeSnapshotState: clearImportedSecretsRuntimeSnapshot,
        getActiveSecretsRuntimeSnapshotState: getImportedSecretsRuntimeSnapshot,
      } = await import("../secrets/runtime-state.js");
      const { getRuntimeConfigSnapshotRefreshHandler } =
        await import("../config/runtime-snapshot.js");
      const result = await activateImportedStartupConfig(startupConfig);

      expect(runtimeImport).not.toHaveBeenCalled();
      expect(prepareRuntimeSecretsSnapshot).not.toHaveBeenCalled();
      expect(activateRuntimeSecretsSnapshot).not.toHaveBeenCalled();
      expect(loadAuthProfileStoreWithoutExternalProfilesAsyncMock).not.toHaveBeenCalled();
      expect(result.config.gateway?.auth?.token).toBe("startup-test-token");
      expect(getImportedSecretsRuntimeSnapshot()?.config.gateway?.auth?.token).toBe(
        "startup-test-token",
      );
      const refreshHandler = getRuntimeConfigSnapshotRefreshHandler();
      await expect(
        refreshHandler?.refresh({
          sourceConfig: gatewayTokenConfig(startupConfig),
        }),
      ).resolves.toBe(true);
      expect(runtimeImport).toHaveBeenCalledTimes(1);
      const refreshInput = prepareRuntimeSecretsSnapshot.mock.calls[0]![0];
      expect(refreshInput.loadAuthStore).toBeUndefined();
      clearImportedSecretsRuntimeSnapshot();
    } finally {
      isolatedEnv.cleanup();
      cleanupGatewayStartupSecretsRuntimeMock();
      vi.resetModules();
    }
  });

  it("retries a stale startup fast-path preflight against the newer runtime context", async () => {
    const agentDir = autoCleanupTempDirs.make("openclaw-startup-fast-path-cas-");
    let clearImportedSecretsRuntimeSnapshot: (() => void) | undefined;
    const config = (port: number) =>
      gatewayTokenConfig(
        asConfig({
          agents: { entries: { default: { agentDir } } },
          gateway: { port },
        }),
      );
    try {
      // A preceding lazy-import test resets Vitest's module cache. Import this
      // whole runtime graph together so the activator and handler share state.
      const { createRuntimeSecretsActivator: createImportedRuntimeSecretsActivator } =
        await import("./server-startup-config.js");
      const secretsRuntime = await import("../secrets/runtime.js");
      clearImportedSecretsRuntimeSnapshot = secretsRuntime.clearSecretsRuntimeSnapshot;
      const activateRuntimeSecrets = createImportedRuntimeSecretsActivator(
        runtimeSecretsActivatorOptionsForTest(),
      );
      await activateRuntimeSecrets(config(19_021), {
        reason: "startup",
        activate: true,
      });
      const { getRuntimeConfigSnapshotRefreshHandler } =
        await import("../config/runtime-snapshot.js");
      const staleRefreshHandler = getRuntimeConfigSnapshotRefreshHandler();
      if (!staleRefreshHandler?.preflight) {
        throw new Error("expected startup fast-path refresh preflight handler");
      }
      const desiredConfig = config(19_023);
      const preflightResult = await staleRefreshHandler.preflight({
        sourceConfig: desiredConfig,
      });
      const concurrent = await secretsRuntime.prepareSecretsRuntimeSnapshot({
        config: config(19_022),
        agentDirs: [agentDir],
        loadAuthStore: () =>
          createAuthProfileStoreFixture({
            "openai:default": {
              type: "api_key",
              provider: "openai",
              key: "newer-context-key",
            },
          }),
      });
      secretsRuntime.activateSecretsRuntimeSnapshot(concurrent);

      await expect(
        staleRefreshHandler.refresh({ sourceConfig: desiredConfig, preflightResult }),
      ).resolves.toBe(true);

      const active = secretsRuntime.getActiveSecretsRuntimeSnapshot();
      expect(active?.sourceConfig.gateway?.port).toBe(19_023);
      expect(active?.authStores[0]?.store.profiles["openai:default"]).toMatchObject({
        key: "newer-context-key",
      });
    } finally {
      clearImportedSecretsRuntimeSnapshot?.();
    }
  });

  it("grafts live auth stores onto one-shot config-write snapshots", async () => {
    const agentDir = "/tmp/openclaw-managed-write-auth-store";
    const credential = {
      type: "api_key" as const,
      provider: "openai",
      key: "live-auth-store-key",
    };
    setRuntimeAuthProfileStoreSnapshot(
      { version: 1, profiles: { "openai:default": credential } },
      agentDir,
    );
    const active = preparedSnapshot(gatewayTokenConfig({}));
    active.authStores = prepareRuntimeAuthProfileStoreSnapshots([
      {
        agentDir,
        store: { version: 1, profiles: { "openai:default": credential } },
      },
    ]);
    active.authStoreCredentialsRevision = getRuntimeAuthProfileStoreCredentialsRevision();
    activateSecretsRuntimeSnapshotState({
      snapshot: active,
      refreshContext: {
        env: {},
        explicitAgentDirs: null,
        includeAuthStoreRefs: true,
        loadablePluginOrigins: new Map(),
      },
      refreshHandler: null,
    });
    const prepareRuntimeSecretsSnapshot = vi.fn(async (params: { config: OpenClawConfig }) =>
      preparedSnapshot(params.config),
    );
    const activateRuntimeSecrets = runtimeSecretsActivatorForTest({
      prepareRuntimeSecretsSnapshot,
      activateRuntimeSecretsSnapshot: activateSecretsRuntimeSnapshotForTest,
    });

    const prepared = await activateRuntimeSecrets(
      gatewayTokenConfig({ logging: { level: "debug" } }),
      {
        reason: "reload",
        activate: false,
        includeAuthStoreRefs: false,
      },
    );
    expect(prepared.authStores[0]?.store.profiles["openai:default"]).toEqual(credential);
    await activateRuntimeSecrets.activatePreparedSnapshot(prepared, {
      reason: "reload",
      activate: true,
      includeAuthStoreRefs: false,
    });
    expect(getRuntimeAuthProfileStoreSnapshotCore(agentDir)?.profiles["openai:default"]).toEqual(
      credential,
    );
  });

  it("keeps the full secrets runtime path when auth profile files are present", async () => {
    vi.resetModules();
    const agentDir = autoCleanupTempDirs.make("openclaw-startup-auth-store-");
    const runtimeImport = vi.fn();
    const prepareRuntimeSecretsSnapshot = vi.fn(async ({ config }) => {
      // Capture revisions from the same module generation as activation.
      const revisions = await import("../agents/auth-profiles/runtime-snapshots.js");
      return {
        ...preparedSnapshot(config),
        authStoreCredentialsRevision: revisions.getRuntimeAuthProfileStoreCredentialsRevision(),
        authStoreSnapshotsRevision: revisions.getRuntimeAuthProfileStoreSnapshotsRevision(),
      };
    });
    const activateRuntimeSecretsSnapshot = vi.fn();
    writeFileSync(
      path.join(agentDir, "auth-profiles.json"),
      JSON.stringify(
        createAuthProfileStoreFixture({
          "openai:default": { type: "api_key", provider: "openai", key: "sk-test" },
        }),
      ),
    );
    installGatewayStartupSecretsRuntimeMock({
      runtimeImport,
      prepareRuntimeSecretsSnapshot,
      activateRuntimeSecretsSnapshot,
    });
    try {
      await activateImportedStartupConfig({ agents: { entries: { default: { agentDir } } } });
      expect(runtimeImport).toHaveBeenCalledTimes(1);
      expect(prepareRuntimeSecretsSnapshot).toHaveBeenCalledTimes(1);
      expect(activateRuntimeSecretsSnapshot).toHaveBeenCalledTimes(1);
    } finally {
      cleanupGatewayStartupSecretsRuntimeMock();
      vi.resetModules();
    }
  });

  it("uses the activation env when publishing persisted startup auth", async () => {
    const root = autoCleanupTempDirs.make("openclaw-startup-activation-env-auth-");
    const processHome = path.join(root, "process-home");
    const activationHome = path.join(root, "activation-home");
    const activationAgentDir = path.join(activationHome, "configured-agent");
    mkdirSync(processHome, { recursive: true });
    mkdirSync(activationAgentDir, { recursive: true });

    await withEnvAsync(
      {
        HOME: processHome,
        OPENCLAW_STATE_DIR: path.join(processHome, "state"),
        OPENCLAW_AGENT_DIR: undefined,
      },
      async () => {
        writePersistedAuthProfileStoreRaw(
          createAuthProfileStoreFixture({
            "openai:default": {
              type: "api_key",
              provider: "openai",
              key: "fake-activation-env-key",
            },
          }),
          activationAgentDir,
        );
        const secretsRuntime = await import("../secrets/runtime.js");
        const activationEnv = {
          ...process.env,
          HOME: activationHome,
          OPENCLAW_STATE_DIR: path.join(activationHome, "state"),
        };

        try {
          await activateImportedStartupConfig(
            {
              agents: {
                entries: { main: { agentDir: "~/configured-agent" } },
              },
            },
            activationEnv,
          );

          const activeStore = secretsRuntime.getActiveSecretsRuntimeSnapshot()?.authStores[0];
          expect(activeStore?.agentDir).toBe(activationAgentDir);
          expect(activeStore?.store.profiles["openai:default"]).toMatchObject({
            key: "fake-activation-env-key",
          });
        } finally {
          secretsRuntime.clearSecretsRuntimeSnapshot();
        }
      },
    );
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
