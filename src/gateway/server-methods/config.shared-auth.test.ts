/**
 * Tests shared gateway auth behavior across config method updates.
 */

import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred, awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import { getRuntimeConfigWriteApplication } from "../../config/runtime-write-application.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { RestartSentinelPayload } from "../../infra/restart-sentinel.js";
import {
  createConfigHandlerHarness,
  createConfigWriteSnapshot,
  flushConfigHandlerMicrotasks,
} from "./config.test-helpers.js";

const readConfigFileSnapshotForWriteMock = vi.fn();
const writeConfigFileMock = vi.fn();
const persistedConfigResultMock = vi.fn((config: OpenClawConfig) => config);
const runtimeApplication = { claimed: true };
const validateConfigObjectWithPluginsMock = vi.fn();
const prepareSecretsRuntimeSnapshotMock = vi.fn();
const scheduleGatewayRestartMock = vi.fn(() => ({
  scheduled: true,
  delayMs: 1_000,
  coalesced: false,
}));
const restartSentinelMocks = vi.hoisted(() => ({
  writeRestartSentinel: vi.fn(async (_payload: RestartSentinelPayload) => undefined),
}));

vi.mock("../../config/config.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../config/config.js")>("../../config/config.js");
  return {
    ...actual,
    createConfigIO: () => ({ configPath: "/tmp/openclaw.json" }),
    writeConfigFile: writeConfigFileMock,
    replaceConfigFile: async (params: { sourceConfig: OpenClawConfig; writeOptions?: object }) => {
      await writeConfigFileMock(params.sourceConfig, params.writeOptions);
      if (params.writeOptions && runtimeApplication.claimed) {
        getRuntimeConfigWriteApplication(params.writeOptions)?.claim()?.settle("applied");
      }
      const persistedConfig = persistedConfigResultMock(params.sourceConfig);
      return {
        path: "/tmp/openclaw.json",
        previousHash: "base-hash",
        snapshot: createConfigWriteSnapshot(params.sourceConfig),
        nextConfig: persistedConfig,
        persistedHash: "next-hash",
        afterWrite: { mode: "auto" },
        followUp: { mode: "auto", requiresRestart: false },
      };
    },
  };
});

vi.mock("../../config/io.js", async () => {
  const actual = await vi.importActual<typeof import("../../config/io.js")>("../../config/io.js");
  return {
    ...actual,
    createConfigIO: () => ({ configPath: "/tmp/openclaw.json" }),
    readConfigFileSnapshotForWrite: readConfigFileSnapshotForWriteMock,
  };
});

vi.mock("../../config/validation.js", async () => {
  const actual = await vi.importActual<typeof import("../../config/validation.js")>(
    "../../config/validation.js",
  );
  return {
    ...actual,
    validateConfigObjectWithPlugins: validateConfigObjectWithPluginsMock,
  };
});

vi.mock("../../config/runtime-schema.js", () => ({
  loadGatewayRuntimeConfigSchema: () => ({ uiHints: undefined }),
}));

vi.mock("../../secrets/runtime.js", () => ({
  prepareSecretsRuntimeSnapshot: prepareSecretsRuntimeSnapshotMock,
}));

vi.mock("../../secrets/runtime-state.js", () => ({
  getActiveSecretsRuntimeSnapshotState: () => null,
}));

vi.mock("../../infra/restart.js", () => ({
  scheduleGatewayRestart: scheduleGatewayRestartMock,
}));

vi.mock("../../infra/restart-sentinel.js", async () => {
  const actual = await vi.importActual<typeof import("../../infra/restart-sentinel.js")>(
    "../../infra/restart-sentinel.js",
  );
  return {
    ...actual,
    writeRestartSentinel: restartSentinelMocks.writeRestartSentinel,
  };
});

const { configHandlers } = await import("./config.js");

function tokenAuthConfig(token: string): OpenClawConfig {
  return {
    gateway: {
      auth: {
        mode: "token",
        token,
      },
    },
  };
}

function trustedProxyConfig(params: {
  trustedProxies?: string[];
  requiredHeaders?: string[];
  allowUsers?: string[];
}): OpenClawConfig {
  return {
    gateway: {
      auth: {
        mode: "trusted-proxy",
        trustedProxy: {
          userHeader: "x-forwarded-user",
          ...(params.requiredHeaders ? { requiredHeaders: params.requiredHeaders } : {}),
          ...(params.allowUsers ? { allowUsers: params.allowUsers } : {}),
        },
      },
      ...(params.trustedProxies ? { trustedProxies: params.trustedProxies } : {}),
    },
  };
}

function hotReloadConfig(): OpenClawConfig {
  return {
    gateway: {
      reload: {
        mode: "hot",
      },
    },
  };
}

function mockPreviousConfig(config: OpenClawConfig): void {
  readConfigFileSnapshotForWriteMock.mockResolvedValue(createConfigWriteSnapshot(config));
}

