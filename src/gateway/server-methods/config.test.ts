/**
 * Tests for config gateway methods, writes, validation, and auth transitions.
 */

import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigMutationConflictError } from "../../config/mutation-conflict.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import { withEnvAsync } from "../../test-utils/env.js";
import {
  invokeConfigOpenFile,
  invokeConfigPatch,
  invokeConfigSchema,
  startConfigWrite,
} from "./config-invocations.test-support.js";
import { clearConfigSchemaResponseCacheForTests, configHandlers } from "./config.js";
import { createConfigHandlerHarness, createConfigWriteSnapshot } from "./config.test-helpers.js";

const configWriteMocks = vi.hoisted(() => ({
  commitGatewayConfigWrite: vi.fn(),
  readConfigFileSnapshotForWrite: vi.fn(),
}));
const pluginValidationMocks = vi.hoisted(() => ({
  currentPluginMetadataSnapshot: undefined as PluginMetadataSnapshot | undefined,
}));

vi.mock("../../config/io.js", async () => {
  const actual = await vi.importActual<typeof import("../../config/io.js")>("../../config/io.js");
  return {
    ...actual,
    readConfigFileSnapshotForWrite: configWriteMocks.readConfigFileSnapshotForWrite,
  };
});

// This suite owns config patch/merge behavior, while plugin validation is covered by
// config.plugin-validation.test.ts and validation.channel-metadata.test.ts.
vi.mock("../../config/validation.js", async () => {
  const actual = await vi.importActual<typeof import("../../config/validation.js")>(
    "../../config/validation.js",
  );
  const resolveValidationParams = (
    params: Parameters<typeof actual.validateConfigObjectWithPlugins>[1],
  ) =>
    params?.pluginMetadataSnapshot || !pluginValidationMocks.currentPluginMetadataSnapshot
      ? params
      : {
          ...params,
          pluginMetadataSnapshot: pluginValidationMocks.currentPluginMetadataSnapshot,
        };
  return {
    ...actual,
    validateConfigObjectRawWithPlugins: vi.fn(
      (
        config: OpenClawConfig,
        params: Parameters<typeof actual.validateConfigObjectWithPlugins>[1],
      ) =>
        pluginValidationMocks.currentPluginMetadataSnapshot
          ? actual.validateConfigObjectRawWithPlugins(config, resolveValidationParams(params))
          : { ok: true, config, warnings: [] },
    ),
    validateConfigObjectWithPlugins: vi.fn(
      (
        config: OpenClawConfig,
        params: Parameters<typeof actual.validateConfigObjectWithPlugins>[1],
      ) =>
        pluginValidationMocks.currentPluginMetadataSnapshot
          ? actual.validateConfigObjectWithPlugins(config, resolveValidationParams(params))
          : { ok: true, config, warnings: [] },
    ),
  };
});

// Secret materialization has dedicated runtime suites; keep these handler tests on
// their config-write boundary instead of loading every provider and plugin artifact.
vi.mock("../../secrets/runtime.js", () => ({
  prepareSecretsRuntimeSnapshot: vi.fn(async ({ config }: { config: OpenClawConfig }) => ({
    config,
  })),
}));

vi.mock("./config-write-flow.js", async () => {
  const actual =
    await vi.importActual<typeof import("./config-write-flow.js")>("./config-write-flow.js");
  return {
    ...actual,
    commitGatewayConfigWrite: configWriteMocks.commitGatewayConfigWrite,
    resolveGatewayConfigRestartWriteResult: vi.fn(async () => ({
      payload: { kind: "config-patch", mode: "config.patch", configPath: "/tmp/openclaw.json" },
      sentinelPersisted: false,
      restart: undefined,
    })),
  };
});

const { execOpenPathMock, loadGatewayRuntimeConfigSchemaMock } = vi.hoisted(() => ({
  execOpenPathMock: vi.fn(),
  loadGatewayRuntimeConfigSchemaMock: vi.fn(() => ({
    schema: { type: "object" },
    uiHints: undefined as Record<string, { advanced?: boolean }> | undefined,
    version: "test-schema",
  })),
}));

vi.mock("./open-path.js", async () => {
  const actual = await vi.importActual<typeof import("./open-path.js")>("./open-path.js");
  return { ...actual, execOpenPath: execOpenPathMock };
});

