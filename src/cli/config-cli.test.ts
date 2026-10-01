import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
// Config CLI tests cover config command registration, reads, writes, and output modes.
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { ConfigMutationConflictError } from "../config/mutation-conflict.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../config/types.js";
import {
  createPluginManifestRecordFixture as createPluginManifestRecord,
  createPluginMetadataSnapshotFixture as createPluginMetadataSnapshot,
} from "../plugins/plugin-metadata.test-support.js";
import { registerConfigJsonOutputTests } from "./config-cli.json-output.test-support.js";
import {
  readConfigCliSnapshotWithMetadata,
  type ConfigCliSnapshotReader,
  type ConfigCliWriter,
} from "./config-cli.snapshot.test-support.js";
import type { ConfigSetDryRunResult } from "./config-set-dryrun.js";
import { applyCliProfileEnv } from "./profile.js";

// The metadata fixture can reach the runtime mock before ordinary imports finish.
const { defaultRuntime, resetRuntimeCapture, mockRuntimeModule } = await vi.hoisted(async () => {
  const runtimeHelpers = await import("./test-runtime-capture.js");
  return {
    ...runtimeHelpers.createCliRuntimeCapture(),
    mockRuntimeModule: runtimeHelpers.mockRuntimeModule,
  };
});

const mockReadConfigFileSnapshot = vi.fn<ConfigCliSnapshotReader>();
const mockWriteConfigFile = vi.fn<ConfigCliWriter>(async () => {});
const mockResolveSecretRefValue = vi.fn();
const mockCheckTouchedTextModelRefs = vi.fn();
const mockReadBestEffortRuntimeConfigSchema = vi.fn();
const mockLoadPluginMetadataSnapshot = vi.fn((_configForTest: unknown) =>
  createPluginMetadataSnapshot(),
);
const mockLoadChannelSecretContractApi = vi.hoisted(() =>
  vi.fn(({ channelId }: { channelId: string }) => {
    const fields: Record<string, readonly string[]> = {
      discord: ["token"],
      slack: ["appToken", "botToken"],
      telegram: ["botToken"],
    };
    return {
      secretTargetRegistryEntries: [
        ...(fields[channelId] ?? []).map((field) => {
          const pathPattern = `channels.${channelId}.${field}`;
          return {
            id: pathPattern,
            targetType: pathPattern,
            configFile: "openclaw.json" as const,
            pathPattern,
            secretShape: "secret_input" as const,
            expectedResolvedValue: "string" as const,
            includeInPlan: true,
            includeInConfigure: true,
            includeInAudit: true,
          };
        }),
        ...(channelId === "discord"
          ? [
              {
                id: "channels.discord.accounts[].token",
                targetType: "channels.discord.accounts[].token",
                configFile: "openclaw.json" as const,
                pathPattern: "channels.discord.accounts[].token",
                refPathPattern: "channels.discord.accounts[].tokenRef",
                secretShape: "sibling_ref" as const,
                expectedResolvedValue: "string" as const,
                includeInPlan: true,
                includeInConfigure: true,
                includeInAudit: true,
              },
            ]
          : []),
      ],
    };
  }),
);

vi.mock("../config/config.js", () => ({
  readConfigFileSnapshot: (...args: Parameters<typeof mockReadConfigFileSnapshot>) =>
    mockReadConfigFileSnapshot(...args),
  readConfigFileSnapshotWithPluginMetadata: async (
    ...args: Parameters<typeof mockReadConfigFileSnapshot>
  ) => readConfigCliSnapshotWithMetadata(mockReadConfigFileSnapshot, ...args),
  readConfigFileSnapshotForWrite: async () => ({
    snapshot: await mockReadConfigFileSnapshot(),
    writeOptions: {},
  }),
  writeConfigFile: (...args: Parameters<ConfigCliWriter>) => mockWriteConfigFile(...args),
  replaceConfigFile: (params: {
    sourceConfig: OpenClawConfig;
    writeOptions?: {
      auditOrigin?: "cli";
      unsetPaths?: string[][];
      explicitSetPaths?: string[][];
      assertConfigPathForWrite?: () => void;
    };
  }) => {
    params.writeOptions?.assertConfigPathForWrite?.();
    return mockWriteConfigFile(params.sourceConfig, params.writeOptions);
  },
}));

vi.mock("../secrets/resolve.js", () => ({
  resolveSecretRefValue: (...args: unknown[]) => mockResolveSecretRefValue(...args),
}));

vi.mock("../config/runtime-schema.js", () => ({
  readBestEffortRuntimeConfigSchema: () => mockReadBestEffortRuntimeConfigSchema(),
}));

vi.mock("./config-model-validation.js", () => ({
  checkTouchedTextModelRefs: (...args: unknown[]) => mockCheckTouchedTextModelRefs(...args),
}));

vi.mock("../gateway/config-reload-plan.js", () => ({
  buildGatewayReloadPlan: (changedPaths: string[]) => {
    const hotReasons = changedPaths.filter(
      (changedPath) =>
        changedPath.startsWith("agents.entries.") ||
        changedPath.startsWith("agents.defaults.models.") ||
        changedPath.startsWith("models.") ||
        changedPath === "plugins" ||
        changedPath.startsWith("plugins."),
    );
    const restartReasons = changedPaths.filter((changedPath) => !hotReasons.includes(changedPath));
    return {
      changedPaths,
      restartGateway: restartReasons.length > 0,
      restartReasons,
      hotReasons,
      reloadHooks: false,
      restartGmailWatcher: false,
      restartCron: false,
      restartHeartbeat: hotReasons.length > 0,
      reloadPlugins: false,
      restartChannels: new Set(),
      disposeMcpRuntimes: false,
      noopPaths: [],
    };
  },
}));

vi.mock("../plugins/plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/plugin-metadata-snapshot.js")>()),
  loadPluginMetadataSnapshot: (config: unknown) => mockLoadPluginMetadataSnapshot(config),
  resolvePluginMetadataSnapshot: (params: { config?: unknown }) =>
    mockLoadPluginMetadataSnapshot(params.config),
}));

vi.mock("../plugins/bundled-plugin-metadata.js", () => ({
  listBundledPluginMetadata: () => [],
}));

vi.mock("../secrets/channel-contract-api.js", () => ({
  loadChannelSecretContractApi: mockLoadChannelSecretContractApi,
  loadChannelSecretContractApiForRecord: () => undefined,
}));

const mockLog = defaultRuntime.log;
const mockWriteStdout = defaultRuntime.writeStdout;
const mockError = defaultRuntime.error;
const mockExit = defaultRuntime.exit;

vi.mock("../runtime.js", async () => {
  return mockRuntimeModule(
    () => vi.importActual<typeof import("../runtime.js")>("../runtime.js"),
    defaultRuntime,
  );
});

function buildSnapshot(params: {
  resolved: OpenClawConfig;
  config: OpenClawConfig;
}): ConfigFileSnapshot {
  return {
    path: "/tmp/openclaw.json",
    exists: true,
    raw: JSON.stringify(params.resolved),
    parsed: params.resolved,
    sourceConfig: params.resolved,
    resolved: params.resolved,
    valid: true,
    runtimeConfig: params.config,
    config: params.config,
    issues: [],
    warnings: [],
    legacyIssues: [],
  };
}

function setSnapshot(resolved: OpenClawConfig, config: OpenClawConfig) {
  mockReadConfigFileSnapshot.mockResolvedValue(buildSnapshot({ resolved, config }));
}

function setGatewaySnapshot(secrets?: OpenClawConfig["secrets"]): void {
  const resolved: OpenClawConfig = {
    gateway: { port: 18789 },
    ...(secrets ? { secrets } : {}),
  };
  setSnapshot(resolved, resolved);
}

function setSnapshotOnce(snapshot: ConfigFileSnapshot) {
  mockReadConfigFileSnapshot.mockResolvedValueOnce(snapshot);
}

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function writeTempJson5File(prefix: string, value: unknown): string {
  const pathname = path.join(tempDirs.make(prefix), "patch.json5");
  fs.writeFileSync(pathname, JSON.stringify(value), "utf8");
  return pathname;
}

function writeSecurePluginEntrypoint(pathname: string, contents: string): void {
  fs.writeFileSync(pathname, contents, "utf8");
  fs.chmodSync(pathname, 0o644);
}

function withRuntimeDefaults(resolved: OpenClawConfig): OpenClawConfig {
  return {
    ...resolved,
    agents: {
      ...resolved.agents,
      defaults: {
        model: "gpt-5.4",
      } as never,
    } as never,
  };
}

function makeInvalidSnapshot(params: {
  issues: ConfigFileSnapshot["issues"];
  warnings?: ConfigFileSnapshot["warnings"];
}): ConfigFileSnapshot {
  return {
    ...buildSnapshot({ resolved: {}, config: {} }),
    path: "/tmp/custom-openclaw.json",
    valid: false,
    warnings: [],
    ...params,
  };
}

function firstMockArg(mock: { mock: { calls: ReadonlyArray<ReadonlyArray<unknown>> } }): unknown {
  const call = mock.mock.calls[0];
  if (!call) {
    throw new Error("expected mock to have at least one call");
  }
  return call[0];
}

function lastMockArg(mock: { mock: { calls: ReadonlyArray<ReadonlyArray<unknown>> } }): unknown {
  const calls = mock.mock.calls;
  const call = calls[calls.length - 1];
  if (!call) {
    throw new Error("expected mock to have at least one call");
  }
  return call[0];
}

