import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configFor, modelDefinition } from "../../agents/model-auth.fixtures.test-support.js";
import { ConfigMutationConflictError } from "../../config/mutation-conflict.js";
import { invalidateGatewayRuntimeConfigSchema } from "../../config/runtime-schema.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { resetPluginRuntimeStateForTest } from "../../plugins/runtime.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { invalidateConfigGetResponseCache } from "../config-get-response.js";
import {
  invokeConfigOpenFile,
  invokeConfigPatch,
  startConfigWrite,
} from "./config-invocations.test-support.js";
import { configHandlers } from "./config.js";
import { createConfigHandlerHarness, createConfigWriteSnapshot } from "./config.test-helpers.js";

const configWriteMocks = vi.hoisted(() => ({
  commitGatewayConfigWrite: vi.fn(),
  readConfigFileSnapshotForWrite: vi.fn(),
}));
const pluginValidationMocks = vi.hoisted(() => ({
  currentPluginMetadataSnapshot: undefined as PluginMetadataSnapshot | undefined,
}));

vi.mock("../../config/io.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/io.js")>()),
  readConfigFileSnapshotForWrite: configWriteMocks.readConfigFileSnapshotForWrite,
}));

// This suite owns config patch/merge behavior, while plugin validation is covered by
// config.plugin-validation.test.ts and validation.channel-metadata.test.ts.
vi.mock("../../config/validation.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config/validation.js")>();
  const resolveValidationParams = (
    params: Parameters<typeof actual.validateConfigObjectWithPlugins>[1],
  ) =>
    params?.pluginMetadataSnapshot || !pluginValidationMocks.currentPluginMetadataSnapshot
      ? params
      : {
          ...params,
          pluginMetadataSnapshot: pluginValidationMocks.currentPluginMetadataSnapshot,
        };
  const mockValidation = (validate: typeof actual.validateConfigObjectWithPlugins) =>
    vi.fn((config: OpenClawConfig, params: Parameters<typeof validate>[1]) =>
      pluginValidationMocks.currentPluginMetadataSnapshot
        ? validate(config, resolveValidationParams(params))
        : { ok: true, config, warnings: [] },
    );
  return {
    ...actual,
    validateConfigObjectRawWithPlugins: mockValidation(actual.validateConfigObjectRawWithPlugins),
    validateConfigObjectWithPlugins: mockValidation(actual.validateConfigObjectWithPlugins),
  };
});

// Secret materialization has dedicated runtime suites; keep these handler tests on
// their config-write boundary instead of loading every provider and plugin artifact.
vi.mock("../../secrets/runtime.js", () => ({
  prepareSecretsRuntimeSnapshot: vi.fn(async ({ config }: { config: OpenClawConfig }) => ({
    config,
  })),
}));

vi.mock("./config-write-flow.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./config-write-flow.js")>()),
  commitGatewayConfigWrite: configWriteMocks.commitGatewayConfigWrite,
  resolveGatewayConfigRestartWriteResult: vi.fn(async () => ({
    payload: { kind: "config-patch", mode: "config.patch", configPath: "/tmp/openclaw.json" },
    sentinelPersisted: false,
    restart: undefined,
  })),
}));

const { execOpenPathMock } = vi.hoisted(() => ({ execOpenPathMock: vi.fn() }));

vi.mock("./open-path.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./open-path.js")>()),
  execOpenPath: execOpenPathMock,
}));

vi.mock("../../config/runtime-schema.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/runtime-schema.js")>()),
  loadGatewayConfigRedactionHints: () => undefined,
  loadGatewayRuntimeConfigSchema: () => ({ schema: { type: "object" }, uiHints: undefined }),
}));