vi.mock("../../config/runtime-schema.js", () => ({
  loadGatewayRuntimeConfigSchema: loadGatewayRuntimeConfigSchemaMock,
}));

function mockOpenPathError(error: Error) {
  execOpenPathMock.mockRejectedValue(error);
}

let storedConfig: OpenClawConfig;
let storedHash: string;
let nextHash: number;
let modelNormalizationPluginMetadata: PluginMetadataSnapshot | undefined;

function currentWriteSnapshot() {
  const result = createConfigWriteSnapshot(storedConfig);
  result.snapshot.hash = storedHash;
  result.snapshot.raw = JSON.stringify(storedConfig);
  if (modelNormalizationPluginMetadata) {
    result.writeOptions = {
      basePluginMetadataSnapshot: modelNormalizationPluginMetadata,
    } as never;
  }
  return result;
}

beforeEach(() => {
  storedConfig = {};
  storedHash = "base-hash";
  nextHash = 1;
  modelNormalizationPluginMetadata = undefined;
  pluginValidationMocks.currentPluginMetadataSnapshot = undefined;
  configWriteMocks.readConfigFileSnapshotForWrite.mockImplementation(async () =>
    currentWriteSnapshot(),
  );
  configWriteMocks.commitGatewayConfigWrite.mockImplementation(
    async ({
      snapshot,
      nextConfig,
    }: {
      snapshot: { hash?: string };
      nextConfig: OpenClawConfig;
    }) => {
      if (snapshot.hash !== storedHash) {
        throw new ConfigMutationConflictError("config changed since last load");
      }
      storedConfig = nextConfig;
      storedHash = `next-hash-${nextHash}`;
      nextHash += 1;
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
  vi.useRealTimers();
  clearConfigSchemaResponseCacheForTests();
  resetPluginRuntimeStateForTest();
  vi.clearAllMocks();
});

describe("config.patch effective change receipt", () => {
  it("does not report plugin defaults discovered after the write snapshot", async () => {
    const pluginId = "defaulted-plugin";
    modelNormalizationPluginMetadata = createPluginMetadataSnapshotFixture();
    pluginValidationMocks.currentPluginMetadataSnapshot = createPluginMetadataSnapshotFixture({
      plugins: [
        {
          id: pluginId,
          configSchema: {
            type: "object",
            properties: { mode: { type: "string", default: "auto" } },
          },
        },
      ],
    });
    storedConfig = {
      plugins: { entries: { [pluginId]: { enabled: true } } },
      ui: { prefs: { sidebarEntries: ["route:usage"] } },
    };

    const harness = await invokeConfigPatch({
      raw: { ui: { prefs: { sidebarEntries: ["route:tasks"] } } },
      replacePaths: ["ui.prefs.sidebarEntries"],
    });

    expect(harness.respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        changedPaths: expect.arrayContaining(["ui.prefs.sidebarEntries"]),
      }),
      undefined,
    );
    expect(harness.respond).toHaveBeenCalledWith(
      true,
      expect.not.objectContaining({
        changedPaths: expect.arrayContaining([`plugins.entries.${pluginId}.config`]),
      }),
      undefined,
    );
  });

  it.each([
    { nextToken: "synthetic-old-token", expectedPaths: [] },
    {
      nextToken: "synthetic-new-token",
      expectedPaths: ["channels.matrix.accounts.sut.accessToken"],
    },
  ])(
    "reports persisted secret changes without values: $expectedPaths",
    async ({ nextToken, expectedPaths }) => {
      storedConfig = {
        channels: { matrix: { accounts: { sut: { accessToken: "synthetic-old-token" } } } },
      };
      const { respond } = await invokeConfigPatch({
        raw: { channels: { matrix: { accounts: { sut: { accessToken: nextToken } } } } },
        baseHash: "base-hash",
      });
      expect(respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({ changedPaths: expectedPaths }),
        undefined,
      );
    },
  );
});

