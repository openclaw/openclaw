import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createInfoWarnErrorLogger as mockLogSecretsForTest } from "../../test/helpers/mock-logger.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { loadAuthProfileStoreWithoutExternalProfilesAsync } from "../agents/auth-profiles.js";
import { createAuthProfileStoreFixture } from "../agents/auth-profiles/credential-fixtures.test-support.js";
import {
  getRuntimeAuthProfileStoreSnapshotCore,
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

type PrepareSnapshot = typeof import("../secrets/runtime.js").prepareSecretsRuntimeSnapshot;
type ActivateSnapshot = typeof import("../secrets/runtime.js").activateSecretsRuntimeSnapshot;

type GatewayStartupSecretsRuntimeMock = {
  runtimeImport: () => void;
  loadAuthStore?: typeof loadAuthProfileStoreWithoutExternalProfilesAsync;
  prepareRuntimeSecretsSnapshot: PrepareSnapshot;
  activateRuntimeSecretsSnapshot: ActivateSnapshot;
};
const runtimeMockGlobal = globalThis as typeof globalThis & {
  __gatewayStartupSecretsRuntimeMock?: GatewayStartupSecretsRuntimeMock;
};

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

function authStore(key: string, profile = "openai:default") {
  return createAuthProfileStoreFixture({
    [profile]: { type: "api_key" as const, provider: "openai", key },
  });
}
function missingRef(
  refId: string,
  message = `Environment variable "${refId}" is missing or empty.`,
) {
  const code = "SECRET_REF_NOT_FOUND";
  return refResolutionError({ code, source: "env", provider: "default", refId, message });
}

function associateFailure(
  error: Error,
  owner: SecretOwner,
  source: "config" | "auth-store" = "config",
) {
  associateSecretResolutionErrorOwners(error, [
    { ...owner, degradationState: owner.degradationState ?? "cold", failureMatched: true, source },
  ]);
}

function activateSnapshot(snapshot: PreparedSecretsRuntimeSnapshot): void {
  activateSecretsRuntimeSnapshotState({ snapshot, refreshContext: null, refreshHandler: null });
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
  const apiKey = refId ? { source: "env" as const, provider: "default", id: refId } : "fixture";
  const openai = { apiKey, models: [], baseUrl: "https://api.openai.com/v1" };
  return gatewayTokenConfig({ models: { providers: { openai } } });
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

function withGatewayToken(config: OpenClawConfig, token = RESOLVED_GATEWAY_TOKEN) {
  const auth = { ...config.gateway?.auth, token };
  return preparedSnapshot(config, { config: { ...config, gateway: { ...config.gateway, auth } } });
}

function gatewaySecretRefSnapshot(): ConfigFileSnapshot {
  return buildSnapshot({
    secrets: { providers: { default: { source: "env" } } },
    gateway: {
      auth: {
        mode: "token",
        token: { source: "env", provider: "default", id: "GATEWAY_TOKEN_REF" },
      },
    },
  });
}

function makeActivator(
  params: Partial<ReturnType<typeof activatorOptions>> & {
    prepareRuntimeSecretsSnapshot?: PrepareSnapshot;
    activateRuntimeSecretsSnapshot?: ActivateSnapshot;
  } = {},
) {
  const options = {
    ...activatorOptions(),
    prepareRuntimeSecretsSnapshot: vi.fn<PrepareSnapshot>(async ({ config }) =>
      preparedSnapshot(config),
    ),
    activateRuntimeSecretsSnapshot: vi.fn<ActivateSnapshot>(),
    ...params,
  };
  return Object.assign(createRuntimeSecretsActivator(options), {
    emitStateEvent: options.emitStateEvent,
    logSecrets: options.logSecrets,
    prepare: vi.mocked(options.prepareRuntimeSecretsSnapshot),
    publish: vi.mocked(options.activateRuntimeSecretsSnapshot),
  });
}

function expectEvents(activator: ReturnType<typeof makeActivator>, ...codes: string[]) {
  expect(activator.emitStateEvent.mock.calls.map(([code]) => code)).toEqual(codes);
}

function capabilityOwner(overrides: Partial<SecretOwner> = {}) {
  return providerOwner({
    ownerKind: "capability",
    ownerId: "tts",
    degradationState: "cold",
    paths: ["tts.providers.elevenlabs.apiKey"],
    refKeys: ["env:default:ELEVENLABS_API_KEY"],
    ...overrides,
  });
}

function degradedSnapshot(config: OpenClawConfig, owner = providerOwner()) {
  return preparedSnapshot(config, { degradedOwners: [owner] });
}

function failingActivator(error: Error, owner?: SecretOwner) {
  if (owner) {
    associateFailure(error, owner);
  }
  return makeActivator({
    prepareRuntimeSecretsSnapshot: vi.fn<PrepareSnapshot>().mockRejectedValue(error),
  });
}

function expectMissingRefWarning(
  { logSecrets }: ReturnType<typeof makeActivator>,
  ownerKind: string,
  ownerId: string,
  state: string,
  privateRef: string,
) {
  expect(logSecrets.warn).toHaveBeenCalledWith(
    `[SECRETS_DEGRADED] ${state} ${ownerKind}:${ownerId}: secret reference was not found. Retry: openclaw secrets reload.`,
    {
      event: "secrets.degraded",
      ownerKind,
      ownerId,
      reason: "secret reference was not found",
      state,
      retryHint: "openclaw secrets reload",
    },
  );
  expect(JSON.stringify(logSecrets.warn.mock.calls)).not.toContain(privateRef);
}

function activatorOptions() {
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
  runtimeMockGlobal["__gatewayStartupSecretsRuntimeMock"] = state;
  // mock-isolation: startup controls the auth fixture so host credentials cannot alter lazy secrets activation.
  vi.doMock("../agents/auth-profiles.js", () => ({
    loadAuthProfileStoreWithoutExternalProfilesAsync:
      state.loadAuthStore ?? vi.fn(() => createAuthProfileStoreFixture({})),
  }));
  // mock-isolation: Startup tests own secrets activation and must not access host credentials.
  vi.doMock("../secrets/runtime.js", () => {
    const runtimeState = runtimeMockGlobal["__gatewayStartupSecretsRuntimeMock"];
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

function mockImportedRuntime(
  prepare: PrepareSnapshot = async ({ config }) => preparedSnapshot(config),
) {
  const mock = {
    imported: vi.fn(),
    prepare: vi.fn(prepare),
    publish: vi.fn(),
    load: vi.fn(async () => createAuthProfileStoreFixture({})),
  };
  installGatewayStartupSecretsRuntimeMock({
    runtimeImport: mock.imported,
    prepareRuntimeSecretsSnapshot: mock.prepare,
    activateRuntimeSecretsSnapshot: mock.publish,
    loadAuthStore: mock.load,
  });
  return mock;
}

function cleanupGatewayStartupSecretsRuntimeMock(): void {
  vi.doUnmock("../agents/auth-profiles.js");
  vi.doUnmock("../secrets/runtime.js");
  delete runtimeMockGlobal["__gatewayStartupSecretsRuntimeMock"];
}

async function activateImportedStartupConfig(config: OpenClawConfig, env?: NodeJS.ProcessEnv) {
  const { createRuntimeSecretsActivator: createActivator } =
    await import("./server-startup-config.js");
  return await createActivator(activatorOptions())(gatewayTokenConfig(config), {
    reason: "startup",
    activate: true,
    env,
  });
}

afterEach(clearSecretsRuntimeSnapshotState);

it.each([true, false])(
  "scopes reload recovery to remaining owners (provider first: %s)",
  async (providerFirst) => {
    const config = providerConfig();
    const providerDegraded = degradedSnapshot(
      config,
      providerOwner({ reason: "secret provider failed" }),
    );
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
    const activate = makeActivator({
      prepareRuntimeSecretsSnapshot: vi
        .fn<PrepareSnapshot>()
        .mockRejectedValueOnce(failure)
        .mockResolvedValueOnce(providerDegraded),
      activateRuntimeSecretsSnapshot: activateSnapshot,
    });
    const { emitStateEvent } = activate;
    activateSnapshot(preparedSnapshot(config));
    if (providerFirst) {
      await expect(publishProvider(providerDegraded)).resolves.toBe(true);
    }
    await expect(activate(config, PREFLIGHT_RELOAD)).rejects.toThrow(failure.message);
    if (!providerFirst) {
      await activate(config, RELOAD);
    }
    await expect(publishProvider(preparedSnapshot(config))).resolves.toBe(true);
    expectEvents(activate, ...(providerFirst ? [DEGRADED] : [DEGRADED, RECOVERED]));
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
  const withDegradedToken = (token: string): PreparedSecretsRuntimeSnapshot => ({
    ...withGatewayToken(initial.sourceConfig, token),
    warnings: [
      {
        code: "SECRETS_OWNER_UNAVAILABLE",
        path: "models.providers.openai.apiKey",
        message: "Secret owner provider:openai is using last-known-good.",
      },
    ],
    degradedOwners: [providerOwner()],
  });
  const rolledBackCandidate = withDegradedToken("rolled-back-token");
  const committedCandidate = withDegradedToken("committed-token");
  const activate = makeActivator({ activateRuntimeSecretsSnapshot: activateSnapshot });
  const { emitStateEvent, logSecrets } = activate;
  activateSnapshot(initial);

  await activateDeferred(activate, rolledBackCandidate);
  expect(emitStateEvent).not.toHaveBeenCalled();
  expect(logSecrets.warn).not.toHaveBeenCalled();

  activateSnapshot(initial);
  await activateDeferred(activate, committedCandidate);
  expect(emitStateEvent).not.toHaveBeenCalled();
  expect(logSecrets.warn).not.toHaveBeenCalled();

  activate.publishStateTransition(rolledBackCandidate);
  expect(emitStateEvent).not.toHaveBeenCalled();
  expect(logSecrets.warn).not.toHaveBeenCalled();

  activate.publishStateTransition(committedCandidate);
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

it.each([false, true])(
  "publishes deferred state after a provider-auth descendant (healed: %s)",
  async (healed) => {
    const config = providerConfig();
    const activate = makeActivator({ activateRuntimeSecretsSnapshot: activateSnapshot });
    activateSnapshot(preparedSnapshot(config));
    if (healed) {
      await activate.activatePreparedSnapshot(degradedSnapshot(config, capabilityOwner()), RELOAD);
    }
    const deferred = degradedSnapshot(config, healed ? providerOwner() : capabilityOwner());
    await activateDeferred(activate, deferred);
    const descendant = healed ? preparedSnapshot(config) : structuredClone(deferred);
    if (!healed) {
      descendant.degradedOwners?.push(providerOwner());
    }
    await expect(publishProvider(descendant, true)).resolves.toBe(true);
    expectEvents(activate, ...(healed ? [DEGRADED] : []));
    activate.publishStateTransition(deferred);
    expectEvents(activate, ...(healed ? [DEGRADED, RECOVERED] : [DEGRADED]));
  },
);

it("publishes source-only recovery after a provider descendant", async () => {
  const stableConfig = providerConfig("OPENAI_STABLE");
  const failedConfig = providerConfig("OPENAI_CHANGED");
  const failure = new Error("provider secret unavailable");
  associateFailure(
    failure,
    providerOwner({ refKeys: ["env:default:OPENAI_CHANGED"], degradationState: "cold" }),
  );
  const activate = makeActivator({
    prepareRuntimeSecretsSnapshot: vi.fn<PrepareSnapshot>().mockRejectedValue(failure),
    activateRuntimeSecretsSnapshot: activateSnapshot,
  });
  activateSnapshot(preparedSnapshot(stableConfig));
  await expect(activate(failedConfig, PREFLIGHT_RELOAD)).rejects.toBe(failure);

  const sourceOnly = preparedSnapshot(stableConfig);
  activateSnapshot(sourceOnly);
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

  activate.publishStateTransition(sourceOnly, {
    sourceOnly: true,
    expectedRevision: committedRevision,
  });
  expectEvents(activate, DEGRADED, RECOVERED);
});

it.each(["same source", "secrets changed", "credentials changed", "admission closed"] as const)(
  "checks source and authority under the activation lock (%s)",
  async (scenario) => {
    const initial = preparedSnapshot(gatewayTokenConfig({}));
    const candidate = withGatewayToken(initial.sourceConfig, "candidate-token");
    const later = withGatewayToken(initial.sourceConfig, "later-token");
    const activator = makeActivator({ activateRuntimeSecretsSnapshot: activateSnapshot });
    const activate = activator.activatePreparedSnapshotIfCurrent;
    activateSnapshot(initial);
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
        activateSnapshot(later);
      }
      if (scenario === "credentials changed") {
        setRuntimeAuthProfileStoreSnapshot(
          authStore("synthetic-new-key", "openai:observation-test"),
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
        (scenario === "same source" ? candidate : scenario === "secrets changed" ? later : initial)
          .config,
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
    const failure = new Error('Secret provider "default" is not configured for GATEWAY_TOKEN_REF.');
    const activate = failingActivator(failure);

    await expect(
      prepareGatewayStartupConfig({
        configSnapshot: gatewaySecretRefSnapshot(),
        activateRuntimeSecrets: activate,
        measure: (name, run, options) =>
          measureDiagnosticsTimelineSpan(name, run, {
            env: process.env,
            omitErrorMessage: options?.omitErrorMessage,
            phase: "startup",
          }),
      }),
    ).rejects.toMatchObject({ message: expect.stringContaining(failure.message), cause: failure });

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
      expect(event).toMatchObject({ phase: "startup", errorName: "Error" });
      expect(event.errorMessage).toBeUndefined();
    }
    expect(JSON.stringify(events)).not.toContain("GATEWAY_TOKEN_REF");
    expect(JSON.stringify(events)).not.toContain("default");
  } finally {
    timelineEnv.cleanup();
  }
});

it("redacts startup failures without emitting reload events", async () => {
  const error = missingRef("PRIVATE_STARTUP_AUTH_REF");
  const activate = failingActivator(
    error,
    providerOwner({
      ownerKind: "gateway",
      ownerId: "auth",
      paths: ["gateway.auth.token"],
      refKeys: ["env:default:PRIVATE_STARTUP_AUTH_REF"],
      degradationState: "cold",
    }),
  );

  const startupFailure = await activate(gatewayTokenConfig({}), {
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
  expectMissingRefWarning(activate, "gateway", "auth", "cold", "PRIVATE_STARTUP_AUTH_REF");
  expectEvents(activate);
});

it("publishes one provider outage diagnostic with its affected owner list", async () => {
  const sourceConfig: OpenClawConfig = {};
  const providerFailures = [{ source: "exec" as const, provider: "vault" }];
  const degradedOwners = [
    providerOwner({
      degradationState: "cold",
      refKeys: ["exec:vault:models/openai"],
      reason: "secret provider failed",
      providerFailures,
    }),
    capabilityOwner({
      degradationState: "stale",
      refKeys: ["exec:vault:tts/elevenlabs"],
      reason: "secret provider failed",
      providerFailures,
    }),
  ];
  const warnings = degradedOwners.map(({ ownerKind, ownerId, paths }) => ({
    code: "SECRETS_OWNER_UNAVAILABLE" as const,
    path: paths[0]!,
    message: `Secret owner ${ownerKind}:${ownerId} is configured-unavailable.`,
  }));
  const prepared = preparedSnapshot(sourceConfig, { warnings, degradedOwners });
  const activate = makeActivator({ prepareRuntimeSecretsSnapshot: vi.fn(async () => prepared) });
  const { logSecrets } = activate;

  await activate(sourceConfig, { reason: "startup", activate: true });

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

it.each(["invalid value", "expired ownership"] as const)(
  "rejects reload failures without publishing degradation (%s)",
  async (scenario) => {
    activateSnapshot(preparedSnapshot(gatewayTokenConfig({})));
    const invalid = scenario === "invalid value";
    const failure = invalid
      ? new Error("tts.providers.elevenlabs.apiKey resolved to a non-string or empty value.")
      : missingRef("EXPIRED_RELOAD_REF", "expired reload fixture");
    const activate = failingActivator(
      failure,
      capabilityOwner({
        degradationState: "stale",
        refKeys: [invalid ? "file:ttsfile:/private/value" : "env:default:EXPIRED_RELOAD_REF"],
        ...(invalid ? { reason: "resolved secret value was invalid" as const } : {}),
      }),
    );
    await expect(
      activate(gatewayTokenConfig({}), {
        ...PREFLIGHT_RELOAD,
        ...(invalid ? {} : { canPublishFailureAsDegraded: () => false }),
      }),
    ).rejects.toThrow(failure.message);
    expect(activate.logSecrets.warn).not.toHaveBeenCalled();
    expectEvents(activate);
  },
);

it("redacts unmapped typed reload failures", async () => {
  activateSnapshot(preparedSnapshot(gatewayTokenConfig({})));
  const missingSecretError = missingRef("PRIVATE_UNMAPPED_REF");
  const activate = failingActivator(missingSecretError);

  await expect(activate(gatewayTokenConfig({}), PREFLIGHT_RELOAD)).rejects.toThrow(
    missingSecretError.message,
  );

  expectMissingRefWarning(activate, "unknown", "unmapped", "cold", "PRIVATE_UNMAPPED_REF");
  expect(activate.emitStateEvent).toHaveBeenCalledWith(
    DEGRADED,
    "Secret resolution failed; runtime remains on the last-known-good snapshot.",
    expect.anything(),
  );
});

it("does not enable cold-start degradation while a runtime snapshot is active", async () => {
  activateSnapshot(preparedSnapshot(gatewayTokenConfig({})));
  const missingSecretError = new Error(
    'Environment variable "ELEVENLABS_API_KEY" is missing or empty.',
  );
  const activate = failingActivator(missingSecretError);

  await expect(
    activate(gatewayTokenConfig({}), { reason: "startup", activate: false }),
  ).rejects.toThrow("Startup failed: required secrets are unavailable.");

  expect(activate.prepare).toHaveBeenCalledWith(
    expect.objectContaining({ allowUnavailableSecretOwners: false }),
  );
  expect(activate.publish).not.toHaveBeenCalled();
});

it("emits one-shot degraded and recovered events during secret reload transitions", async () => {
  const missingSecretError = new Error(
    'Environment variable "OPENAI_API_KEY" is missing or empty.',
  );
  let shouldResolve = false;
  const sourceConfig = providerConfig("OPENAI_API_KEY");
  const activeSnapshot = preparedSnapshot(sourceConfig);
  activeSnapshot.config.models!.providers!.openai!.apiKey = "test-api-key";
  activateSnapshot(activeSnapshot);
  associateFailure(missingSecretError, providerOwner());
  const prepareRuntimeSecretsSnapshot = vi.fn(async ({ config }) => {
    if (!shouldResolve) {
      throw missingSecretError;
    }
    return preparedSnapshot(config);
  });
  const activate = makeActivator({
    prepareRuntimeSecretsSnapshot,
    activateRuntimeSecretsSnapshot: activateSnapshot,
  });
  const { emitStateEvent, logSecrets } = activate;
  const expectReloadFailure = (config = sourceConfig) =>
    expect(activate(config, PREFLIGHT_RELOAD)).rejects.toThrow(missingSecretError.message);

  await expectReloadFailure();
  await expectReloadFailure();
  shouldResolve = true;
  const activeRevision = getActiveSecretsRuntimeSnapshotRevisionState();
  const prepared = await activate(sourceConfig, { reason: "restart-check", activate: false });
  expect(emitStateEvent).toHaveBeenCalledTimes(1);

  await expect(
    activate.activatePreparedSnapshotIfCurrent(prepared, activeRevision, RELOAD),
  ).resolves.toMatchObject({ config: sourceConfig });
  expectEvents(activate, DEGRADED, RECOVERED);
  expect(emitStateEvent.mock.calls[0]?.[1]).toBe(
    "Secret resolution failed; runtime remains on the last-known-good snapshot.",
  );
  expect(logSecrets.error).not.toHaveBeenCalled();
  expect(logSecrets.warn).toHaveBeenCalledTimes(2);
  expectMissingRefWarning(activate, "provider", "openai", "stale", "OPENAI_API_KEY");
  expect(logSecrets.info).toHaveBeenCalledWith(
    "[SECRETS_RELOADER_RECOVERED] Secret resolution recovered.",
  );

  shouldResolve = false;
  await expectReloadFailure();
  shouldResolve = true;
  const sourceOnlyRevision = getActiveSecretsRuntimeSnapshotRevisionState();
  const sourceOnly = await activate(sourceConfig, PREFLIGHT_RELOAD);
  await expect(
    activate.activatePreparedSnapshotIfCurrent(sourceOnly, sourceOnlyRevision, DEFERRED_RELOAD),
  ).resolves.toMatchObject({ config: sourceConfig });
  expectEvents(activate, DEGRADED, RECOVERED, DEGRADED);
  shouldResolve = false;
  await expectReloadFailure();
  activate.publishStateTransition(sourceOnly);
  expectEvents(activate, DEGRADED, RECOVERED, DEGRADED);
  shouldResolve = true;
  const newerRevision = getActiveSecretsRuntimeSnapshotRevisionState();
  const newerPrepared = await activate(sourceConfig, { reason: "reload", activate: false });
  await expect(
    activate.activatePreparedSnapshotIfCurrent(newerPrepared, newerRevision, RELOAD),
  ).resolves.toMatchObject({ config: sourceConfig });
  expectEvents(activate, DEGRADED, RECOVERED, DEGRADED, RECOVERED);

  const changedSourceConfig = providerConfig("OPENAI_API_KEY_NEXT");
  associateFailure(
    missingSecretError,
    providerOwner({ refKeys: ["env:default:OPENAI_API_KEY_NEXT"], degradationState: "cold" }),
  );
  shouldResolve = false;
  await expectReloadFailure(changedSourceConfig);
  const revertedSnapshot = getActiveSecretsRuntimeSnapshotState()!;
  const revertedRevision = getActiveSecretsRuntimeSnapshotRevisionState();
  await expect(
    activate.activatePreparedSnapshotIfCurrent(revertedSnapshot, revertedRevision, DEFERRED_RELOAD),
  ).resolves.toMatchObject({ sourceConfig });
  activate.publishStateTransition(revertedSnapshot, { sourceOnly: true });
  expect(emitStateEvent.mock.calls.map((call) => call[0]).slice(-2)).toEqual([DEGRADED, RECOVERED]);
});

it("keeps auth-store degradation on config-only reversion", async () => {
  const stableConfig = providerConfig("OPENAI_STABLE");
  const changedConfig = providerConfig("OPENAI_CHANGED");
  const configFailure = new Error("config secret failed");
  associateFailure(
    configFailure,
    providerOwner({ refKeys: ["env:default:OPENAI_CHANGED"], degradationState: "cold" }),
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
  let nextFailure = configFailure;
  const activate = makeActivator({
    prepareRuntimeSecretsSnapshot: vi.fn(async () => {
      throw nextFailure;
    }),
    activateRuntimeSecretsSnapshot: activateSnapshot,
  });
  activateSnapshot(preparedSnapshot(stableConfig));

  await expect(activate(changedConfig, PREFLIGHT_RELOAD)).rejects.toBe(configFailure);
  nextFailure = authStoreFailure;
  await expect(activate(changedConfig, PREFLIGHT_RELOAD)).rejects.toBe(authStoreFailure);

  const revertedSnapshot = preparedSnapshot(stableConfig);
  await activateDeferred(activate, revertedSnapshot);
  activate.publishStateTransition(revertedSnapshot, { sourceOnly: true });
  expectEvents(activate, DEGRADED);

  const fullyResolvedSnapshot = preparedSnapshot(stableConfig);
  await activateDeferred(activate, fullyResolvedSnapshot);
  activate.publishStateTransition(fullyResolvedSnapshot);
  expectEvents(activate, DEGRADED, RECOVERED);

  nextFailure = authStoreFailure;
  await expect(activate(changedConfig, PREFLIGHT_RELOAD)).rejects.toBe(authStoreFailure);
  nextFailure = configFailure;
  await expect(activate(changedConfig, PREFLIGHT_RELOAD)).rejects.toBe(configFailure);

  const secondRevertedSnapshot = preparedSnapshot(stableConfig);
  await activateDeferred(activate, secondRevertedSnapshot);
  activate.publishStateTransition(secondRevertedSnapshot, { sourceOnly: true });
  expectEvents(activate, DEGRADED, RECOVERED, DEGRADED);
});

it("rejects a known weak gateway token resolved during secret activation", async () => {
  const sourceConfig = gatewayTokenConfig(gatewaySecretRefSnapshot().config);
  const activate = makeActivator();
  activate.prepare.mockResolvedValue(
    withGatewayToken(sourceConfig, "change-me-to-a-long-random-token"),
  );

  await expect(activate(sourceConfig, RELOAD)).rejects.toThrow(/published example placeholder/);
  expect(activate.publish).not.toHaveBeenCalled();
});

it("honors startup auth overrides before secret preflight gating", async () => {
  const activate = makeActivator();
  const result = await prepareGatewayStartupConfig({
    configSnapshot: gatewaySecretRefSnapshot(),
    authOverride: {
      mode: "password",
      password: "override-password", // pragma: allowlist secret
    },
    activateRuntimeSecrets: activate,
  });

  expect(result.auth).toMatchObject({ mode: "password", password: "override-password" });
  const preflightInput = activate.prepare.mock.calls[0]![0];
  expect(preflightInput.config?.gateway?.auth).toMatchObject({
    mode: "password",
    password: "override-password",
  });
  expect(preflightInput.loadAuthStore).toBe(loadAuthProfileStoreWithoutExternalProfilesAsync);
  expect(getActiveSecretsRuntimeSnapshotState()?.config.gateway?.auth?.password).toBe(
    "override-password",
  );
});

it("prepares startup again when the preflight source cannot be reused", async () => {
  const prepareRuntimeSecretsSnapshot = vi.fn(async ({ config }) => ({
    ...preparedSnapshot(
      prepareRuntimeSecretsSnapshot.mock.calls.length === 1
        ? {
            ...config,
            diagnostics: { enabled: true },
          }
        : config,
    ),
    config: withGatewayToken(config).config,
  }));
  const result = await prepareGatewayStartupConfig({
    configSnapshot: gatewaySecretRefSnapshot(),
    activateRuntimeSecrets: makeActivator({ prepareRuntimeSecretsSnapshot }),
  });
  expect(result.auth).toMatchObject({ mode: "token", token: RESOLVED_GATEWAY_TOKEN });
  expect(prepareRuntimeSecretsSnapshot).toHaveBeenCalledTimes(2);
  expect(getActiveSecretsRuntimeSnapshotState()?.config.gateway?.auth?.token).toBe(
    RESOLVED_GATEWAY_TOKEN,
  );
});

it("activates reference-free startup without caller SQL or a runtime import", async () => {
  vi.resetModules();
  const agentDir = autoCleanupTempDirs.make("openclaw-startup-fast-path-");
  const isolatedEnv = installIsolatedStartupFastPathEnv();
  const startupConfig: OpenClawConfig = { agents: { entries: { default: { agentDir } } } };
  const mock = mockImportedRuntime();
  let sql: ReturnType<typeof observeHostDataSql> | undefined;
  let closeStateDatabase: (() => Promise<void>) | undefined;

  try {
    const {
      clearSecretsRuntimeSnapshotState: clearImportedSecretsRuntimeSnapshot,
      getActiveSecretsRuntimeSnapshotState: getImportedSecretsRuntimeSnapshot,
    } = await import("../secrets/runtime-state.js");
    const { getRuntimeConfigSnapshotRefreshHandler } =
      await import("../config/runtime-snapshot.js");
    const { writeConfigMachineState } = await import("../state/config-machine-state-write.js");
    closeStateDatabase = (await import("../state/openclaw-state-db.js"))
      .closeOpenClawStateDatabaseAsync;
    writeConfigMachineState("auth.sharedStore", { location: "legacy-main" });
    sql = observeHostDataSql();
    const result = await activateImportedStartupConfig(startupConfig);

    expect(sql.queries).toEqual([]);
    expect(mock.imported).not.toHaveBeenCalled();
    expect(mock.prepare).not.toHaveBeenCalled();
    expect(mock.publish).not.toHaveBeenCalled();
    expect(mock.load).not.toHaveBeenCalled();
    expect(result.config.gateway?.auth?.token).toBe("startup-test-token");
    expect(getImportedSecretsRuntimeSnapshot()?.config.gateway?.auth?.token).toBe(
      "startup-test-token",
    );
    const refreshHandler = getRuntimeConfigSnapshotRefreshHandler();
    await expect(
      refreshHandler?.refresh({ sourceConfig: gatewayTokenConfig(startupConfig) }),
    ).resolves.toBe(true);
    expect(mock.imported).toHaveBeenCalledTimes(1);
    const refreshInput = mock.prepare.mock.calls[0]![0];
    expect(refreshInput.loadAuthStore).toBeUndefined();
    clearImportedSecretsRuntimeSnapshot();
  } finally {
    sql?.restore();
    await closeStateDatabase?.();
    isolatedEnv.cleanup();
    cleanupGatewayStartupSecretsRuntimeMock();
    vi.resetModules();
  }
});

it("grafts live auth stores onto one-shot config-write snapshots", async () => {
  const agentDir = "/tmp/openclaw-managed-write-auth-store";
  const store = authStore("live-auth-store-key");
  const credential = store.profiles["openai:default"];
  setRuntimeAuthProfileStoreSnapshot(store, agentDir);
  const active = preparedSnapshot(gatewayTokenConfig({}), { authStores: [{ agentDir, store }] });
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
  const activate = makeActivator({ activateRuntimeSecretsSnapshot: activateSnapshot });

  const prepared = await activate(gatewayTokenConfig({ logging: { level: "debug" } }), {
    reason: "reload",
    activate: false,
    includeAuthStoreRefs: false,
  });
  expect(prepared.authStores[0]?.store.profiles["openai:default"]).toEqual(credential);
  await activate.activatePreparedSnapshot(prepared, {
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
  const mock = mockImportedRuntime(async ({ config }) => {
    // Capture revisions from the same module generation as activation.
    const revisions = await import("../agents/auth-profiles/runtime-snapshots.js");
    return {
      ...preparedSnapshot(config),
      authStoreCredentialsRevision: revisions.getRuntimeAuthProfileStoreCredentialsRevision(),
      authStoreSnapshotsRevision: revisions.getRuntimeAuthProfileStoreSnapshotsRevision(),
    };
  });
  writeFileSync(path.join(agentDir, "auth-profiles.json"), JSON.stringify(authStore("sk-test")));
  try {
    await activateImportedStartupConfig({ agents: { entries: { default: { agentDir } } } });
    expect(mock.imported).toHaveBeenCalledTimes(1);
    expect(mock.prepare).toHaveBeenCalledTimes(1);
    expect(mock.publish).toHaveBeenCalledTimes(1);
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
      writePersistedAuthProfileStoreRaw(authStore("fake-activation-env-key"), activationAgentDir);
      const secretsRuntime = await import("../secrets/runtime.js");
      const activationEnv = {
        ...process.env,
        HOME: activationHome,
        OPENCLAW_STATE_DIR: path.join(activationHome, "state"),
      };

      try {
        const config = { agents: { entries: { main: { agentDir: "~/configured-agent" } } } };
        await activateImportedStartupConfig(config, activationEnv);

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
}); /* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