async function runConfigPatch(
  raw: unknown,
  params: { sessionKey?: string; restartDelayMs?: number; replacePaths?: string[] } = {},
) {
  const { options, respond, disconnectClientsUsingSharedGatewayAuth } = createConfigHandlerHarness({
    method: "config.patch",
    params: {
      baseHash: "base-hash",
      raw: typeof raw === "string" ? raw : JSON.stringify(raw),
      restartDelayMs: params.restartDelayMs ?? 1_000,
      ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
      ...(params.replacePaths ? { replacePaths: params.replacePaths } : {}),
    },
  });

  await expectDefined(
    configHandlers["config.patch"],
    'configHandlers["config.patch"] test invariant',
  )(options);
  await flushConfigHandlerMicrotasks();
  return { respond, disconnectClientsUsingSharedGatewayAuth };
}

function expectNoDirectRestart(): void {
  expect(scheduleGatewayRestartMock).not.toHaveBeenCalled();
}

afterEach(() => {
  vi.clearAllMocks();
});

beforeEach(() => {
  runtimeApplication.claimed = true;
  validateConfigObjectWithPluginsMock.mockImplementation((config: OpenClawConfig) => ({
    ok: true,
    config,
  }));
  prepareSecretsRuntimeSnapshotMock.mockImplementation(
    async ({ config }: { config: OpenClawConfig }) => ({
      config,
    }),
  );
  restartSentinelMocks.writeRestartSentinel.mockClear();
  persistedConfigResultMock.mockImplementation((config: OpenClawConfig) => config);
});