describe("config application settlement", () => {
  it.each([
    { method: "config.patch", outcome: "applied-restart-required" },
    { method: "config.apply", outcome: "restart-pending" },
  ] as const)(
    "reports $method $outcome without misrepresenting active config",
    async ({ method, outcome }) => {
      const queueFollowUp = vi.fn();
      configWriteMocks.commitGatewayConfigWrite.mockResolvedValueOnce({
        path: "/tmp/openclaw.json",
        config: { hooks: { enabled: true } },
        hash: "restart-hash",
        application: Promise.resolve(outcome),
        queueFollowUp,
      });

      const { harness, operation } = startConfigWrite(method, {
        raw: { hooks: { enabled: true } },
        baseHash: "base-hash",
      });
      await operation;

      const expectedMessage =
        outcome === "restart-pending" ? "accepted for restart" : "updated the active Gateway";
      expect(harness.respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({
          code: "UNAVAILABLE",
          message: expect.stringContaining(expectedMessage),
        }),
      );
      const excludedMessages =
        outcome === "restart-pending"
          ? ["updated the active Gateway", "recovery restart", "reapply"]
          : ["was not applied", "reapply"];
      for (const excluded of excludedMessages) {
        expect(harness.respond).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({ message: expect.not.stringContaining(excluded) }),
        );
      }
      expect(harness.respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({
          message: expect.stringContaining("wait for the Gateway to restart"),
        }),
      );
      expect(harness.respond).toHaveBeenCalledOnce();
      expect(queueFollowUp).toHaveBeenCalledOnce();
    },
  );
});

describe("config.openFile", () => {
  it("opens the configured file without shell interpolation", async () => {
    await withEnvAsync({ OPENCLAW_CONFIG_PATH: "/tmp/config $(touch pwned).json" }, async () => {
      execOpenPathMock.mockImplementation(async (command: { command: string; args: string[] }) => {
        expect(["open", "xdg-open", "powershell.exe"]).toContain(command.command);
        expect(command.args).toEqual(["/tmp/config $(touch pwned).json"]);
        return { stdout: "", stderr: "" };
      });

      const { respond } = await invokeConfigOpenFile();

      expect(respond).toHaveBeenCalledWith(
        true,
        {
          ok: true,
          path: "/tmp/config $(touch pwned).json",
        },
        undefined,
      );
    });
  });

  it.runIf(process.platform === "linux")(
    "returns actionable headless environment error when xdg-open is missing",
    async () => {
      await withEnvAsync({ OPENCLAW_CONFIG_PATH: "/tmp/config.json" }, async () => {
        mockOpenPathError(Object.assign(new Error("spawn xdg-open ENOENT"), { code: "ENOENT" }));

        const { respond, logGateway } = await invokeConfigOpenFile();

        expect(respond).toHaveBeenCalledWith(
          true,
          {
            ok: false,
            path: "/tmp/config.json",
            error:
              "Cannot open file in headless environment. File path: /tmp/config.json. This environment appears to lack a graphical or terminal browser handler.",
          },
          undefined,
        );
        expect(logGateway.warn).toHaveBeenCalledWith(
          "config.openFile failed path=/tmp/config.json: spawn xdg-open ENOENT",
        );
      });
    },
  );

  it("does not split surrogate pairs when truncating the failed config path", async () => {
    const pathPrefix = `/tmp/${"a".repeat(111)}`;
    await withEnvAsync({ OPENCLAW_CONFIG_PATH: `${pathPrefix}😀tail.json` }, async () => {
      mockOpenPathError(new Error("open failed"));

      const { logGateway } = await invokeConfigOpenFile();

      expect(logGateway.warn).toHaveBeenCalledWith(
        `config.openFile failed path=${pathPrefix}...: open failed`,
      );
    });
  });
});

describe("config schema response cache", () => {
  it("rebuilds after config writes change schema inputs", async () => {
    await invokeConfigSchema();
    const patch = await invokeConfigPatch({ raw: { ui: { prefs: { theme: "knot" } } } });

    expect(patch.respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ ok: true }),
      undefined,
    );
    expect(loadGatewayRuntimeConfigSchemaMock).toHaveBeenCalledTimes(1);

    await invokeConfigSchema();

    expect(loadGatewayRuntimeConfigSchemaMock).toHaveBeenCalledTimes(2);
  });

  it("rebuilds when the active plugin registry generation changes", async () => {
    await invokeConfigSchema();
    setActivePluginRegistry(createTestRegistry([]));
    await invokeConfigSchema();

    expect(loadGatewayRuntimeConfigSchemaMock).toHaveBeenCalledTimes(2);
  });
});

