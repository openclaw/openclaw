import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveConfigEnvVars } from "../../config/env-substitution.js";
import { coerceConfig } from "../../config/io.read-helpers.js";
import { REDACTED_SENTINEL } from "../../config/redact-sentinel.js";
import { resolveConfigSecretRef } from "../../config/resolution-facts.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { clearConfigSchemaResponseCacheForTests, configHandlers } from "./config.js";
import { createConfigHandlerHarness, createConfigWriteSnapshot } from "./config.test-helpers.js";

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  commit: vi.fn(),
  validate: vi.fn(),
  prepareSecrets: vi.fn(),
}));

vi.mock("../../config/io.js", async () => ({
  ...(await vi.importActual<typeof import("../../config/io.js")>("../../config/io.js")),
  readConfigFileSnapshotForWrite: mocks.read,
}));

// Exercise reference preparation and the registered handler without loading provider plugins.
vi.mock("../../config/validation.js", async () => ({
  ...(await vi.importActual<typeof import("../../config/validation.js")>(
    "../../config/validation.js",
  )),
  validateConfigObjectRawWithPlugins: mocks.validate,
  validateConfigObjectWithPlugins: mocks.validate,
}));

vi.mock("../../secrets/runtime.js", () => ({
  prepareSecretsRuntimeSnapshot: mocks.prepareSecrets,
}));

vi.mock("../../config/runtime-schema.js", () => ({
  loadGatewayRuntimeConfigSchema: () => ({
    schema: { type: "object" },
    uiHints: { "gateway.auth.token": { sensitive: true } },
    version: "test-schema",
  }),
}));

vi.mock("./config-write-flow.js", async () => ({
  ...(await vi.importActual<typeof import("./config-write-flow.js")>("./config-write-flow.js")),
  commitGatewayConfigWrite: mocks.commit,
  resolveGatewayConfigRestartWriteResult: vi.fn(async () => ({
    payload: { kind: "config-patch", mode: "config.patch", configPath: "/tmp/openclaw.json" },
    sentinelPersisted: false,
    restart: undefined,
  })),
}));

const env = {
  CONFIG_PATCH_VALUE: "/opt/test-browser",
  CONFIG_PATCH_MODEL: " openai/gpt-4.1 ",
};
const reference = "${CONFIG_PATCH_VALUE}";
const escaped = "$${CONFIG_PATCH_VALUE}";

function mockAuthoredConfig(authoredConfig: OpenClawConfig) {
  const sourceConfig = coerceConfig(resolveConfigEnvVars(authoredConfig, env));
  const { snapshot } = createConfigWriteSnapshot(sourceConfig);
  mocks.read.mockResolvedValue({
    snapshot: {
      ...snapshot,
      raw: JSON.stringify(authoredConfig),
      parsed: authoredConfig,
      authoredConfig,
      sourceConfigBeforeMigrations: sourceConfig,
    },
    writeOptions: { expectedConfigPath: snapshot.path, envSnapshotForRestore: env },
  });
}

async function patch(raw: unknown) {
  const harness = createConfigHandlerHarness({
    method: "config.patch",
    params: { baseHash: "base-hash", raw: JSON.stringify(raw) },
  });
  await withEnvAsync(env, async () =>
    expectDefined(configHandlers["config.patch"], "config.patch handler")(harness.options),
  );
  return harness;
}

beforeEach(() => {
  mocks.validate.mockImplementation((config: OpenClawConfig) => ({
    ok: true,
    config,
    warnings: [],
  }));
  mocks.prepareSecrets.mockImplementation(async ({ config }: { config: OpenClawConfig }) => ({
    config,
  }));
  mocks.commit.mockImplementation(async ({ nextConfig }: { nextConfig: OpenClawConfig }) => ({
    path: "/tmp/openclaw.json",
    config: nextConfig,
    hash: "next-hash",
    queueFollowUp: vi.fn(),
  }));
});

afterEach(() => {
  clearConfigSchemaResponseCacheForTests();
  vi.clearAllMocks();
});