type Respond = ReturnType<typeof createConfigHandlerHarness>["respond"];
function expectSuccess(respond: Respond, payload: unknown = expect.anything()) {
  expect(respond).toHaveBeenCalledWith(true, payload, undefined);
}
function expectFailure(respond: Respond, message: unknown) {
  expect(respond).toHaveBeenCalledWith(false, undefined, expect.objectContaining({ message }));
}
const modelsPatch = (models: { id: string; name: string }[], provider = "custom") => ({
  models: { providers: { [provider]: { models } } },
});
const duplicateModels = [
  { id: "one", name: "First" },
  { id: "one", name: "Second" },
];
function seedCustomModel() {
  storedConfig = configFor("custom", "https://example.invalid", {
    models: [modelDefinition("one", { name: "One" })],
  });
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
    }: Parameters<typeof import("./config-write-flow.js").commitGatewayConfigWrite>[0]) => {
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
  invalidateGatewayRuntimeConfigSchema();
  invalidateConfigGetResponseCache();
  resetPluginRuntimeStateForTest();
  vi.clearAllMocks();
});

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

  expectSuccess(
    harness.respond,
    expect.objectContaining({
      changedPaths: expect.arrayContaining(["ui.prefs.sidebarEntries"]),
    }),
  );
  expectSuccess(
    harness.respond,
    expect.not.objectContaining({
      changedPaths: expect.arrayContaining([`plugins.entries.${pluginId}.config`]),
    }),
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
    expectSuccess(respond, expect.objectContaining({ changedPaths: expectedPaths }));
  },
);
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
    const message = expect.stringContaining(expectedMessage);
    expect(harness.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "UNAVAILABLE", message }),
    );
    const excludedMessages =
      outcome === "restart-pending"
        ? ["updated the active Gateway", "recovery restart", "reapply"]
        : ["was not applied", "reapply"];
    for (const excluded of excludedMessages) {
      expectFailure(harness.respond, expect.not.stringContaining(excluded));
    }
    expectFailure(harness.respond, expect.stringContaining("wait for the Gateway to restart"));
    expect(harness.respond).toHaveBeenCalledOnce();
    expect(queueFollowUp).toHaveBeenCalledOnce();
  },
);
describe("config.openFile", () => {
  it("opens the configured file without shell interpolation", async () => {
    await withEnvAsync({ OPENCLAW_CONFIG_PATH: "/tmp/config $(touch pwned).json" }, async () => {
      execOpenPathMock.mockImplementation(async (command: { command: string; args: string[] }) => {
        expect(["open", "xdg-open", "powershell.exe"]).toContain(command.command);
        expect(command.args).toEqual(["/tmp/config $(touch pwned).json"]);
        return { stdout: "", stderr: "" };
      });

      const { respond } = await invokeConfigOpenFile();

      expectSuccess(respond, { ok: true, path: "/tmp/config $(touch pwned).json" });
    });
  });

  it.runIf(process.platform === "linux")(
    "returns actionable headless environment error when xdg-open is missing",
    async () => {
      await withEnvAsync({ OPENCLAW_CONFIG_PATH: "/tmp/config.json" }, async () => {
        execOpenPathMock.mockRejectedValue(
          Object.assign(new Error("spawn xdg-open ENOENT"), { code: "ENOENT" }),
        );

        const { respond, logGateway } = await invokeConfigOpenFile();

        expectSuccess(respond, {
          ok: false,
          path: "/tmp/config.json",
          error:
            "Cannot open file in headless environment. File path: /tmp/config.json. This environment appears to lack a graphical or terminal browser handler.",
        });
        expect(logGateway.warn).toHaveBeenCalledWith(
          "config.openFile failed path=/tmp/config.json: spawn xdg-open ENOENT",
        );
      });
    },
  );

  it("does not split surrogate pairs when truncating the failed config path", async () => {
    const pathPrefix = `/tmp/${"a".repeat(111)}`;
    await withEnvAsync({ OPENCLAW_CONFIG_PATH: `${pathPrefix}😀tail.json` }, async () => {
      execOpenPathMock.mockRejectedValue(new Error("open failed"));

      const { logGateway } = await invokeConfigOpenFile();

      expect(logGateway.warn).toHaveBeenCalledWith(
        `config.openFile failed path=${pathPrefix}...: open failed`,
      );
    });
  });
});

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

    expectSuccess(harness.respond);
    expect(storedConfig).toStrictEqual({
      ...source,
      agents: { defaults: { params: method === "config.patch" ? {} : params } },
    });
  },
);
describe("config.patch hash-free ui.prefs LWW", () => {
  it("rejects a mixed hash-free patch and names the guarded path", async () => {
    const { respond } = await invokeConfigPatch({
      raw: { ui: { prefs: { theme: "knot" } }, gateway: { port: 19_001 } },
    });

    expectFailure(respond, expect.stringContaining("config base hash required for gateway.port"));
    expect(storedConfig).toEqual({});
  });

  it.each([
    { name: "ui.prefs deletion", raw: { ui: { prefs: null } } },
    { name: "ui deletion", raw: { ui: null } },
    { name: "scalar ui.prefs", raw: { ui: { prefs: "stale-container" } } },
  ])("rejects hash-free container operation: $name", async ({ raw }) => {
    storedConfig = { ui: { prefs: { theme: "claw" } } };

    const { respond } = await invokeConfigPatch({ raw });

    expectFailure(respond, expect.stringContaining("config base hash required"));
    expect(configWriteMocks.commitGatewayConfigWrite).not.toHaveBeenCalled();
  });

  it("allows a hash-free per-key null deletion below ui.prefs", async () => {
    storedConfig = { ui: { prefs: { chatFollowUpMode: "queue", theme: "claw" } } };

    const { respond } = await invokeConfigPatch({
      raw: { ui: { prefs: { chatFollowUpMode: null } } },
    });

    expectSuccess(respond, expect.objectContaining({ hash: "next-hash-1" }));
    expect(storedConfig.ui?.prefs).toEqual({ theme: "claw" });
  });

  it("keeps destructive array replacement explicit for hash-free patches", async () => {
    storedConfig = { ui: { prefs: { sidebarEntries: ["route:usage", "route:tasks"] } } };

    const rejected = await invokeConfigPatch({
      raw: { ui: { prefs: { sidebarEntries: ["route:usage"] } } },
    });
    expectFailure(
      rejected.respond,
      expect.stringContaining("config.patch would remove entries from array path(s)"),
    );

    const accepted = await invokeConfigPatch({
      raw: { ui: { prefs: { sidebarEntries: ["route:usage"] } } },
      replacePaths: ["ui.prefs.sidebarEntries"],
    });
    expectSuccess(accepted.respond, expect.objectContaining({ hash: "next-hash-1" }));
    expect(storedConfig.ui?.prefs?.sidebarEntries).toEqual(["route:usage"]);
  });

  it.each([true, false])("handles a config mutation conflict (retryable=%s)", async (retryable) => {
    configWriteMocks.commitGatewayConfigWrite.mockImplementationOnce(async () => {
      if (retryable) {
        storedConfig = { ui: { prefs: { locale: "de" } } };
        storedHash = "raced-hash";
        throw new ConfigMutationConflictError("config changed since last load");
      }
      throw new ConfigMutationConflictError("config path owned by another writer", {
        retryable: false,
      });
    });

    const { respond } = await invokeConfigPatch({
      raw: { ui: { prefs: { theme: "knot" } } },
    });

    expect(configWriteMocks.commitGatewayConfigWrite).toHaveBeenCalledOnce();
    expectFailure(
      respond,
      retryable
        ? expect.stringContaining("config changed since last load")
        : "config path owned by another writer",
    );
    if (retryable) {
      expect(storedConfig.ui?.prefs).toEqual({ locale: "de" });
    }
  });
});