describe("config write source preparation", () => {
  it.each(["config.set", "config.apply", "config.patch"] as const)(
    "%s distinguishes literal nulls from omitted values at its write boundary",
    async (method) => {
      const source: OpenClawConfig = {
        gateway: { port: 18789 },
        agents: { defaults: { params: { temperature: 0.2, topP: 0.8 } } },
      };
      const runtime: OpenClawConfig = {
        ...source,
        agents: { defaults: { ...source.agents?.defaults, maxConcurrent: 4 } },
      };
      storedConfig = source;
      configWriteMocks.readConfigFileSnapshotForWrite.mockImplementationOnce(async () => {
        const result = createConfigWriteSnapshot(source);
        result.snapshot.config = runtime;
        result.snapshot.runtimeConfig = runtime;
        return result;
      });
      const params = { temperature: null, nested: { value: null } };
      const harness = createConfigHandlerHarness({
        method,
        params: {
          raw: JSON.stringify(
            method === "config.patch"
              ? { agents: { defaults: { params: { temperature: null, topP: null } } } }
              : { ...runtime, agents: { defaults: { ...runtime.agents?.defaults, params } } },
          ),
          baseHash: storedHash,
        },
      });

      await expectDefined(configHandlers[method], "config write handler")(harness.options);

      expect(harness.respond).toHaveBeenCalledWith(true, expect.anything(), undefined);
      expect(storedConfig).toStrictEqual({
        ...source,
        agents: { defaults: { params: method === "config.patch" ? {} : params } },
      });
    },
  );
});

describe("config.patch hash-free ui.prefs LWW", () => {
  it("rejects a mixed hash-free patch and names the guarded path", async () => {
    const { respond } = await invokeConfigPatch({
      raw: { ui: { prefs: { theme: "knot" } }, gateway: { port: 19_001 } },
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      // The operator must see which path needs the base hash; a bare
      // "hash required" with no path was a dead-end error.
      expect.objectContaining({
        message: expect.stringContaining("config base hash required for gateway.port"),
      }),
    );
    expect(storedConfig).toEqual({});
  });

  it.each([
    { name: "ui.prefs deletion", raw: { ui: { prefs: null } } },
    { name: "ui deletion", raw: { ui: null } },
    { name: "scalar ui.prefs", raw: { ui: { prefs: "stale-container" } } },
  ])("rejects hash-free container operation: $name", async ({ raw }) => {
    storedConfig = { ui: { prefs: { theme: "claw" } } };

    const { respond } = await invokeConfigPatch({ raw });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: expect.stringContaining("config base hash required") }),
    );
    expect(configWriteMocks.commitGatewayConfigWrite).not.toHaveBeenCalled();
  });

  it("allows a hash-free per-key null deletion below ui.prefs", async () => {
    storedConfig = { ui: { prefs: { chatFollowUpMode: "queue", theme: "claw" } } };

    const { respond } = await invokeConfigPatch({
      raw: { ui: { prefs: { chatFollowUpMode: null } } },
    });

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ hash: "next-hash-1" }),
      undefined,
    );
    expect(storedConfig.ui?.prefs).toEqual({ theme: "claw" });
  });

  it("keeps destructive array replacement explicit for hash-free patches", async () => {
    storedConfig = { ui: { prefs: { sidebarEntries: ["route:usage", "route:tasks"] } } };

    const rejected = await invokeConfigPatch({
      raw: { ui: { prefs: { sidebarEntries: ["route:usage"] } } },
    });
    expect(rejected.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: expect.stringContaining("config.patch would remove entries from array path(s)"),
      }),
    );

    const accepted = await invokeConfigPatch({
      raw: { ui: { prefs: { sidebarEntries: ["route:usage"] } } },
      replacePaths: ["ui.prefs.sidebarEntries"],
    });
    expect(accepted.respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ hash: "next-hash-1" }),
      undefined,
    );
    expect(storedConfig.ui?.prefs?.sidebarEntries).toEqual(["route:usage"]);
  });

  it("surfaces a hash-free commit race without replaying stale intent", async () => {
    configWriteMocks.commitGatewayConfigWrite.mockImplementationOnce(async () => {
      storedConfig = { ui: { prefs: { locale: "de" } } };
      storedHash = "raced-hash";
      throw new ConfigMutationConflictError("config changed since last load");
    });

    const { respond } = await invokeConfigPatch({
      raw: { ui: { prefs: { theme: "knot" } } },
    });

    expect(configWriteMocks.commitGatewayConfigWrite).toHaveBeenCalledOnce();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: expect.stringContaining("config changed since last load"),
      }),
    );
    expect(storedConfig.ui?.prefs).toEqual({ locale: "de" });
  });

  it("advises retry only for retryable mutation conflicts", async () => {
    configWriteMocks.commitGatewayConfigWrite.mockImplementationOnce(async () => {
      throw new ConfigMutationConflictError("config path owned by another writer", {
        retryable: false,
      });
    });

    const { respond } = await invokeConfigPatch({
      raw: { ui: { prefs: { theme: "knot" } } },
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      // A non-retryable conflict fails the retry too; advising it is a dead end.
      expect.objectContaining({
        message: "config path owned by another writer",
      }),
    );
  });
});