describe("config.patch reference intent", () => {
  it("activates an explicitly supplied reference without activating an untouched sibling", async () => {
    mockAuthoredConfig({
      browser: { executablePath: escaped },
      messages: { responsePrefix: escaped },
    });

    const { respond } = await patch({ browser: { executablePath: reference } });

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ hash: "next-hash" }),
      undefined,
    );
    expect(mocks.commit).toHaveBeenCalledWith(
      expect.objectContaining({
        nextConfig: {
          browser: { executablePath: reference },
          messages: { responsePrefix: escaped },
        },
        writeOptions: expect.objectContaining({
          explicitSetPaths: [["browser", "executablePath"]],
        }),
      }),
    );
    const resolvedConfig = {
      browser: { executablePath: env.CONFIG_PATCH_VALUE },
      messages: { responsePrefix: reference },
    };
    expect(mocks.validate).toHaveBeenNthCalledWith(1, resolvedConfig);
    expect(mocks.validate).toHaveBeenNthCalledWith(2, resolvedConfig);
    expect(mocks.prepareSecrets).toHaveBeenCalledWith(
      expect.objectContaining({ config: resolvedConfig }),
    );
  });

  it("maps an ID-keyed patch to its destination without activating the same reference on another row", async () => {
    const model = (id: string) => ({
      id,
      name: escaped,
      reasoning: false,
      input: ["text" as const],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      maxTokens: 100,
    });
    mockAuthoredConfig({
      models: {
        providers: {
          custom: { baseUrl: "https://example.invalid", models: [model("first"), model("second")] },
        },
      },
    });

    await patch({
      models: { providers: { custom: { models: [{ id: "second", name: reference }] } } },
    });

    expect(mocks.commit).toHaveBeenCalledWith(
      expect.objectContaining({
        nextConfig: {
          models: {
            providers: {
              custom: {
                baseUrl: "https://example.invalid",
                models: [model("first"), { ...model("second"), name: reference }],
              },
            },
          },
        },
        writeOptions: expect.objectContaining({
          explicitSetPaths: [["models", "providers", "custom", "models", "1", "name"]],
        }),
      }),
    );
    expect(mocks.prepareSecrets).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          models: {
            providers: {
              custom: {
                baseUrl: "https://example.invalid",
                models: [
                  { ...model("first"), name: reference },
                  { ...model("second"), name: env.CONFIG_PATCH_VALUE },
                ],
              },
            },
          },
        }),
      }),
    );
  });

  it("does not treat a restored redacted value as an explicitly supplied reference", async () => {
    mockAuthoredConfig({
      browser: { executablePath: escaped },
      gateway: { auth: { mode: "token", token: escaped } },
    });

    await patch({
      browser: { executablePath: reference },
      gateway: { auth: { token: REDACTED_SENTINEL } },
    });

    expect(mocks.commit).toHaveBeenCalledWith(
      expect.objectContaining({
        nextConfig: {
          browser: { executablePath: reference },
          gateway: { auth: { mode: "token", token: escaped } },
        },
        writeOptions: expect.objectContaining({
          explicitSetPaths: [["browser", "executablePath"]],
        }),
      }),
    );
    expect(mocks.prepareSecrets).toHaveBeenCalledWith(
      expect.objectContaining({
        config: {
          browser: { executablePath: env.CONFIG_PATCH_VALUE },
          gateway: { auth: { mode: "token", token: reference } },
        },
      }),
    );
  });

  it("keeps an equal literal patch a noop instead of replacing its environment reference", async () => {
    mockAuthoredConfig({ browser: { executablePath: reference } });

    const { respond } = await patch({ browser: { executablePath: env.CONFIG_PATCH_VALUE } });

    expect(respond).toHaveBeenCalledWith(true, expect.objectContaining({ noop: true }), undefined);
    expect(mocks.commit).not.toHaveBeenCalled();
  });

  it("keeps decoded literals when normalizing a reference-supplied model", async () => {
    mockAuthoredConfig({
      agents: { defaults: { model: "$${CONFIG_PATCH_MODEL}" } },
      gateway: { auth: { mode: "token", token: escaped } },
    });
    let preflightConfig: OpenClawConfig | undefined;
    mocks.prepareSecrets.mockImplementation(async ({ config }: { config: OpenClawConfig }) => {
      preflightConfig = config;
      return { config };
    });

    await patch({ agents: { defaults: { model: "${CONFIG_PATCH_MODEL}" } } });

    const config = expectDefined(preflightConfig, "prepared config");
    expect(config.agents?.defaults?.model).toBe("openai/gpt-4.1");
    expect(config.gateway?.auth?.token).toBe(reference);
    expect(
      resolveConfigSecretRef({
        config,
        path: "gateway.auth.token",
        value: config.gateway?.auth?.token,
      }),
    ).toBeNull();
  });

  it("retains null deletion while preparing an explicitly supplied reference", async () => {
    mockAuthoredConfig({
      browser: { executablePath: escaped },
      messages: { responsePrefix: escaped },
    });

    await patch({ browser: { executablePath: reference }, messages: { responsePrefix: null } });

    expect(mocks.commit).toHaveBeenCalledWith(
      expect.objectContaining({
        nextConfig: { browser: { executablePath: reference }, messages: {} },
        writeOptions: expect.objectContaining({
          explicitSetPaths: [["browser", "executablePath"]],
        }),
      }),
    );
  });
});