function parseLastLogPayload(): unknown {
  const raw = lastMockArg(mockLog);
  expect(typeof raw).toBe("string");
  return JSON.parse(String(raw)) as unknown;
}

async function runValidateJsonAndGetPayload() {
  await expect(runConfigCommand(["config", "validate", "--json"])).rejects.toThrow(ExitError);
  const raw = firstMockArg(mockLog);
  expect(typeof raw).toBe("string");
  return JSON.parse(String(raw)) as {
    valid: boolean;
    path: string;
    issues: Array<{
      path: string;
      message: string;
      allowedValues?: string[];
      allowedValuesHiddenCount?: number;
    }>;
  };
}

function firstWrittenConfig(): OpenClawConfig {
  const written = firstMockArg(mockWriteConfigFile);
  if (!written) {
    throw new Error("expected written config");
  }
  return written as OpenClawConfig;
}

function firstWriteConfigOptions(): Parameters<ConfigCliWriter>[1] {
  return mockWriteConfigFile.mock.calls[0]?.[1];
}

function requireWriteOptions(): NonNullable<Parameters<ConfigCliWriter>[1]> {
  const options = firstWriteConfigOptions();
  if (!options) {
    throw new Error("expected write options");
  }
  return options;
}

function expectLogIncludes(text: string) {
  expect(mockLog.mock.calls.map((call) => String(call[0])).join("\n")).toContain(text);
}

function expectLogExcludes(text: string) {
  expect(mockLog.mock.calls.map((call) => String(call[0])).join("\n")).not.toContain(text);
}

function expectErrorIncludes(text: string) {
  expect(mockError.mock.calls.map((call) => String(call[0])).join("\n")).toContain(text);
}

const requireRecord = createRequireRecord("record", "expected-label-object");

function requireResolveSecretRefCall(index: number): [unknown, unknown] {
  const call = mockResolveSecretRefValue.mock.calls[index];
  if (!call) {
    throw new Error(`expected SecretRef resolver call ${index}`);
  }
  return call as [unknown, unknown];
}

let registerConfigCli: typeof import("./config-cli.js").registerConfigCli;
let sharedProgram: Command;

async function runConfigCommand(args: string[]) {
  await sharedProgram.parseAsync(args, { from: "user" });
}

function runConfigSet(...args: string[]) {
  return runConfigCommand(["config", "set", ...args]);
}

function runDiscordRef(provider: string, source: string, id: string, ...options: string[]) {
  return runConfigSet(
    "channels.discord.token",
    "--ref-provider",
    provider,
    "--ref-source",
    source,
    "--ref-id",
    id,
    ...options,
  );
}

let ExitError: new (code: number, message?: string) => Error;