describe("config.patch ID-keyed arrays", () => {
  it("rejects duplicate IDs before applying an ID-merged array patch", async () => {
    storedConfig = {
      models: {
        providers: {
          custom: {
            baseUrl: "https://example.invalid",
            models: [{ id: "one", name: "One" }],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const { respond } = await invokeConfigPatch({
      raw: {
        models: {
          providers: {
            custom: {
              models: [
                { id: "one", name: "First" },
                { id: "one", name: "Second" },
              ],
            },
          },
        },
      },
      baseHash: "base-hash",
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: expect.stringContaining("duplicate ID one") }),
    );
    expect(configWriteMocks.commitGatewayConfigWrite).not.toHaveBeenCalled();
  });

  it("allows duplicate IDs for an explicit array replacement", async () => {
    storedConfig = {
      models: {
        providers: {
          custom: {
            baseUrl: "https://example.invalid",
            models: [{ id: "one", name: "One" }],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const { respond } = await invokeConfigPatch({
      raw: {
        models: {
          providers: {
            custom: {
              models: [
                { id: "one", name: "First" },
                { id: "one", name: "Second" },
              ],
            },
          },
        },
      },
      baseHash: "base-hash",
      replacePaths: ["models.providers.custom.models"],
    });

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ ok: true, hash: "next-hash-1" }),
      undefined,
    );
    expect(configWriteMocks.commitGatewayConfigWrite).toHaveBeenCalledOnce();

    const followUp = await invokeConfigPatch({
      raw: {
        models: {
          providers: {
            custom: { models: [{ id: "one", name: "Third" }] },
          },
        },
      },
      baseHash: "next-hash-1",
    });

    expect(followUp.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: expect.stringContaining("current config contains duplicate ID one"),
      }),
    );
    expect(configWriteMocks.commitGatewayConfigWrite).toHaveBeenCalledOnce();
  });
});

describe("config.patch model input normalization", () => {
  it("uses write-snapshot policies before merging manifest-backed model IDs", async () => {
    modelNormalizationPluginMetadata = createPluginMetadataSnapshotFixture({
      plugins: [
        {
          id: "myproxy-normalizer",
          modelIdNormalization: {
            providers: {
              myproxy: { aliases: { latest: "modern-model" }, prefixWhenBare: "vendor" },
            },
          },
        },
      ],
    });
    storedConfig = {
      models: {
        providers: {
          myproxy: {
            baseUrl: "https://proxy.example/v1",
            models: [
              {
                id: "vendor/modern-model",
                name: "Before",
                contextWindow: 200_000,
                maxTokens: 8192,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                reasoning: false,
              },
            ],
          },
        },
      },
    };

    const sourceConfig = structuredClone(storedConfig);
    expectDefined(sourceConfig.models?.providers?.myproxy?.models[0], "source model").id = "latest";
    configWriteMocks.readConfigFileSnapshotForWrite.mockImplementationOnce(async () => {
      const result = currentWriteSnapshot();
      result.snapshot.sourceConfig = sourceConfig;
      result.snapshot.resolved = sourceConfig;
      result.snapshot.parsed = sourceConfig;
      result.snapshot.raw = JSON.stringify(sourceConfig);
      return result;
    });

    const harness = await invokeConfigPatch({
      raw: {
        models: {
          providers: {
            myproxy: { models: [{ id: "latest", name: "After" }] },
          },
        },
      },
      baseHash: storedHash,
    });

    expect(harness.respond).toHaveBeenCalledWith(true, expect.anything(), undefined);
    expect(storedConfig.models?.providers?.myproxy?.models).toHaveLength(1);
    expect(storedConfig.models?.providers?.myproxy?.models?.[0]).toMatchObject({
      id: "vendor/modern-model",
      name: "After",
    });
  });
});