it.each([false, true])(
  "requires explicit replacement of duplicate model IDs (replace=%s)",
  async (replace) => {
    seedCustomModel();
    const { respond } = await invokeConfigPatch({
      raw: modelsPatch(duplicateModels),
      baseHash: "base-hash",
      ...(replace ? { replacePaths: ["models.providers.custom.models"] } : {}),
    });
    if (!replace) {
      expectFailure(respond, expect.stringContaining("duplicate ID one"));
      expect(configWriteMocks.commitGatewayConfigWrite).not.toHaveBeenCalled();
      return;
    }
    expectSuccess(respond, expect.objectContaining({ ok: true, hash: "next-hash-1" }));
    expect(configWriteMocks.commitGatewayConfigWrite).toHaveBeenCalledOnce();

    const followUp = await invokeConfigPatch({
      raw: modelsPatch([{ id: "one", name: "Third" }]),
      baseHash: "next-hash-1",
    });

    expectFailure(
      followUp.respond,
      expect.stringContaining("current config contains duplicate ID one"),
    );
    expect(configWriteMocks.commitGatewayConfigWrite).toHaveBeenCalledOnce();
  },
);
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
  storedConfig = configFor("myproxy", "https://proxy.example/v1", {
    models: [
      modelDefinition("vendor/modern-model", {
        name: "Before",
        contextWindow: 200_000,
        reasoning: false,
      }),
    ],
  });

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
    raw: modelsPatch([{ id: "latest", name: "After" }], "myproxy"),
    baseHash: storedHash,
  });

  expectSuccess(harness.respond);
  expect(storedConfig.models?.providers?.myproxy?.models).toMatchObject([
    {
      id: "vendor/modern-model",
      name: "After",
    },
  ]);
});