describe("config cli", () => {
  beforeAll(async () => {
    ({ registerConfigCli } = await import("./config-cli.js"));
    sharedProgram = new Command();
    sharedProgram.exitOverride();
    registerConfigCli(sharedProgram);
    const actual = await vi.importActual<typeof import("../runtime.js")>("../runtime.js");
    ExitError = actual.ExitError;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockReadConfigFileSnapshot.mockReset();
    mockReadConfigFileSnapshot.mockResolvedValue(buildSnapshot({ resolved: {}, config: {} }));
    resetRuntimeCapture();
    mockLoadPluginMetadataSnapshot.mockReturnValue(createPluginMetadataSnapshot());
    mockReadBestEffortRuntimeConfigSchema.mockResolvedValue({
      schema: {
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object",
        properties: {
          channels: {
            type: "object",
            properties: {
              telegram: {
                type: "object",
                properties: {
                  token: { type: "string" },
                },
              },
            },
          },
          plugins: {
            type: "object",
            properties: {
              entries: {
                type: "object",
              },
            },
          },
        },
      },
      uiHints: {},
      version: "test",
      generatedAt: "2026-03-25T00:00:00.000Z",
    });
    mockExit.mockImplementation((code: number) => {
      const errorMessages = mockError.mock.calls.map((call) => call.join(" ")).join("; ");
      throw new ExitError(code, errorMessages || undefined);
    });
    mockResolveSecretRefValue.mockResolvedValue("resolved-secret");
    mockCheckTouchedTextModelRefs.mockResolvedValue({ refsChecked: 0, refsTotal: 0, errors: [] });
  });

  describe("config mutations", () => {
    it("reports model resolver setup failures as incomplete dry-run JSON", async () => {
      const resolved: OpenClawConfig = {
        agents: { defaults: { model: { primary: "openai/gpt-5.4-mini" } } },
      };
      setSnapshot(resolved, resolved);
      mockCheckTouchedTextModelRefs.mockResolvedValueOnce({
        refsChecked: 0,
        refsTotal: 1,
        errors: ["Unable to validate changed model references before writing: catalog unavailable"],
      });

      await expect(
        runConfigSet(
          "agents.defaults.model.primary",
          '"openai/gpt-5.4-mini"',
          "--dry-run",
          "--json",
        ),
      ).rejects.toThrow(ExitError);

      expect(mockWriteConfigFile).not.toHaveBeenCalled();
      const payload = parseLastLogPayload() as ConfigSetDryRunResult;
      expect(payload).toMatchObject({
        ok: false,
        checks: { resolvability: true, resolvabilityComplete: false },
        refsChecked: 0,
        errors: [{ kind: "model", message: expect.stringContaining("catalog unavailable") }],
      });
    });

    it("rejects plugin install record config updates", async () => {
      await expect(
        runConfigSet(
          'plugins.installs["openclaw-web-search"].spec',
          '"@ollama/openclaw-web-search@0.2.2"',
          "--strict-json",
          "--dry-run",
        ),
      ).rejects.toThrow(ExitError);

      expect(mockWriteConfigFile).not.toHaveBeenCalled();
      expectErrorIncludes("openclaw plugins install <spec>");
      expectErrorIncludes("openclaw plugins update <plugin-id>");
    });

    it("rejects auto-managed meta.lastTouchedVersion config updates (#80849)", async () => {
      await expect(
        runConfigSet("meta.lastTouchedVersion", "BOGUS-NOT-A-VERSION", "--dry-run"),
      ).rejects.toThrow(ExitError);

      expect(mockWriteConfigFile).not.toHaveBeenCalled();
      expectErrorIncludes("meta.lastTouchedVersion");
      expectErrorIncludes("auto-managed");
    });

    it("rejects parent meta path mutations when payload merges an auto-managed child (#80849)", async () => {
      await expect(
        runConfigSet(
          "meta",
          '{"lastTouchedVersion":"BOGUS-NOT-A-VERSION"}',
          "--strict-json",
          "--merge",
          "--dry-run",
        ),
      ).rejects.toThrow(ExitError);

      expect(mockWriteConfigFile).not.toHaveBeenCalled();
      expectErrorIncludes("meta.lastTouchedVersion");
      expectErrorIncludes("auto-managed");
    });

    it("rejects parent meta path replacement that would clobber auto-managed children (#80849)", async () => {
      await expect(
        runConfigSet(
          "meta",
          '{"lastTouchedVersion":"BOGUS-NOT-A-VERSION"}',
          "--strict-json",
          "--replace",
          "--dry-run",
        ),
      ).rejects.toThrow(ExitError);

      expect(mockWriteConfigFile).not.toHaveBeenCalled();
      expectErrorIncludes("meta.lastTouchedVersion");
      expectErrorIncludes("auto-managed");
    });

    it("rejects config unset meta because deleting the parent removes auto-managed children (#80849)", async () => {
      await expect(runConfigCommand(["config", "unset", "meta"])).rejects.toThrow(ExitError);

      expect(mockWriteConfigFile).not.toHaveBeenCalled();
      expectErrorIncludes("meta.lastTouchedVersion");
      expectErrorIncludes("auto-managed");
    });

    it("does not auto-managed-reject parent meta merges that leave the managed children alone (#80849)", async () => {
      // The merge payload only references a non-auto-managed key; the auto-managed
      // guard MUST NOT fire — otherwise a future schema-valid sibling of
      // meta.lastTouched* would be collateral-rejected. Downstream layers (schema
      // validator, etc.) may still legitimately reject this; we only care that the
      // rejection was NOT from our auto-managed guard.
      setSnapshot({}, {});
      try {
        await runConfigSet("meta", '{"unrelated":"x"}', "--strict-json", "--merge", "--dry-run");
      } catch {
        // Tolerated: any downstream rejection. Inspected below.
      }
      const errorMessages = mockError.mock.calls.map((call) => String(call[0])).join("\n");
      expect(errorMessages).not.toContain("auto-managed");
    });

    it("rejects protected model map replacement unless explicitly requested", async () => {
      const resolved: OpenClawConfig = {
        agents: {
          defaults: {
            models: {
              "openai/gpt-5.4": { alias: "GPT" },
              "anthropic/claude-sonnet-4-6": { alias: "Sonnet" },
            },
          },
        },
      };
      setSnapshot(resolved, resolved);

      await expect(
        runConfigSet("agents.defaults.models", '{"openai/gpt-5.4":{}}', "--strict-json"),
      ).rejects.toThrow(ExitError);

      expect(mockWriteConfigFile).not.toHaveBeenCalled();
      expectErrorIncludes("Refusing to replace agents.defaults.models");
    });

    it.each([
      {
        label: "the model list",
        path: "models.providers.ollama.models",
        value: '[{"id":"llama3.2","name":"Llama 3.2 latest"},{"id":"gemma4","name":"Gemma 4"}]',
      },
      {
        label: "an ancestor object",
        path: "models",
        value:
          '{"providers":{"ollama":{"models":[{"id":"llama3.2","name":"Llama 3.2 latest"},{"id":"gemma4","name":"Gemma 4"}]}}}',
      },
    ])(
      "merges provider model arrays by id through $label with --merge",
      async ({ path: configPath, value }) => {
        const resolved = {
          models: {
            providers: {
              ollama: {
                api: "ollama",
                models: [
                  { id: "llama3.2", name: "Llama 3.2", contextWindow: 131072 },
                  { id: "qwen3", name: "Qwen 3" },
                ],
              },
            },
          },
        } as unknown as OpenClawConfig;
        setSnapshot(resolved, resolved);

        await runConfigSet(configPath, value, "--strict-json", "--merge");

        expect(mockWriteConfigFile).toHaveBeenCalledTimes(1);
        const written = firstWrittenConfig();
        expect(written.models?.providers?.ollama?.models).toEqual([
          { id: "llama3.2", name: "Llama 3.2 latest", contextWindow: 131072 },
          { id: "qwen3", name: "Qwen 3" },
          { id: "gemma4", name: "Gemma 4" },
        ]);
      },
    );

    it("drops gateway.auth.token when switching mode to password", async () => {
      const resolved: OpenClawConfig = {
        gateway: {
          auth: {
            mode: "token",
            token: "token-drop",
            password: "password-keep", // pragma: allowlist secret
          },
        },
      };
      setSnapshot(resolved, resolved);

      await runConfigSet("gateway.auth.mode", "password");

      expect(mockWriteConfigFile).toHaveBeenCalledTimes(1);
      const written = firstWrittenConfig();
      expect(written.gateway?.auth).toEqual({
        mode: "password",
        password: "password-keep", // pragma: allowlist secret
      });
      expectLogIncludes("Removed inactive gateway.auth.token for gateway.auth.mode=password");
    });

    it("applies mode-based credential cleanup using the final batch result", async () => {
      const resolved: OpenClawConfig = {
        gateway: {
          auth: {
            mode: "password",
            token: "token-keep",
            password: "password-drop", // pragma: allowlist secret
          },
        },
      };
      setSnapshot(resolved, resolved);

      await runConfigSet(
        "--batch-json",
        '[{"path":"gateway.auth.password","value":"password-updated"},{"path":"gateway.auth.mode","value":"token"}]',
      );

      expect(mockWriteConfigFile).toHaveBeenCalledTimes(1);
      const written = firstWrittenConfig();
      expect(written.gateway?.auth).toEqual({
        mode: "token",
        token: "token-keep",
      });
      expectLogIncludes("Removed inactive gateway.auth.password for gateway.auth.mode=token");
    });

    it("uses deep type-exact comparison for authored expectations", async () => {
      const resolved: OpenClawConfig = {
        gateway: { port: 18789, bind: "loopback" },
      };
      setSnapshot(resolved, resolved);

      await runConfigSet(
        "gateway",
        '{"port":19001,"bind":"loopback"}',
        "--strict-json",
        "--expect-current-json",
        '{"port":18789,"bind":"loopback"}',
      );
      expect(mockWriteConfigFile).toHaveBeenCalledTimes(1);

      vi.clearAllMocks();
      setSnapshot({ gateway: { port: 1 } }, { gateway: { port: 1 } });
      await expect(
        runConfigSet("gateway.port", "2", "--strict-json", "--expect-current-json", '"1"'),
      ).rejects.toMatchObject({ name: "ExitError", code: 1 });
      expect(mockWriteConfigFile).not.toHaveBeenCalled();
    });

    it("rejects an absent expectation when a SecretRef redirects away from the caller path", async () => {
      const existingValue = "caller-value-present";
      const refId = "REDIRECTED_REF_ID";
      const resolved = {
        channels: { discord: { accounts: [{ token: existingValue }] } },
      } as unknown as OpenClawConfig;
      setSnapshot(resolved, resolved);

      await expect(
        runConfigSet(
          "channels.discord.accounts[0].token",
          "--ref-provider",
          "default",
          "--ref-source",
          "env",
          "--ref-id",
          refId,
          "--expect-current-absent",
        ),
      ).rejects.toMatchObject({ name: "ExitError", code: 1 });

      expect(mockWriteConfigFile).not.toHaveBeenCalled();
      expectErrorIncludes("conditional config set requires a direct, non-redirected config path");
      const output = JSON.stringify([...mockLog.mock.calls, ...mockError.mock.calls]);
      expect(output).not.toContain(existingValue);
      expect(output).not.toContain(refId);
    });

    it("rejects an exact expectation when roster normalization redirects the write path", async () => {
      const existingValue = "existing-agent-name";
      const resolved: OpenClawConfig = {
        agents: { entries: { main: { name: existingValue } } },
      };
      setSnapshot(resolved, resolved);

      await expect(
        runConfigSet(
          "agents.list[0].name",
          "updated-agent-name",
          "--expect-current-json",
          JSON.stringify(existingValue),
        ),
      ).rejects.toMatchObject({ name: "ExitError", code: 1 });

      expect(mockWriteConfigFile).not.toHaveBeenCalled();
      expectErrorIncludes("conditional config set requires a direct, non-redirected config path");
      const output = JSON.stringify([...mockLog.mock.calls, ...mockError.mock.calls]);
      expect(output).not.toContain(existingValue);
      expect(output).not.toContain("updated-agent-name");
    });
  });

  describe("config get", () => {
    it.each([
      {
        path: "gateway.__proto__.token",
        error: "Invalid path segment: __proto__",
      },
    ])(
      "returns a JSON error without reading configuration for malformed $path",
      async (testCase) => {
        await expect(runConfigCommand(["config", "get", testCase.path, "--json"])).rejects.toThrow(
          ExitError,
        );

        expect(mockReadConfigFileSnapshot).not.toHaveBeenCalled();
        expect(mockError).not.toHaveBeenCalled();
        expect(parseLastLogPayload()).toMatchObject({
          ok: false,
          error: {
            type: "cli_error",
            message: expect.stringContaining(testCase.error),
          },
        });
      },
    );

    it.each([false, true])(
      "rejects invalid configuration without observing persistent state (json=%s)",
      async (json) => {
        setSnapshotOnce(
          makeInvalidSnapshot({
            issues: [{ path: "gateway.bind", message: "Invalid enum value" }],
          }),
        );
        await expect(
          runConfigCommand(["config", "get", "gateway.port", ...(json ? ["--json"] : [])]),
        ).rejects.toThrow(ExitError);
        expect(mockReadConfigFileSnapshot).toHaveBeenCalledWith({ observe: false });
        expect(mockWriteStdout).not.toHaveBeenCalled();
        if (json) {
          expect(mockError).not.toHaveBeenCalled();
          expect(parseLastLogPayload()).toMatchObject({
            ok: false,
            error: {
              type: "cli_error",
              message: expect.stringContaining("OpenClaw config is invalid"),
            },
            issues: [{ path: "gateway.bind", message: "Invalid enum value" }],
          });
        } else {
          expectErrorIncludes("gateway.bind");
          expectErrorIncludes("Invalid enum value");
          expect(mockLog).not.toHaveBeenCalled();
        }
      },
    );
  });

  describe("config validate", () => {
    it("prints warnings while still reporting a valid config", async () => {
      setSnapshotOnce({
        path: "/tmp/openclaw.json",
        exists: true,
        raw: "{}",
        parsed: {},
        sourceConfig: {},
        resolved: {},
        valid: true,
        runtimeConfig: {},
        config: {},
        issues: [],
        warnings: [
          {
            path: "channels.mattermost.allowFrom",
            message:
              'channels.mattermost.dmPolicy="open" but channels.mattermost.allowFrom does not include "*"; all DMs will be dropped.',
          },
        ],
        legacyIssues: [],
      });

      await runConfigCommand(["config", "validate"]);

      expect(mockExit).not.toHaveBeenCalled();
      expect(mockError).not.toHaveBeenCalled();
      expectLogIncludes("Config valid:");
      expectLogIncludes("channels.mattermost.allowFrom");
      expectLogIncludes("all DMs will be dropped");
    });

    it("replaces doctor advice for plugin packaging compiled-output failures", async () => {
      setSnapshotOnce(
        makeInvalidSnapshot({
          issues: [
            {
              path: "plugins.slots.memory",
              message: "plugin not found: source-only-pack",
            },
          ],
          warnings: [
            {
              path: "plugins",
              message:
                "plugin source-only-pack: installed plugin package requires compiled runtime output for TypeScript entry index.ts: expected ./dist/index.js. This is a plugin packaging issue, not a local config problem.",
            },
          ],
        }),
      );

      await expect(runConfigCommand(["config", "validate"])).rejects.toThrow(ExitError);

      expectErrorIncludes("plugin not found: source-only-pack");
      expectErrorIncludes("This is a plugin packaging issue, not a local config problem.");
      expectErrorIncludes("disable/uninstall the plugin");
      expect(mockError.mock.calls.map((call) => String(call[0])).join("\n")).not.toContain(
        "openclaw doctor --fix",
      );
      expect(mockLog).not.toHaveBeenCalled();
    });

    it("prints file-not-found and exits 1 when config file is missing", async () => {
      setSnapshotOnce({
        path: "/tmp/openclaw.json",
        exists: false,
        raw: null,
        parsed: {},
        resolved: {},
        sourceConfig: {},
        valid: true,
        config: {},
        runtimeConfig: {},
        issues: [],
        warnings: [],
        legacyIssues: [],
      });

      await expect(runConfigCommand(["config", "validate"])).rejects.toThrow(ExitError);
      expectErrorIncludes("Config file not found:");
      expect(mockLog).not.toHaveBeenCalled();
    });

    it.skipIf(process.platform === "win32")(
      "reports exec provider command-path errors in --json validate output",
      async () => {
        const root = tempDirs.make("openclaw-config-validate-json-link-");
        const symlinkPath = path.join(root, "node-link");
        fs.symlinkSync(process.execPath, symlinkPath);
        setGatewaySnapshot({
          providers: {
            execmain: {
              source: "exec",
              command: symlinkPath,
            },
          },
        });

        const payload = await runValidateJsonAndGetPayload();
        expect(payload).toMatchObject({
          ok: false,
          error: {
            type: "cli_error",
            message: expect.stringContaining("OpenClaw config is invalid"),
          },
          valid: false,
          path: "/tmp/openclaw.json",
          issues: [
            {
              path: "secrets.providers.execmain.command",
              message: expect.stringContaining("must not be a symlink"),
            },
          ],
        });
        expect(mockError).not.toHaveBeenCalled();
      },
    );
  });

  describe("config schema", () => {
    it("prints the supplied schema with the config schema marker", async () => {
      const schema = { type: "object", properties: { fixture: { type: "string" } } };
      mockReadBestEffortRuntimeConfigSchema.mockResolvedValueOnce({ schema });
      await runConfigCommand(["config", "schema", "--json"]);
      expect(defaultRuntime.writeJson).toHaveBeenCalledTimes(1);
      expect(parseLastLogPayload()).toEqual({
        type: "object",
        properties: {
          $schema: { type: "string" },
          fixture: { type: "string" },
        },
      });
      expect(schema.properties).not.toHaveProperty("$schema");
      expect(mockExit).not.toHaveBeenCalled();
      expect(mockError).not.toHaveBeenCalled();
    });
  });

  registerConfigJsonOutputTests(() => ({
    runConfigCommand,
    mockReadConfigFileSnapshot,
    mockWriteConfigFile,
    mockLog,
    parseLastLogPayload,
    expectErrorIncludes,
    ExitError,
  }));

  describe("config set parsing flags", () => {
    it("rejects JSON5-only object syntax when strict parsing is enabled", async () => {
      await expect(runConfigSet("gateway.auth", "{mode:'token'}", "--strict-json")).rejects.toThrow(
        ExitError,
      );

      expect(mockWriteConfigFile).not.toHaveBeenCalled();
      expect(mockReadConfigFileSnapshot).not.toHaveBeenCalled();
    });

    it("falls back to raw string when parsing fails and strict mode is off", async () => {
      const resolved: OpenClawConfig = { gateway: { port: 18789 } };
      setSnapshot(resolved, resolved);

      await runConfigSet("gateway.auth.mode", "{bad");

      expect(mockWriteConfigFile).toHaveBeenCalledTimes(1);
      const written = firstWrittenConfig();
      expect(written.gateway?.auth).toEqual({ mode: "{bad" });
    });
  });

  describe("config set builders and dry-run", () => {
    it.each(["ref builder", "batch value"] as const)(
      "writes array-indexed sibling SecretRefs to their registered ref path in %s mode",
      async (mode) => {
        const resolved = {
          channels: { discord: { accounts: [{ token: "existing-token" }] } },
        } as unknown as OpenClawConfig;
        const ref = { source: "env", provider: "default", id: "DISCORD_ACCOUNT_TOKEN" };
        const configPath = "channels.discord.accounts[0].token";
        setSnapshot(resolved, resolved);

        const args =
          mode === "ref builder"
            ? [
                configPath,
                "--ref-provider",
                ref.provider,
                "--ref-source",
                ref.source,
                "--ref-id",
                ref.id,
              ]
            : ["--batch-json", JSON.stringify([{ path: configPath, value: ref }])];
        await runConfigSet(...args);

        expect(mockWriteConfigFile).toHaveBeenCalledTimes(1);
        const written = firstWrittenConfig() as {
          channels?: { discord?: { accounts?: Array<{ token?: unknown; tokenRef?: unknown }> } };
        };
        expect(written.channels?.discord?.accounts?.[0]).toEqual({
          token: "existing-token",
          tokenRef: ref,
        });
        expect(requireWriteOptions().explicitSetPaths).toEqual([
          ["channels", "discord", "accounts", "0", "tokenRef"],
        ]);
      },
    );

    it("keeps a quoted numeric record key distinct from an array-indexed secret target", async () => {
      const resolved = {
        channels: { discord: { accounts: { "0": { token: "existing-token" } } } },
      } as unknown as OpenClawConfig;
      const ref = { source: "env", provider: "default", id: "DISCORD_ACCOUNT_TOKEN" };
      setSnapshot(resolved, resolved);

      await runConfigSet(
        'channels.discord.accounts["0"].token',
        "--ref-provider",
        ref.provider,
        "--ref-source",
        ref.source,
        "--ref-id",
        ref.id,
      );

      const written = firstWrittenConfig() as {
        channels?: { discord?: { accounts?: Record<string, { token?: unknown }> } };
      };
      expect(written.channels?.discord?.accounts?.["0"]).toEqual({ token: ref });
      expect(requireWriteOptions().explicitSetPaths).toEqual([
        ["channels", "discord", "accounts", "0", "token"],
      ]);
    });

    it.each([
      [
        'agents.defaults.models["fixture/model.v1"].params.list[0]',
        "ARRAY-ZERO",
        { list: ["ARRAY-ZERO"] },
      ],
    ])("preserves generic config path identity for %s", async (configPath, value, expected) => {
      const resolved = {
        agents: { defaults: { models: { "fixture/model.v1": { params: {} } } } },
      } as unknown as OpenClawConfig;
      setSnapshot(resolved, resolved);

      await runConfigSet(configPath, JSON.stringify(value), "--strict-json");

      expect(firstWrittenConfig().agents?.defaults?.models?.["fixture/model.v1"]?.params).toEqual(
        expected,
      );
      expectLogIncludes(`Updated ${configPath}`);
    });

    it("keeps a large numeric guild key as an object key", async () => {
      const resolved: OpenClawConfig = {
        channels: {
          discord: {
            enabled: true,
          },
        },
      } as unknown as OpenClawConfig;
      setSnapshot(resolved, resolved);

      await runConfigSet(
        "channels.discord.guilds.1495587801394184362.requireMention",
        "true",
        "--strict-json",
      );

      expect(mockWriteConfigFile).toHaveBeenCalledTimes(1);
      const written = firstWrittenConfig() as {
        channels?: { discord?: { guilds?: unknown } };
      };
      expect(written.channels?.discord?.guilds).toEqual({
        "1495587801394184362": {
          requireMention: true,
        },
      });
      expect(Array.isArray(written.channels?.discord?.guilds)).toBe(false);
    });

    it("fails early when parent-object writes include unsupported SecretRef objects", async () => {
      setGatewaySnapshot();

      await expect(
        runConfigSet(
          "hooks",
          '{"token":{"source":"env","provider":"default","id":"HOOK_TOKEN"}}',
          "--strict-json",
        ),
      ).rejects.toThrow(ExitError);

      expect(mockWriteConfigFile).not.toHaveBeenCalled();
      expectErrorIncludes("Config policy validation failed: unsupported SecretRef usage");
      expectErrorIncludes("hooks.token");
    });

    it("supports provider builder mode under secrets.providers.<alias>", async () => {
      setGatewaySnapshot();

      await runConfigSet(
        "secrets.providers.vaultfile",
        "--provider-source",
        "file",
        "--provider-path",
        "/tmp/vault.json",
        "--provider-mode",
        "json",
      );

      expect(mockWriteConfigFile).toHaveBeenCalledTimes(1);
      const written = firstWrittenConfig();
      expect(written.secrets?.providers?.vaultfile).toEqual({
        source: "file",
        path: "/tmp/vault.json",
        mode: "json",
      });
    });

    it("rejects exponent-style provider builder integer options", async () => {
      await expect(
        runConfigSet(
          "secrets.providers.runner",
          "--provider-source",
          "exec",
          "--provider-command",
          "op",
          "--provider-timeout-ms",
          "1e3",
        ),
      ).rejects.toThrow(ExitError);

      expectErrorIncludes("--provider-timeout-ms must be a positive integer.");
      expect(mockReadConfigFileSnapshot).not.toHaveBeenCalled();
      expect(mockWriteConfigFile).not.toHaveBeenCalled();
    });

    it.each([
      [
        "leading equals",
        "=SYNTHETIC_PROVIDER_ENV_SECRET",
        "--provider-env expects KEY=*** entries.",
      ],
      [
        "whitespace key",
        "   =SYNTHETIC_PROVIDER_ENV_SECRET",
        "--provider-env key must not be empty.",
      ],
    ])("does not disclose provider env values for a %s entry", async (_name, entry, message) => {
      const secret = "SYNTHETIC_PROVIDER_ENV_SECRET";

      await expect(
        runConfigSet(
          "secrets.providers.runner",
          "--provider-source",
          "exec",
          "--provider-command",
          "/usr/bin/env",
          "--provider-env",
          entry,
          "--dry-run",
        ),
      ).rejects.toThrow(ExitError);

      expect(mockReadConfigFileSnapshot).not.toHaveBeenCalled();
      expect(mockWriteConfigFile).not.toHaveBeenCalled();
      expect(JSON.stringify(mockLog.mock.calls)).not.toContain(secret);
      expect(JSON.stringify(mockWriteStdout.mock.calls)).not.toContain(secret);
      expect(JSON.stringify(mockError.mock.calls)).not.toContain(secret);
      expectErrorIncludes(message);
    });

    it.skipIf(process.platform === "win32")(
      "rejects an unsafe exec provider command before writing",
      async () => {
        const root = tempDirs.make("openclaw-config-set-link-");
        const symlinkPath = path.join(root, "node-link");
        fs.symlinkSync(process.execPath, symlinkPath);
        setGatewaySnapshot({
          providers: {
            execmain: { source: "exec", command: process.execPath, trustedDirs: [root] },
          },
        });
        await expect(
          runConfigSet("secrets.providers.execmain.command", symlinkPath),
        ).rejects.toThrow(ExitError);
        expect(mockWriteConfigFile).not.toHaveBeenCalled();
        expect(mockResolveSecretRefValue).not.toHaveBeenCalled();
        expectErrorIncludes("must not be a symlink");
        expectErrorIncludes("SecretRef provider configuration is invalid");
      },
    );

    it("leaves null providers to schema validation in value-mode dry runs", async () => {
      setGatewaySnapshot();

      await runConfigSet("secrets.providers.ghost", "null", "--dry-run");

      expect(mockError).not.toHaveBeenCalled();
      expect(mockWriteConfigFile).not.toHaveBeenCalled();
      expect(mockResolveSecretRefValue).not.toHaveBeenCalled();
      expectLogIncludes("Dry run note: value mode does not run schema/resolvability checks.");
      expectLogIncludes("Dry run successful:");
    });

    it.skipIf(process.platform === "win32")(
      "reports exec path preflight in --dry-run --json checks for ref-builder commands",
      async () => {
        const root = tempDirs.make("openclaw-config-set-dryrun-link-");
        const symlinkPath = path.join(root, "node-link");
        fs.symlinkSync(process.execPath, symlinkPath);
        setGatewaySnapshot({
          providers: { execmain: { source: "exec", command: symlinkPath } },
        });

        await expect(
          runDiscordRef("execmain", "exec", "DISCORD_BOT_TOKEN", "--dry-run", "--json"),
        ).rejects.toThrow(ExitError);

        expect(mockWriteConfigFile).not.toHaveBeenCalled();
        const payload = parseLastLogPayload() as ConfigSetDryRunResult;
        expect(payload.ok).toBe(false);
        // The exec-path preflight is schema-class validation; when it fails,
        // the JSON report must not claim no schema check ran.
        expect(payload.checks.schema).toBe(true);
        expect(payload.errors).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              kind: "schema",
              message: expect.stringContaining("secrets.providers.execmain"),
            }),
          ]),
        );
      },
    );

    it("does not duplicate policy errors in --dry-run --json mode for parent-object writes", async () => {
      setGatewaySnapshot();

      await expect(
        runConfigSet(
          "hooks",
          '{"token":{"source":"env","provider":"default","id":"HOOK_TOKEN"}}',
          "--strict-json",
          "--dry-run",
          "--json",
        ),
      ).rejects.toThrow(ExitError);

      expect(mockWriteConfigFile).not.toHaveBeenCalled();
      const payload = parseLastLogPayload() as ConfigSetDryRunResult;
      expect(payload.ok).toBe(false);
      expect(payload.checks.schema).toBe(true);
      const hooksTokenErrors =
        payload.errors?.filter(
          (entry) => entry.kind === "schema" && entry.message.includes("hooks.token"),
        ) ?? [];
      expect(hooksTokenErrors).toHaveLength(1);
    });

    it("rejects --allow-exec without --dry-run", async () => {
      const nonexistentBatchPath = path.join(
        os.tmpdir(),
        `openclaw-config-batch-nonexistent-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
      );
      await expect(
        runConfigSet("--batch-file", nonexistentBatchPath, "--allow-exec"),
      ).rejects.toThrow(ExitError);

      expect(mockWriteConfigFile).not.toHaveBeenCalled();
      expect(mockResolveSecretRefValue).not.toHaveBeenCalled();
      expectErrorIncludes("config set mode error: --allow-exec requires --dry-run.");
    });

    it("fails dry-run when skipped exec refs use an unconfigured provider", async () => {
      const resolved: OpenClawConfig = {
        gateway: { port: 18789 },
        secrets: {
          providers: {},
        },
      };
      setSnapshot(resolved, resolved);

      await expect(runDiscordRef("runner", "exec", "openai", "--dry-run")).rejects.toThrow(
        ExitError,
      );

      expect(mockResolveSecretRefValue).not.toHaveBeenCalled();
      expectErrorIncludes('Secret provider "runner" is not configured');
    });

    it("rejects mixing ref-builder and provider-builder flags", async () => {
      await expect(
        runDiscordRef("default", "env", "DISCORD_BOT_TOKEN", "--provider-source", "env"),
      ).rejects.toThrow(ExitError);

      expectErrorIncludes("config set mode error: choose exactly one mode");
    });

    it("rejects mixing batch mode with builder flags", async () => {
      await expect(
        runConfigSet(
          "--batch-json",
          "[]",
          "--ref-provider",
          "default",
          "--ref-source",
          "env",
          "--ref-id",
          "DISCORD_BOT_TOKEN",
        ),
      ).rejects.toThrow(ExitError);

      expectErrorIncludes(
        "config set mode error: batch mode (--batch-json/--batch-file) cannot be combined",
      );
    });

    it.each([
      {
        name: "both expectation flags",
        args: [
          "gateway.port",
          "19001",
          "--expect-current-absent",
          "--expect-current-json",
          "18789",
        ],
      },
      {
        name: "malformed expected JSON",
        args: ["gateway.port", "19001", "--expect-current-json", "{bad"],
      },
      {
        name: "batch mode",
        args: [
          "--batch-json",
          '[{"path":"gateway.port","value":19001}]',
          "--expect-current-absent",
        ],
      },
      {
        name: "dry-run",
        args: ["gateway.port", "19001", "--expect-current-absent", "--dry-run"],
      },
    ])("rejects conditional config set with $name before loading config", async ({ args }) => {
      await expect(runConfigSet(...args)).rejects.toThrow(ExitError);

      expect(mockReadConfigFileSnapshot).not.toHaveBeenCalled();
      expect(mockWriteConfigFile).not.toHaveBeenCalled();
    });

    it("checks a conditional expectation before reporting No change", async () => {
      setGatewaySnapshot();

      await expect(
        runConfigSet("gateway.port", "18789", "--strict-json", "--expect-current-json", "19001"),
      ).rejects.toMatchObject({ name: "ExitError", code: 1 });

      expect(mockWriteConfigFile).not.toHaveBeenCalled();
      expectLogExcludes("No change");
    });

    it.skipIf(process.platform === "win32")(
      "removes an unsafe exec provider while preserving another dormant provider",
      async () => {
        const root = tempDirs.make("openclaw-config-provider-remove-");
        const symlinkPath = path.join(root, "node-link");
        fs.symlinkSync(process.execPath, symlinkPath);
        setGatewaySnapshot({
          providers: {
            execmain: { source: "exec", command: symlinkPath },
            dormant: { source: "exec", command: symlinkPath },
          },
        });
        const pathname = writeTempJson5File("openclaw-config-provider-remove-patch-", {
          secrets: { providers: { execmain: null } },
        });
        await runConfigCommand(["config", "patch", "--file", pathname]);
        expect(mockError).not.toHaveBeenCalled();
        expect(mockResolveSecretRefValue).not.toHaveBeenCalled();
        expect(mockWriteConfigFile).toHaveBeenCalledTimes(1);
        expect(firstWrittenConfig().secrets?.providers).toEqual({
          dormant: { source: "exec", command: symlinkPath },
        });
      },
    );

    it("treats empty object config patches as recursive merges", async () => {
      const resolved = {
        channels: {
          slack: {
            enabled: true,
            mode: "socket",
          },
        },
      } as unknown as OpenClawConfig;
      setSnapshot(resolved, resolved);

      const pathname = writeTempJson5File("openclaw-config-patch-empty-merge", {
        channels: {
          slack: {},
        },
      });
      await runConfigCommand(["config", "patch", "--file", pathname]);

      const written = firstWrittenConfig() as Record<string, unknown>;
      expect((written.channels as Record<string, unknown>).slack).toEqual({
        enabled: true,
        mode: "socket",
      });
    });

    it("rejects a directory passed as --file", async () => {
      const pathname = tempDirs.make("openclaw-config-patch-directory-");
      await expect(runConfigCommand(["config", "patch", "--file", pathname])).rejects.toThrow(
        ExitError,
      );

      expectErrorIncludes(
        `--file must be a regular file: ${pathname}. Choose a JSON5 input file and try again.`,
      );
      expect(mockWriteConfigFile).not.toHaveBeenCalled();
    });

    it("rejects --file patches above the config mutation limit", async () => {
      const pathname = path.join(tempDirs.make("openclaw-config-oversized-"), "patch.json5");
      fs.writeFileSync(pathname, " ".repeat(8 * 1024 * 1024 + 1), "utf8");
      await expect(runConfigCommand(["config", "patch", "--file", pathname])).rejects.toThrow(
        ExitError,
      );

      expectErrorIncludes("--file exceeds the 8 MiB supported maximum (8388608 bytes)");
      expect(mockWriteConfigFile).not.toHaveBeenCalled();
    });

    it("dry-runs pluginIntegration provider patches against manifest integration metadata", async () => {
      const pluginId = "secret-provider-proof";
      const rootDir = tempDirs.make("openclaw-config-plugin-provider-");
      writeSecurePluginEntrypoint(path.join(rootDir, "index.js"), "export default {};\n");
      writeSecurePluginEntrypoint(path.join(rootDir, "resolve.mjs"), "process.stdin.resume();\n");
      const resolved = {
        secrets: {
          providers: {},
        },
      } as unknown as OpenClawConfig;
      mockLoadPluginMetadataSnapshot.mockReturnValue(
        createPluginMetadataSnapshot({
          diagnostics: [],
          plugins: [
            createPluginManifestRecord({
              id: pluginId,
              enabledByDefault: true,
              origin: "bundled",
              rootDir,
              source: path.join(rootDir, "index.js"),
              manifestPath: path.join(rootDir, "openclaw.plugin.json"),
              secretProviderIntegrations: {
                vault: {
                  source: "exec",
                  command: "${node}",
                  args: ["./resolve.mjs"],
                },
              },
            }),
          ],
        }),
      );

      setSnapshot(resolved, resolved);
      const validPatch = writeTempJson5File("openclaw-config-plugin-provider-valid", {
        secrets: {
          providers: {
            team: {
              source: "exec",
              pluginIntegration: { pluginId, integrationId: "vault" },
            },
          },
        },
      });
      try {
        await runConfigCommand([
          "config",
          "patch",
          "--file",
          validPatch,
          "--dry-run",
          "--allow-exec",
          "--json",
        ]);
      } finally {
        fs.rmSync(validPatch, { force: true });
      }
      expect(mockWriteConfigFile).not.toHaveBeenCalled();

      setSnapshot(resolved, resolved);
      const invalidPatch = writeTempJson5File("openclaw-config-plugin-provider-invalid", {
        secrets: {
          providers: {
            team: {
              source: "exec",
              pluginIntegration: { pluginId, integrationId: "missing" },
            },
          },
        },
      });
      try {
        await expect(
          runConfigCommand([
            "config",
            "patch",
            "--file",
            invalidPatch,
            "--dry-run",
            "--allow-exec",
            "--json",
          ]),
        ).rejects.toThrow(ExitError);
      } finally {
        fs.rmSync(invalidPatch, { force: true });
      }
      const invalidPayload = lastMockArg(defaultRuntime.writeJson) as {
        ok?: boolean;
        checks?: { schema?: boolean };
        errors?: Array<{ message?: string }>;
      };
      const errorMessages = invalidPayload.errors?.map((error) => error.message ?? "") ?? [];
      expect(errorMessages.some((message) => message.includes("secrets.providers.team"))).toBe(
        true,
      );
      expect(
        errorMessages.some((message) =>
          message.includes(`does not declare secret provider integration "missing"`),
        ),
      ).toBe(true);
      // The integration was selected and materialization was attempted (and
      // failed); checks.schema reflects that schema-class validation ran.
      expect(invalidPayload.ok).toBe(false);
      expect(invalidPayload.checks?.schema).toBe(true);
    });

    it("validates pluginIntegration providers referenced by newly assigned SecretRefs", async () => {
      const pluginId = "secret-provider-proof";
      const resolved = {
        gateway: {
          auth: { mode: "token" },
        },
        secrets: {
          providers: {
            team: {
              source: "exec",
              pluginIntegration: { pluginId, integrationId: "vault" },
            },
          },
        },
      } as unknown as OpenClawConfig;
      setSnapshot(resolved, resolved);

      const patch = writeTempJson5File("openclaw-config-plugin-provider-ref", {
        gateway: {
          auth: {
            token: { source: "exec", provider: "team", id: "gateway/token" },
          },
        },
      });
      await expect(
        runConfigCommand(["config", "patch", "--file", patch, "--dry-run", "--json"]),
      ).rejects.toThrow(ExitError);

      const payload = lastMockArg(defaultRuntime.writeJson) as {
        errors?: Array<{ message?: string }>;
      };
      const messages = payload.errors?.map((error) => error.message ?? "") ?? [];
      expect(messages.some((message) => message.includes("secrets.providers.team"))).toBe(true);
      expect(messages.some((message) => message.includes(`plugin "${pluginId}"`))).toBe(true);
    });

    it("reports schema errors for deeply nested replacement values without an engine failure", async () => {
      const resolved = {} as unknown as OpenClawConfig;
      setSnapshot(resolved, resolved);
      const pathname = path.join(tempDirs.make("openclaw-config-deep-replacement-"), "patch.json5");
      const nestedArray = "[".repeat(20_000) + "0" + "]".repeat(20_000);
      fs.writeFileSync(pathname, `{agents:{defaults:{params:${nestedArray}}}}`, "utf8");
      await expect(
        runConfigCommand([
          "config",
          "patch",
          "--file",
          pathname,
          "--replace-path",
          "agents.defaults.params",
          "--dry-run",
        ]),
      ).rejects.toThrow(ExitError);

      const errors = mockError.mock.calls.flat().join("\n");
      expect(errors).toContain("Dry run failed: config schema validation failed.");
      expect(errors).not.toContain("Maximum call stack size exceeded");
    });

    it("rejects malformed batch entries with mixed operation keys", async () => {
      await expect(
        runConfigSet(
          "--batch-json",
          '[{"path":"channels.discord.token","value":"x","ref":{"source":"env","provider":"default","id":"DISCORD_BOT_TOKEN"}}]',
        ),
      ).rejects.toThrow(ExitError);

      expectErrorIncludes("must include exactly one of: value, ref, provider");
    });

    it("reports config mutation conflicts accurately in dry-run JSON", async () => {
      mockReadConfigFileSnapshot.mockRejectedValueOnce(
        new ConfigMutationConflictError("config changed since last load"),
      );

      await expect(
        runConfigSet("gateway.port", "19000", "--dry-run", "--json"),
      ).rejects.toMatchObject({ name: "ExitError", code: 1 });
      expect(parseLastLogPayload()).toMatchObject({
        ok: false,
        errors: [
          {
            kind: "conflict",
            message:
              "The config file changed while this command was writing (config changed since last load), so nothing was changed. Re-run the same command to pick up the new file and try again.",
          },
        ],
      });
    });

    it.each([
      {
        name: "a malformed batch payload",
        args: ["config", "set", "--batch-json", "{}", "--dry-run", "--json"],
        message: "--batch-json must be a JSON array.",
      },
      {
        name: "an invalid unset path",
        args: ["config", "unset", "gateway.port\\", "--dry-run", "--json"],
        message: "Invalid path (trailing escape): gateway.port\\",
      },
      {
        name: "a missing patch file",
        args: [
          "config",
          "patch",
          "--file",
          "/nonexistent/openclaw-config-json-patch.json5",
          "--dry-run",
          "--json",
        ],
        message: "--file not found: /nonexistent/openclaw-config-json-patch.json5",
      },
    ])("emits structured JSON and actionable stderr for $name", async ({ args, message }) => {
      await expect(runConfigCommand(args)).rejects.toThrow(ExitError);

      expect(mockReadConfigFileSnapshot).not.toHaveBeenCalled();
      expect(mockWriteConfigFile).not.toHaveBeenCalled();
      expect(parseLastLogPayload()).toMatchObject({
        ok: false,
        operations: 0,
        inputModes: [],
        checks: {
          schema: false,
          resolvability: false,
          resolvabilityComplete: false,
        },
        refsChecked: 0,
        skippedExecRefs: 0,
        errors: [{ kind: "schema", message: expect.stringContaining(message) }],
      });
      expectErrorIncludes(message);
    });

    it("keeps distinct resolvability failures when messages are identical but refs differ", async () => {
      setGatewaySnapshot({ providers: { default: { source: "env" } } });

      await expect(
        runConfigSet(
          "--batch-json",
          '[{"path":"channels.discord.token","ref":{"source":"exec","provider":"default","id":"DISCORD_BOT_TOKEN"}},{"path":"channels.telegram.botToken","ref":{"source":"exec","provider":"default","id":"TELEGRAM_BOT_TOKEN"}}]',
          "--dry-run",
          "--json",
        ),
      ).rejects.toThrow(ExitError);

      const payload = parseLastLogPayload() as ConfigSetDryRunResult;
      expect(payload.ok).toBe(false);
      const resolvabilityErrors =
        payload.errors?.filter((entry) => entry.kind === "resolvability") ?? [];
      expect(resolvabilityErrors).toHaveLength(2);
      expect(
        resolvabilityErrors.some((entry) => entry.ref === "exec:default:DISCORD_BOT_TOKEN"),
      ).toBe(true);
      expect(
        resolvabilityErrors.some((entry) => entry.ref === "exec:default:TELEGRAM_BOT_TOKEN"),
      ).toBe(true);
    });

    it("aggregates schema and resolvability failures in --dry-run --json mode", async () => {
      setGatewaySnapshot({ providers: { default: { source: "env" } } });
      const secret = "sk-abcdefghijklmnopqrstuv";
      const error = new Error(`missing env var: Authorization: Bearer ${secret}`);
      error.name = "SecretResolutionError";
      mockResolveSecretRefValue.mockRejectedValue(error);

      await expect(
        runConfigSet(
          "--batch-json",
          '[{"path":"gateway.port","value":"not-a-number"},{"path":"channels.discord.token","ref":{"source":"env","provider":"default","id":"DISCORD_BOT_TOKEN"}}]',
          "--dry-run",
          "--json",
        ),
      ).rejects.toThrow(ExitError);

      const payload = parseLastLogPayload() as ConfigSetDryRunResult;
      expect(payload.ok).toBe(false);
      const errorKinds = (payload.errors ?? []).map((entry) => entry.kind);
      expect(errorKinds).toContain("schema");
      expect(errorKinds).toContain("resolvability");
      const errorRefs = (payload.errors ?? []).map((entry) => entry.ref ?? "");
      expect(errorRefs).toContain("env:default:DISCORD_BOT_TOKEN");
      expect(JSON.stringify(payload)).not.toContain(error.name);
      expect(JSON.stringify(payload)).not.toContain(secret);
    });

    it("fails dry-run for nested provider edits that make existing refs unresolvable", async () => {
      const resolved: OpenClawConfig = {
        gateway: {
          port: 18789,
          auth: {
            mode: "token",
            token: {
              source: "file",
              provider: "vaultfile",
              id: "/providers/search/apiKey",
            },
          },
        },
        secrets: {
          providers: {
            vaultfile: { source: "file", path: "/tmp/secrets.json", mode: "json" },
          },
        },
      };
      setSnapshot(resolved, resolved);
      mockResolveSecretRefValue.mockImplementationOnce(async () => {
        throw new Error("provider mismatch");
      });

      await expect(
        runConfigSet(
          "secrets.providers.vaultfile.path",
          '"/tmp/other-secrets.json"',
          "--strict-json",
          "--dry-run",
        ),
      ).rejects.toThrow(ExitError);

      const [secretRef, resolveOptions] = requireResolveSecretRefCall(0);
      const secretRefRecord = requireRecord(secretRef, "existing SecretRef");
      expect(secretRefRecord.provider).toBe("vaultfile");
      expect(secretRefRecord.id).toBe("/providers/search/apiKey");
      expect(resolveOptions).toBeTypeOf("object");
      expectErrorIncludes("Dry run failed: 1 SecretRef assignment(s) could not be resolved.");
      expectErrorIncludes("provider mismatch");
    });

    it("fails dry-run when provider updates make existing refs unresolvable", async () => {
      const resolved: OpenClawConfig = {
        gateway: {
          port: 18789,
          auth: {
            mode: "token",
            token: {
              source: "file",
              provider: "vaultfile",
              id: "/providers/search/apiKey",
            },
          },
        },
        secrets: {
          providers: {
            vaultfile: { source: "file", path: "/tmp/secrets.json", mode: "json" },
          },
        },
      };
      setSnapshot(resolved, resolved);
      mockResolveSecretRefValue.mockImplementationOnce(async () => {
        throw new Error("provider mismatch");
      });

      await expect(
        runConfigSet("secrets.providers.vaultfile", "--provider-source", "env", "--dry-run"),
      ).rejects.toThrow(ExitError);

      expectErrorIncludes("Dry run failed: 1 SecretRef assignment(s) could not be resolved.");
      expectErrorIncludes("provider mismatch");
    });

    it("canonicalizes schema-backed numeric agent list indexes before writing", async () => {
      mockReadBestEffortRuntimeConfigSchema.mockResolvedValueOnce({
        schema: {
          type: "object",
          properties: {
            agents: {
              type: "object",
              properties: {
                list: {
                  type: "array",
                  items: { type: "object", properties: { id: { type: "string" } } },
                },
              },
            },
          },
        },
      });
      const resolved: OpenClawConfig = {};
      setSnapshot(resolved, resolved);

      await runConfigSet("agents.list.0.id", '"tech"', "--strict-json");

      expect(mockWriteConfigFile).toHaveBeenCalledTimes(1);
      const written = firstWrittenConfig();
      expect(written.agents?.entries).toEqual({ tech: {} });
      expect(written.agents).not.toHaveProperty("list");
    });

    it("preserves empty object values in config patch", async () => {
      const resolved = {
        agents: {
          defaults: {
            models: {
              "openai/gpt-5.4": { alias: "GPT 5.4" },
            },
          },
        },
      } as unknown as OpenClawConfig;
      setSnapshot(resolved, resolved);

      const pathname = writeTempJson5File("openclaw-config-patch-empty-object", {
        agents: {
          defaults: {
            models: {
              "openai/gpt-5.5": {},
            },
          },
        },
      });
      await runConfigCommand(["config", "patch", "--file", pathname]);

      const written = firstWrittenConfig() as Record<string, unknown>;
      expect(
        ((written.agents as Record<string, unknown>).defaults as Record<string, unknown>).models,
      ).toEqual({
        "openai/gpt-5.4": { alias: "GPT 5.4" },
        "openai/gpt-5.5": {},
      });
    });
  });

  describe("path hardening", () => {
    it.each([
      {
        name: "rejects blocked prototype-key segments for config set",
        args: ["config", "set", "tools.constructor.profile", '"sandbox"'],
        error: "Invalid path segment: constructor",
      },
      {
        name: "rejects blocked prototype-key segments for config unset",
        args: ["config", "unset", "channels.prototype.enabled"],
        error: "Invalid path segment: prototype",
      },
      {
        name: "rejects impractical array indexes for config set",
        args: ["config", "set", "agents.list.4294967294.id", '"main"'],
        error: 'Expected numeric index for array segment "4294967294"',
        list: [],
      },
    ])("$name", async ({ args, error, list }) => {
      if (list) {
        const resolved = { agents: { list } } as unknown as OpenClawConfig;
        setSnapshot(resolved, resolved);
      }
      await expect(runConfigCommand(args)).rejects.toThrow(ExitError);
      expectErrorIncludes(error);
      if (!list) {
        expect(mockReadConfigFileSnapshot).not.toHaveBeenCalled();
      }
      expect(mockWriteConfigFile).not.toHaveBeenCalled();
    });
  });

  describe("config unset", () => {
    it("prints JSON for config unset dry-run", async () => {
      const resolved: OpenClawConfig = {
        agents: { entries: { main: {} } },
        gateway: { port: 18789 },
        tools: {
          profile: "coding",
          alsoAllow: ["agents_list"],
        },
      };
      setSnapshot(resolved, resolved);

      await runConfigCommand(["config", "unset", "tools.alsoAllow", "--dry-run", "--json"]);

      expect(mockWriteConfigFile).not.toHaveBeenCalled();
      expect(parseLastLogPayload()).toMatchObject({
        ok: true,
        operations: 1,
        inputModes: ["unset"],
        checks: {
          schema: true,
          resolvability: true,
          resolvabilityComplete: true,
        },
      });
    });

    it("prints structured JSON when unset dry-run misses a path", async () => {
      const resolved: OpenClawConfig = {
        gateway: { port: 18789 },
        tools: {
          profile: "coding",
        },
      };
      setSnapshot(resolved, resolved);

      await expect(
        runConfigCommand(["config", "unset", "tools.alsoAllow", "--dry-run", "--json"]),
      ).rejects.toThrow(ExitError);

      expect(mockWriteConfigFile).not.toHaveBeenCalled();
      expect(mockError).not.toHaveBeenCalled();
      const payload = parseLastLogPayload() as ConfigSetDryRunResult;
      expect(payload.ok).toBe(false);
      expect(payload.inputModes).toEqual(["unset"]);
      expect(payload.checks).toEqual({
        schema: false,
        resolvability: false,
        resolvabilityComplete: false,
      });
      expect(payload.errors).toEqual([
        {
          kind: "missing-path",
          message: "Config path not found: tools.alsoAllow. Nothing was changed.",
        },
      ]);
    });

    it("reports No change when removing a normalized duplicate leaves config unchanged", async () => {
      const retired = "google/gemini-3-pro-preview";
      const canonical = "google/gemini-3.1-pro-preview";
      const resolved: OpenClawConfig = {
        agents: {
          defaults: {
            models: {
              [retired]: { alias: "gemini" },
              [canonical]: { alias: "gemini" },
            },
          },
        },
      };
      setSnapshot(resolved, resolved);

      await runConfigCommand(["config", "unset", `agents.defaults.models["${retired}"]`]);

      expect(mockWriteConfigFile).not.toHaveBeenCalled();
      expect(mockError).not.toHaveBeenCalled();
      expectLogIncludes("No change");
    });

    it("validates existing refs when unset dry-run removes all secret providers", async () => {
      const resolved: OpenClawConfig = {
        gateway: {
          port: 18789,
          auth: {
            mode: "token",
            token: {
              source: "file",
              provider: "vaultfile",
              id: "/providers/search/apiKey",
            },
          },
        },
        secrets: {
          providers: {
            vaultfile: { source: "file", path: "/tmp/secrets.json", mode: "json" },
          },
        },
      };
      setSnapshot(resolved, resolved);
      mockResolveSecretRefValue.mockRejectedValueOnce(new Error("provider removed"));

      await expect(
        runConfigCommand(["config", "unset", "secrets.providers", "--dry-run"]),
      ).rejects.toThrow(ExitError);

      expect(mockWriteConfigFile).not.toHaveBeenCalled();
      const [secretRef] = requireResolveSecretRefCall(0);
      const secretRefRecord = requireRecord(secretRef, "existing SecretRef");
      expect(secretRefRecord.provider).toBe("vaultfile");
      expect(secretRefRecord.id).toBe("/providers/search/apiKey");
      expectErrorIncludes("Dry run failed: 1 SecretRef assignment(s) could not be resolved.");
      expectErrorIncludes("provider removed");
    });

    it("validates existing refs when unset dry-run removes secret defaults", async () => {
      const resolved: OpenClawConfig = {
        gateway: {
          port: 18789,
          auth: { mode: "token", token: "${WEB_SEARCH_API_KEY}" },
        },
        secrets: {
          defaults: {
            env: "vaultenv",
          },
          providers: {
            default: { source: "env" },
            vaultenv: { source: "env" },
          },
        },
      } as OpenClawConfig;
      setSnapshot(resolved, resolved);

      await runConfigCommand(["config", "unset", "secrets.defaults", "--dry-run"]);

      expect(mockWriteConfigFile).not.toHaveBeenCalled();
      const [secretRef] = requireResolveSecretRefCall(0);
      const secretRefRecord = requireRecord(secretRef, "defaulted SecretRef");
      expect(secretRefRecord).toMatchObject({
        source: "env",
        provider: "default",
        id: "WEB_SEARCH_API_KEY",
      });
      expectLogIncludes("Dry run successful: 1 update(s) validated against /tmp/openclaw.json.");
    });

    it("rejects config unset --allow-exec without --dry-run", async () => {
      await expect(
        runConfigCommand(["config", "unset", "tools.alsoAllow", "--allow-exec"]),
      ).rejects.toThrow(ExitError);

      expect(mockWriteConfigFile).not.toHaveBeenCalled();
      expectErrorIncludes("--allow-exec can only be used with --dry-run.");
    });

    it("rejects unset when the value exists only in runtime defaults", async () => {
      const resolved = {
        agents: {
          defaults: {
            models: {
              "openai/gpt-5.4": {},
            },
          },
        },
      } as OpenClawConfig;
      const runtimeMerged = {
        agents: {
          defaults: {
            models: {
              "openai/gpt-5.4": { alias: "gpt" },
            },
          },
        },
      } as OpenClawConfig;
      const aliasPath = 'agents.defaults.models["openai/gpt-5.4"].alias';
      setSnapshot(resolved, runtimeMerged);

      await expect(runConfigCommand(["config", "unset", aliasPath])).rejects.toThrow(ExitError);

      expectLogExcludes("No change");
      expectErrorIncludes(
        `Config path not found in authored config: ${aliasPath}. It only exists after runtime defaults are applied, so there is nothing for config unset to remove. Use openclaw config set <path> <value> to override the inherited value.`,
      );
      expect(mockWriteConfigFile).not.toHaveBeenCalled();

      setSnapshot(resolved, runtimeMerged);
      await expect(
        runConfigCommand(["config", "unset", aliasPath, "--dry-run", "--json"]),
      ).rejects.toThrow(ExitError);

      expect(parseLastLogPayload()).toMatchObject({
        ok: false,
        errors: [
          {
            kind: "missing-path",
            message: expect.stringContaining(
              `Config path not found in authored config: ${aliasPath}.`,
            ),
          },
        ],
      });
      expect(mockWriteConfigFile).not.toHaveBeenCalled();
    });

    it("submits only the specified roster entry removal for writer validation", async () => {
      const resolved: OpenClawConfig = {
        agents: {
          entries: { "agent-a": {}, "agent-b": {}, "agent-c": {} },
        },
      };
      const runtimeMerged: OpenClawConfig = {
        ...withRuntimeDefaults(resolved),
      };
      setSnapshot(resolved, runtimeMerged);

      await runConfigCommand(["config", "unset", "agents.list[1]"]);

      expect(mockWriteConfigFile).toHaveBeenCalledTimes(1);
      const written = firstWrittenConfig();
      // The real writer's roster-loss guard is exercised by config-cli.integration.test.ts.
      expect(written.agents?.entries).toEqual({ "agent-a": {}, "agent-c": {} });
      expect(firstWriteConfigOptions()).toEqual({ auditOrigin: "cli" });
    });
  });

  describe("config apply hints - issue #80722", () => {
    it("prints a no-restart hint for a same-value config patch", async () => {
      setGatewaySnapshot();
      const pathname = writeTempJson5File("openclaw-config-patch-same-value", {
        gateway: { port: 18789 },
      });

      await runConfigCommand(["config", "patch", "--file", pathname]);

      expect(mockWriteConfigFile).toHaveBeenCalledTimes(1);
      expectLogIncludes("Applied 1 config update(s). No gateway restart needed.");
      expectLogExcludes("Restart the gateway to apply.");
      expectLogExcludes("Change will apply without restarting the gateway.");
    });

    it.each([["agents.list[0].model.primary", '"openai/gpt-5.5"']])(
      "keeps the restart hint for %s when reload mode is off",
      async (configPath, value) => {
        const resolved: OpenClawConfig = {
          agents: {
            entries: { main: { model: { primary: "openai/gpt-5.4" } } },
          },
          gateway: {
            reload: { mode: "off" },
          },
          plugins: { entries: { canvas: { enabled: true } } },
        };
        setSnapshot(resolved, withRuntimeDefaults(resolved));

        await runConfigSet(configPath, value, "--strict-json");

        expectLogIncludes(`Updated ${configPath}`);
        expectLogIncludes("Restart the gateway to apply.");
        expectLogExcludes("Change will apply without restarting the gateway.");
      },
    );

    it("prints a hot-reload hint for broad plugins unsets that remove load paths", async () => {
      const resolved: OpenClawConfig = {
        plugins: {
          load: {
            paths: ["/tmp/openclaw-plugins-a"],
          },
          entries: {
            canvas: { enabled: true },
          },
        },
      } as unknown as OpenClawConfig;
      setSnapshot(resolved, resolved);

      await runConfigCommand(["config", "unset", "plugins"]);

      expectLogIncludes("Removed plugins. Change will apply without restarting the gateway.");
      expectLogExcludes("Restart the gateway to apply.");
    });

    it("keeps the restart hint for mixed hot and restart batch updates", async () => {
      const resolved: OpenClawConfig = {
        agents: { entries: { main: { model: { primary: "openai/gpt-5.4" } } } },
        gateway: { port: 18789 },
      };
      setSnapshot(resolved, withRuntimeDefaults(resolved));

      await runConfigSet(
        "--batch-json",
        '[{"path":"agents.list[0].model.primary","value":"openai/gpt-5.5"},{"path":"gateway.auth.mode","value":"token"}]',
      );

      expectLogIncludes("Updated 2 config paths. Restart the gateway to apply.");
      expectLogExcludes("Change will apply without restarting the gateway.");
    });
  });

  describe("config file", () => {
    it("resolves the active path without initializing state", async () => {
      const home = tempDirs.make("openclaw-config-file-");
      const profile = "configfile-probe";
      const stateDir = path.join(home, `.openclaw-${profile}`);
      const configPath = path.join(stateDir, "openclaw.json");
      vi.stubEnv("OPENCLAW_HOME", home);
      vi.stubEnv("OPENCLAW_CONFIG_PATH", "");
      vi.stubEnv("OPENCLAW_PROFILE", "");
      vi.stubEnv("OPENCLAW_STATE_DIR", "");
      vi.stubEnv("OPENCLAW_TEST_FAST", "1");
      applyCliProfileEnv({ profile });
      mockReadConfigFileSnapshot.mockImplementationOnce(async () => {
        fs.mkdirSync(path.join(stateDir, "state"), { recursive: true });
        fs.writeFileSync(path.join(stateDir, "state", "openclaw.sqlite"), "initialized");
        const snapshot = buildSnapshot({ resolved: {}, config: {} });
        snapshot.path = configPath;
        return snapshot;
      });

      try {
        await runConfigCommand(["config", "file"]);
        const output = String(lastMockArg(mockWriteStdout));
        expect(mockWriteStdout).toHaveBeenCalledWith(`${configPath}\n`);
        expect(output).toBe(`${configPath}\n`);
        expect(path.isAbsolute(output.trimEnd())).toBe(true);
        expect(output).not.toContain("$OPENCLAW_HOME");
        expect(output).not.toContain("~");
        expect(mockReadConfigFileSnapshot).not.toHaveBeenCalled();
        expect(fs.existsSync(stateDir)).toBe(false);
        expect(fs.existsSync(path.join(stateDir, "state", "openclaw.sqlite"))).toBe(false);
      } finally {
        vi.unstubAllEnvs();
        fs.rmSync(home, { recursive: true, force: true });
      }
    });

    it("emits the active path as a JSON object", async () => {
      const configPath = path.join(os.tmpdir(), "openclaw-json-config", "openclaw.json");
      vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);

      try {
        await runConfigCommand(["config", "file", "--json"]);

        expect(defaultRuntime.writeJson).toHaveBeenCalledWith({ path: configPath }, 2);
        expect(structuredClone(lastMockArg(defaultRuntime.writeJson))).toEqual({
          path: configPath,
        });
      } finally {
        vi.unstubAllEnvs();
      }
    });
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