describe("config shared auth disconnects", () => {
  it.each([
    { method: "config.patch", claimed: true },
    { method: "config.apply", claimed: true },
    { method: "config.patch", claimed: false },
    { method: "config.apply", claimed: false },
    { method: "config.set", claimed: false },
  ] as const)(
    "keeps $method auth reconciliation with its owner (claimed=$claimed)",
    async ({ method, claimed }) => {
      runtimeApplication.claimed = claimed;
      const nextConfig = tokenAuthConfig("new-token");
      mockPreviousConfig(tokenAuthConfig("old-token"));
      const enforceGeneration = vi.fn();
      const { options, respond, disconnectClientsUsingSharedGatewayAuth } =
        createConfigHandlerHarness({
          method,
          params: { raw: JSON.stringify(nextConfig), baseHash: "base-hash" },
          contextOverrides: { enforceSharedGatewayAuthGenerationForConfigWrite: enforceGeneration },
        });

      await expectDefined(configHandlers[method], method)(options);
      await flushConfigHandlerMicrotasks();

      expect(respond).toHaveBeenCalledWith(
        claimed || method === "config.set",
        claimed || method === "config.set" ? expect.objectContaining({ ok: true }) : undefined,
        claimed || method === "config.set"
          ? undefined
          : expect.objectContaining({ message: expect.stringContaining("unclaimed") }),
      );
      expect(enforceGeneration).toHaveBeenCalledTimes(claimed ? 0 : 1);
      expect(disconnectClientsUsingSharedGatewayAuth).toHaveBeenCalledTimes(
        !claimed && method !== "config.set" ? 1 : 0,
      );
      if (!claimed) {
        expect(enforceGeneration).toHaveBeenCalledWith(nextConfig, tokenAuthConfig("old-token"));
        expect(respond).toHaveBeenCalledBefore(enforceGeneration);
      }
    },
  );

  it("withholds config acknowledgement until its restart sentinel write settles", async () => {
    mockPreviousConfig(tokenAuthConfig("old-token"));
    const started = createDeferred();
    const release = createDeferred();
    restartSentinelMocks.writeRestartSentinel.mockImplementationOnce(async () => {
      started.resolve();
      await release.promise;
    });
    const { options, respond } = createConfigHandlerHarness({
      method: "config.apply",
      params: {
        raw: JSON.stringify(tokenAuthConfig("new-token")),
        baseHash: "base-hash",
        restartDelayMs: 1000,
      },
    });
    const handler = expectDefined(configHandlers["config.apply"], "config.apply handler");
    const operation = Promise.resolve(handler(options));
    try {
      await awaitGateBeforeSettlement(
        started.promise,
        operation,
        "Config did not reach sentinel persistence",
      );
      expect(respond).not.toHaveBeenCalled();
      expect(scheduleGatewayRestartMock).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await operation;
    }
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ ok: true, hash: "next-hash" }),
      undefined,
    );
  });

  it("accepts an unresolved isolatable TTS SecretRef and reports the cold owner", async () => {
    const submittedConfig: OpenClawConfig = {
      tts: {
        providers: {
          elevenlabs: {
            apiKey: { source: "env", provider: "default", id: "ELEVENLABS_API_KEY" },
          },
        },
      },
    };
    mockPreviousConfig({});
    prepareSecretsRuntimeSnapshotMock.mockResolvedValueOnce({
      config: submittedConfig,
      degradedOwners: [
        {
          ownerKind: "capability",
          ownerId: "tts",
          state: "unavailable",
          degradationState: "cold",
          paths: ["tts.providers.elevenlabs.apiKey"],
          refKeys: ["env:default:ELEVENLABS_API_KEY"],
          reason: "secret reference was not found",
        },
      ],
    });
    const { options, respond } = createConfigHandlerHarness({
      method: "config.set",
      params: {
        raw: JSON.stringify(submittedConfig),
        baseHash: "base-hash",
      },
    });

    await expectDefined(
      configHandlers["config.set"],
      'configHandlers["config.set"] test invariant',
    )(options);
    await flushConfigHandlerMicrotasks();

    expect(prepareSecretsRuntimeSnapshotMock).toHaveBeenCalledWith({
      config: submittedConfig,
      includeAuthStoreRefs: false,
      allowUnavailableSecretOwners: true,
    });
    expect(writeConfigFileMock).toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        degradedSecretOwners: [
          expect.objectContaining({
            ownerKind: "capability",
            ownerId: "tts",
            state: "cold",
            reason: "secret reference was not found",
          }),
        ],
      }),
      undefined,
    );
  });

  it.each(["secret provider policy denied resolution"])(
    "rejects non-retryable SecretRef degradation before config writes: %s",
    async (reason) => {
      const submittedConfig: OpenClawConfig = {
        tts: {
          providers: {
            elevenlabs: {
              apiKey: { source: "env", provider: "default", id: "ELEVENLABS_API_KEY" },
            },
          },
        },
      };
      mockPreviousConfig({});
      prepareSecretsRuntimeSnapshotMock.mockResolvedValueOnce({
        config: submittedConfig,
        degradedOwners: [
          {
            ownerKind: "capability",
            ownerId: "tts",
            state: "unavailable",
            degradationState: "cold",
            paths: ["tts.providers.elevenlabs.apiKey"],
            refKeys: ["env:default:ELEVENLABS_API_KEY"],
            reason,
          },
        ],
      });
      const { options, respond } = createConfigHandlerHarness({
        method: "config.set",
        params: {
          raw: JSON.stringify(submittedConfig),
          baseHash: "base-hash",
        },
      });

      await expectDefined(
        configHandlers["config.set"],
        'configHandlers["config.set"] test invariant',
      )(options);
      await flushConfigHandlerMicrotasks();

      expect(writeConfigFileMock).not.toHaveBeenCalled();
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ message: expect.stringContaining(reason) }),
      );
    },
  );

  it.each(["config.patch", "config.apply"] as const)(
    "%s hot-applies same-mode credentials and retains restart ownership for mode switches",
    async (method) => {
      for (const mode of ["token", "password"] as const) {
        for (const changesMode of [false, true]) {
          const previous = { gateway: { auth: { mode, [mode]: "old-credential" } } };
          const nextMode = changesMode ? (mode === "token" ? "password" : "token") : mode;
          const next = { gateway: { auth: { mode: nextMode, [nextMode]: "new-credential" } } };
          mockPreviousConfig(previous);
          const { options, respond, disconnectClientsUsingSharedGatewayAuth } =
            createConfigHandlerHarness({
              method,
              params: { baseHash: "base-hash", raw: JSON.stringify(next) },
            });

          await expectDefined(configHandlers[method], method)(options);
          await flushConfigHandlerMicrotasks();

          expect(respond).toHaveBeenCalledWith(
            true,
            expect.objectContaining({
              restart: undefined,
              sentinel: expect.objectContaining({
                payload: expect.objectContaining({
                  stats: expect.objectContaining({ requiresRestart: changesMode }),
                }),
              }),
            }),
            undefined,
          );
          expect(disconnectClientsUsingSharedGatewayAuth).toHaveBeenCalledTimes(
            changesMode ? 1 : 0,
          );
        }
      }
    },
  );

  it("leaves unclaimed trusted-proxy grant writes to per-client policy reconciliation", async () => {
    runtimeApplication.claimed = false;
    mockPreviousConfig(
      trustedProxyConfig({
        allowUsers: ["alice@example.com"],
        trustedProxies: ["127.0.0.1"],
      }),
    );

    const { disconnectClientsUsingSharedGatewayAuth } = await runConfigPatch(
      {
        gateway: {
          auth: {
            trustedProxy: {
              userHeader: "x-forwarded-user",
              allowUsers: ["bob@example.com"],
            },
          },
        },
      },
      { replacePaths: ["gateway.auth.trustedProxy.allowUsers"] },
    );

    expectNoDirectRestart();
    expect(disconnectClientsUsingSharedGatewayAuth).not.toHaveBeenCalled();
  });

  it("defers restart-required changes to the watcher after legacy hot mode normalizes", async () => {
    mockPreviousConfig(hotReloadConfig());

    await runConfigPatch({ gateway: { port: 19001 } });

    expectNoDirectRestart();
    expect(restartSentinelMocks.writeRestartSentinel).not.toHaveBeenCalled();
  });
});
