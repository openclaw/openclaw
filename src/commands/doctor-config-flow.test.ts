import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { writeFixtureJson } from "../cli/cli-fixtures.test-support.js";
import { clearRuntimeConfigSnapshot, readRuntimeConfig } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { MediaUnderstandingModelConfig } from "../config/types.tools.js";
import { writeChannelPairingStateSnapshot } from "../pairing/pairing-store-sqlite.test-helpers.js";
import { buildPluginCapabilityConsentReview } from "../plugins/capability-summary.js";
import { loadPluginRegistryHandle } from "../plugins/loader.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withEnv } from "../test-utils/env.js";
import { noteDoctorConfigPreflightIssues } from "./doctor-config-analysis.js";
import { warmDoctorConfigFlow } from "./doctor-config-flow-warmup.test-support.js";
import { loadAndMaybeMigrateDoctorConfig } from "./doctor-config-flow.js";
import {
  getDoctorConfigInputForTest,
  runDoctorConfigWithInput,
} from "./doctor-config-flow.test-utils.js";
import { createDoctorPrompter } from "./doctor-prompter.js";

type TerminalNote = (message: string, title?: string) => void;
type RepairParams = Parameters<
  typeof import("./doctor/repair-sequencing.js").runDoctorRepairSequence
>[0];

const terminalNoteMock = vi.hoisted(() => vi.fn<TerminalNote>());
const callGatewayMock = vi.hoisted(() => vi.fn());
const runDoctorRepairSequenceMock = vi.hoisted(() => vi.fn());
const createDoctorPluginMetadataSnapshotScopeParamsMock = vi.hoisted(() => vi.fn());
const collectDoctorPreviewNotesParamsMock = vi.hoisted(() => vi.fn());
const collectTailscaleConfigWarningsMock = vi.hoisted(() =>
  vi.fn<typeof import("./doctor-tailscale.js").collectTailscaleConfigWarnings>(async () => []),
);
vi.mock("../../packages/terminal-core/src/note.js", () => ({ note: terminalNoteMock }));

vi.mock("../gateway/call.js", () => ({ callGateway: (opts: unknown) => callGatewayMock(opts) }));

vi.mock("./doctor-tailscale.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./doctor-tailscale.js")>()),
  collectTailscaleConfigWarnings: collectTailscaleConfigWarningsMock,
}));

vi.mock("./doctor/repair-sequencing.js", async () => {
  const actual = await vi.importActual<typeof import("./doctor/repair-sequencing.js")>(
    "./doctor/repair-sequencing.js",
  );
  return {
    ...actual,
    runDoctorRepairSequence: (params: unknown) => {
      if (runDoctorRepairSequenceMock.getMockImplementation()) {
        return runDoctorRepairSequenceMock(params);
      }
      return actual.runDoctorRepairSequence(
        params as Parameters<typeof actual.runDoctorRepairSequence>[0],
      );
    },
  };
});

vi.mock("./doctor/shared/plugin-metadata-snapshot-scope.js", async () => {
  const actual = await vi.importActual<
    typeof import("./doctor/shared/plugin-metadata-snapshot-scope.js")
  >("./doctor/shared/plugin-metadata-snapshot-scope.js");
  return {
    ...actual,
    createDoctorPluginMetadataSnapshotScope: (
      params: Parameters<typeof actual.createDoctorPluginMetadataSnapshotScope>[0],
    ) => {
      const scope = actual.createDoctorPluginMetadataSnapshotScope(params);
      const dispose = vi.spyOn(scope, Symbol.asyncDispose);
      createDoctorPluginMetadataSnapshotScopeParamsMock(params, dispose);
      return scope;
    },
  };
});

vi.mock("../channels/plugins/bootstrap-registry.js", () => ({
  getBootstrapChannelPlugin: vi.fn((_channelId: string) => undefined),
}));

vi.mock("./doctor/shared/channel-legacy-config-migrate.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./doctor/shared/channel-legacy-config-migrate.js")>();
  return {
    ...actual,
    applyChannelDoctorCompatibilityMigrations: (cfg: Record<string, unknown>) => ({
      next: cfg,
      changes: [],
    }),
  };
});

vi.mock("./doctor/shared/bundled-plugin-load-paths.js", () => ({
  maybeRepairBundledPluginLoadPaths: vi.fn((cfg: Record<string, unknown>) => ({
    config: cfg,
    changes: [],
  })),
}));

vi.mock("./doctor/shared/stale-plugin-config.js", () => ({
  maybeRepairStalePluginConfig: vi.fn((cfg: Record<string, unknown>) => ({
    config: cfg,
    changes: [],
  })),
}));

vi.mock("./doctor/shared/plugin-tool-allowlist-warnings.js", () => ({
  collectBundledProviderAllowlistPolicyWarnings: vi.fn(() => []),
  collectPluginToolAllowlistWarnings: vi.fn(() => []),
}));

vi.mock("./doctor/shared/context-engine-host-compat.js", () => ({
  maybeRepairContextEngineHostCompatibility: vi.fn(async ({ cfg }) => ({
    config: cfg,
    changes: [],
  })),
}));

vi.mock("./doctor/shared/missing-configured-plugin-install.js", () => ({
  repairMissingConfiguredPluginInstalls: vi.fn(async ({ cfg }) => ({
    config: cfg,
    changes: [],
    warnings: [],
    failedPluginIds: [],
  })),
}));

vi.mock("./doctor/shared/stale-oauth-profile-shadows.js", () => ({
  repairStaleOAuthProfileShadows: vi.fn(async () => ({ changes: [], warnings: [] })),
}));

vi.mock("../plugins/setup-registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/setup-registry.js")>();
  return {
    resolvePluginSetupCliBackend: vi.fn(() => undefined),
    resolvePluginSetupRegistry: vi.fn(() => ({
      providers: [],
      cliBackends: [],
      configMigrations: [],
      autoEnableProbes: [],
      diagnostics: [],
    })),
    resolvePluginSetupAutoEnableReasons: actual.resolvePluginSetupAutoEnableReasons,
    runPluginSetupConfigMigrations: vi.fn(({ config }: { config: unknown }) => ({
      config,
      changes: [],
    })),
  };
});

// mock-isolation: Keep channel plugin loading and registry initialization outside config-flow repair coordination.
vi.mock("./doctor/shared/channel-doctor.js", () => ({
  collectChannelDoctorCompatibilityMutations: vi.fn(() => []),
  collectChannelDoctorMutableAllowlistWarnings: vi.fn(() => []),
  collectChannelDoctorPreviewWarnings: vi.fn(async () => []),
  collectChannelDoctorRepairMutations: vi.fn(async () => []),
  collectChannelDoctorStaleConfigMutations: vi.fn(async () => []),
  createChannelDoctorEmptyAllowlistPolicyHooks: vi.fn(() => ({
    extraWarningsForAccount: () => [],
    shouldSkipDefaultEmptyGroupAllowlistWarning: ({ channelName }: { channelName: string }) =>
      channelName === "googlechat" || channelName === "telegram",
  })),
  runChannelDoctorConfigSequences: vi.fn(async () => ({ changeNotes: [], warningNotes: [] })),
}));

vi.mock("./doctor/shared/preview-warnings.js", () => ({
  collectDoctorPreviewNotes: vi.fn(async (params) => {
    collectDoctorPreviewNotesParamsMock(params);
    return { infoNotes: [], warningNotes: [] };
  }),
}));

vi.mock("./doctor-config-preflight.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./doctor-config-preflight.js")>();
  const { hashConfigRaw } = await import("../config/io.read-helpers.js");
  const { findDoctorLegacyConfigIssues } = await import("./doctor/shared/legacy-config-issues.js");
  return {
    ...actual,
    runDoctorConfigPreflight: vi.fn(async () => {
      const input = expectDefined(getDoctorConfigInputForTest(), "Doctor config fixture");
      const parsed = structuredClone(input.parsed ?? input.config);
      const config = structuredClone(input.config);
      const raw = input.exists ? JSON.stringify(parsed) : null;
      const legacyIssues =
        input.preflightMode === "fast" ? [] : findDoctorLegacyConfigIssues(parsed, parsed);
      return {
        snapshot: {
          exists: input.exists,
          path: input.path,
          raw,
          hash: hashConfigRaw(raw),
          parsed,
          agentRosterIncludeOwned: input.agentRosterIncludeOwned === true,
          ...(input.includeProvenance ? { includeProvenance: input.includeProvenance } : {}),
          sourceConfigBeforeMigrations: structuredClone(
            input.sourceConfigBeforeMigrations ?? config,
          ),
          config,
          runtimeConfig: config,
          sourceConfig: config,
          valid: legacyIssues.length === 0,
          warnings: [],
          legacyIssues,
        },
        baseConfig: config,
      };
    }),
  };
});

function runConfig(
  params: Omit<Parameters<typeof runDoctorConfigWithInput>[0], "run">,
  options: Partial<Parameters<typeof loadAndMaybeMigrateDoctorConfig>[0]> = {},
) {
  return runDoctorConfigWithInput({
    ...params,
    run: (args) => loadAndMaybeMigrateDoctorConfig({ ...args, ...options }),
  });
}

async function inspectConfig(...params: Parameters<typeof runConfig>) {
  await (await runConfig(...params))[Symbol.asyncDispose]();
}

function repairResult(state: unknown, overrides: Record<string, unknown> = {}) {
  return { state, changeNotes: [], warningNotes: [], authProfilesRepaired: false, ...overrides };
}

function mockRepair(overrides: Record<string, unknown> = {}) {
  runDoctorRepairSequenceMock.mockImplementation(async ({ state }: { state: unknown }) =>
    repairResult(state, overrides),
  );
}

function noteText(title?: string) {
  return terminalNoteMock.mock.calls
    .filter(([, heading]) => title === undefined || heading === title)
    .map(([message]) => message)
    .join("\n");
}

function expectNote(title: string, ...parts: string[]) {
  expect(
    terminalNoteMock.mock.calls.some(
      ([message, heading]) => heading === title && parts.every((part) => message.includes(part)),
    ),
  ).toBe(true);
}

async function collectDoctorWarnings(config: Record<string, unknown>): Promise<string[]> {
  terminalNoteMock.mockClear();
  await inspectConfig({ config });
  return terminalNoteMock.mock.calls
    .filter(([, title]) => title === "Doctor warnings")
    .map(([message]) => message);
}

describe("doctor config flow", () => {
  beforeAll(() => warmDoctorConfigFlow(collectDoctorWarnings));

  beforeEach(() => {
    clearRuntimeConfigSnapshot();
    terminalNoteMock.mockClear();
    callGatewayMock.mockReset();
    callGatewayMock.mockResolvedValue({});
    runDoctorRepairSequenceMock.mockReset();
    createDoctorPluginMetadataSnapshotScopeParamsMock.mockClear();
    collectDoctorPreviewNotesParamsMock.mockClear();
    collectTailscaleConfigWarningsMock.mockClear();
    collectTailscaleConfigWarningsMock.mockResolvedValue([]);
  });

  afterEach(() => clearRuntimeConfigSnapshot());

  it.each([false, true])(
    "preserves explicit collaborative steering %s without a repair",
    async (value) => {
      const config: OpenClawConfig = {
        agents: { entries: { main: {} } },
        gateway: { mode: "local" },
        messages: {
          responsePrefix: "keep-prefix",
          queue: { allowCollaborativeSteering: value, cap: 8 },
        },
      };

      await using result = await runConfig({ config, repair: true });

      expect(result.cfg).toEqual(config);
      expect(result.shouldWriteConfig).toBe(false);
    },
  );

  it.each([
    ["valid", { gateway: { mode: "local" } }, true, "loaded", "local"],
    ["absent", {}, false, "loaded", undefined],
    ["invalid", { gateway: { bind: "localhost" } }, true, "error", undefined],
  ] as const)(
    "prepares runtime config for registration only with %s config",
    async (_name, config, exists, status, mode) => {
      await withTempHome(async (home) => {
        const pluginDir = path.join(home, "config-reader");
        await fs.mkdir(pluginDir);
        await writeFixtureJson(path.join(pluginDir, "openclaw.plugin.json"), {
          id: "config-reader",
          kind: "context-engine",
          configSchema: { type: "object", additionalProperties: false },
        });
        await fs.writeFile(
          path.join(pluginDir, "index.cjs"),
          `module.exports = {
        id: "config-reader",
        register(api) {
          const expected = ${JSON.stringify(mode)};
          if (api.runtime.config.current().gateway?.mode !== expected) throw new Error("unexpected runtime config");
        },
      };`,
        );
        let registry: ReturnType<typeof loadPluginRegistryHandle> | undefined;
        collectDoctorPreviewNotesParamsMock.mockImplementationOnce(() => {
          registry = withEnv({ OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" }, () =>
            loadPluginRegistryHandle({
              cache: false,
              onlyPluginIds: ["config-reader"],
              config: {
                plugins: {
                  allow: ["config-reader"],
                  load: { paths: [pluginDir] },
                  slots: { contextEngine: "config-reader", memory: "none" },
                },
              },
            }),
          );
        });
        await using resources = new AsyncDisposableStack();
        resources.use(await runConfig({ config, exists, preflightMode: "issues" }));
        expect(registry?.plugins).toContainEqual(
          expect.objectContaining({
            id: "config-reader",
            status,
            ...(status === "error"
              ? { error: expect.stringContaining("Runtime config is not prepared") }
              : {}),
          }),
        );
        expect(readRuntimeConfig().gateway?.mode).toBe(mode);
      });
    },
  );

  it("publishes repaired runtime config when the source config was invalid", async () => {
    await using result = await runConfig({
      config: { gateway: { bind: "localhost" } },
      repair: true,
      preflightMode: "compat",
    });

    expect(result).toMatchObject({
      sourceConfigValid: false,
      shouldWriteConfig: true,
      cfg: { gateway: { bind: "loopback" } },
    });
    expect(readRuntimeConfig().gateway?.bind).toBe("loopback");
  });

  it("previews and persists context-budget migration with every path reported", async () => {
    const model = { id: "gpt-5.4", name: "GPT-5.4" };
    const budget = { contextTokens: 64_000, contextWindow: 128_000 };
    const canonical = {
      models: { providers: { openai: { models: [{ ...model, ...budget }] } } },
      agents: { defaults: {}, entries: { ops: {} } },
    };
    const legacy = {
      models: { providers: { openai: { ...budget, models: [model] } } },
      agents: { defaults: { contextTokens: 48_000 }, entries: { ops: { contextTokens: 32_000 } } },
    };

    await inspectConfig({
      config: legacy,
      parsedConfig: legacy,
      sourceConfigBeforeMigrations: legacy,
      preflightMode: "issues",
    });
    const previewText = noteText();
    expect(terminalNoteMock.mock.calls.map(([, title]) => title)).toContain(
      "Doctor changes preview",
    );
    expect(terminalNoteMock.mock.calls.map(([, title]) => title)).not.toContain("Doctor changes");
    expect(previewText).toContain(
      "models.providers.openai.contextTokens → models.providers.openai.models[0].contextTokens",
    );
    expect(previewText).toContain("Removed agents.defaults.contextTokens");
    expect(previewText).toContain("Removed agents.entries.ops.contextTokens");
    expect(previewText).toContain("models.providers.<provider>.models[].contextTokens");

    terminalNoteMock.mockClear();
    await using repaired = await runConfig({
      config: legacy,
      parsedConfig: legacy,
      sourceConfigBeforeMigrations: legacy,
      repair: true,
      preflightMode: "compat",
    });

    expect(repaired.shouldWriteConfig).toBe(true);
    expect(repaired.cfg).toMatchObject(canonical);
    expect(repaired.pendingChangePanels?.join("\n")).toContain(
      "Removed models.providers.openai.contextWindow after baking it into explicit model entries.",
    );
    expect(noteText()).toContain(
      "agents.entries.ops.contextTokens cannot be represented per model",
    );
  });

  it("preserves ownership of an explicitly empty included roster", async () => {
    await using result = await runConfig({
      config: {
        agents: { entries: { main: {} } },
        messages: { queue: { allowCollaborativeSteering: true } },
      },
      parsedConfig: { $include: "./agents.json" },
      sourceConfigBeforeMigrations: { agents: { entries: {} } },
      agentRosterIncludeOwned: true,
      repair: true,
    });

    expect(result.shouldWriteConfig).toBe(false);
    expect(result.cfg.agents?.entries).toEqual({ main: {} });
  });

  it("releases metadata scope only after disposal or preparation failure", async () => {
    await using result = await runConfig({ config: {} });
    const dispose = createDoctorPluginMetadataSnapshotScopeParamsMock.mock.lastCall?.[1];
    expect(dispose).not.toHaveBeenCalled();
    await result[Symbol.asyncDispose]();
    expect(dispose).toHaveBeenCalledOnce();

    const failure = new Error("Fixture config inspection failed");
    collectTailscaleConfigWarningsMock.mockRejectedValueOnce(failure);
    await expect(runConfig({ config: {} })).rejects.toBe(failure);
    expect(
      createDoctorPluginMetadataSnapshotScopeParamsMock.mock.lastCall?.[1],
    ).toHaveBeenCalledOnce();
  });

  it("does not treat noninteractive doctor fix as plugin capability consent", async () => {
    const review = buildPluginCapabilityConsentReview({
      pluginId: "demo",
      manifest: { name: "Demo", contracts: { tools: ["demo.write"] } },
      record: { source: "npm", spec: "@example/demo" },
      config: {},
    });
    let acknowledgment: unknown = "not reviewed";
    runDoctorRepairSequenceMock.mockImplementation(async (params: RepairParams) => {
      acknowledgment = await expectDefined(
        params.onCapabilityConsent,
        "doctor capability handler",
      )(review);
      return repairResult(params.state);
    });
    const prompter = createDoctorPrompter({
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      options: { repair: true, yes: true, nonInteractive: true },
    });
    await inspectConfig({ config: {}, repair: true }, { prompter });

    expect(acknowledgment).toBeUndefined();
    expect(terminalNoteMock).toHaveBeenCalledWith(
      expect.stringContaining("demo.write"),
      "Plugin capabilities",
    );
  });

  it("collects plugin blocker previews from the pre-auto-enable config", async () => {
    await inspectConfig({
      config: {
        plugins: { allow: ["existing-plugin"], entries: { browser: { config: {} } } },
        tools: { alsoAllow: ["browser"] },
      },
    });

    expect(collectDoctorPreviewNotesParamsMock.mock.lastCall?.[0]).toMatchObject({
      cfg: { plugins: { allow: ["existing-plugin", "browser"] } },
      activationSourceConfig: { plugins: { allow: ["existing-plugin"] } },
    });
  });

  it("does not refresh gateway before writing a config-only auth repair", async () => {
    runDoctorRepairSequenceMock.mockImplementation(async ({ state }: RepairParams) => {
      const repaired = { ...state.candidate, auth: { order: {} } };
      return repairResult(
        { ...state, cfg: repaired, candidate: repaired, pendingChanges: true },
        { changeNotes: ["Removed a stale configured auth order."] },
      );
    });

    await using result = await runConfig({
      config: { auth: { order: { anthropic: ["anthropic:missing"] } } },
      repair: true,
    });

    expect(result.shouldWriteConfig).toBe(true);
    expect(result.cfg.auth?.order).toEqual({});
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it("keeps doctor repair silent when gateway secrets reload fails", async () => {
    callGatewayMock.mockRejectedValueOnce(new Error("gateway unavailable"));
    mockRepair({ authProfilesRepaired: true });

    await inspectConfig({ config: {}, repair: true });
    expect(callGatewayMock.mock.calls.map(([request]) => request.method)).toEqual([
      "secrets.reload",
      "models.authStatus",
    ]);
  });

  it.each([false, true])(
    "preserves auth warning delivery with a findings reporter: %s",
    async (withReporter) => {
      const warning = "Could not verify imported auth profiles; originals retained.";
      const reportFindings = vi.fn();
      runDoctorRepairSequenceMock.mockImplementation(async (params: RepairParams) => {
        params.reportFindings?.([], [warning]);
        return repairResult(params.state, { warningNotes: [warning], displayWarningNotes: [] });
      });
      await using result = await runConfig(
        { config: {}, repair: true },
        withReporter ? { reportFindings } : {},
      );
      expect(result.warnings).toContain(warning);
      if (withReporter) {
        expect(reportFindings).toHaveBeenCalledWith([], [warning]);
        expect(terminalNoteMock).not.toHaveBeenCalledWith(warning, "Doctor warnings");
      } else {
        expect(terminalNoteMock).toHaveBeenCalledWith(warning, "Doctor warnings");
      }
    },
  );

  it("emits warning-only stale channel cleanup without changing config", async () => {
    const input = {
      agents: { entries: { ops: {} } },
      channels: { matrix: { enabled: true } },
      messages: { queue: { allowCollaborativeSteering: true } },
    };
    const channelDoctor = await import("./doctor/shared/channel-doctor.js");
    vi.mocked(channelDoctor.collectChannelDoctorStaleConfigMutations).mockResolvedValueOnce([
      {
        config: { ...input, channels: { matrix: { enabled: false } } },
        changes: [],
        warnings: ["- matrix stale cleanup warning"],
      },
    ]);
    mockRepair();

    await using result = await runConfig({ config: input, repair: true });

    expect(terminalNoteMock).toHaveBeenCalledWith(
      "- matrix stale cleanup warning",
      "Doctor warnings",
    );
    expect(result.cfg).toEqual(input);
    expect(result.shouldWriteConfig).toBe(false);
  });

  it("previews hooks token repair without mutation and generates a replacement on repair", async () => {
    const config = {
      gateway: { auth: { mode: "token", token: "shared-gateway-token-1234567890" } },
      hooks: { enabled: true, token: "shared-gateway-token-1234567890" },
    };
    await using preview = await runConfig({ config });

    expect(preview.shouldWriteConfig).toBe(false);
    expect(preview.cfg.hooks?.token).toBe("shared-gateway-token-1234567890");
    expectNote("Doctor changes preview", "Rotated hooks.token because it reused active Gateway");
    expectNote("Doctor", "openclaw doctor --fix", "rotate hooks.token");

    expect(readRuntimeConfig().hooks?.token).toBe(config.hooks.token);
    await using repair = await runConfig({ config, repair: true });
    expect(repair.cfg.hooks?.token).toMatch(/^[0-9a-f]{48}$/);
  });

  it("reports invalid CLI media models without repairing them", async () => {
    const models = [
      { provider: "fixture-provider", capabilities: ["audio"] },
      { type: "cli", capabilities: ["audio"] },
      { type: "cli", command: "fixture-transcribe", capabilities: ["audio"] },
      { type: "cli", command: "fixture-transcribe", args: ["{{AttachmentPath}}"] },
      { command: "fixture-transcribe", args: ["/synthetic/audio.wav"] },
    ] satisfies MediaUnderstandingModelConfig[];
    const config: OpenClawConfig = {
      plugins: { enabled: false },
      tools: { media: { models } },
      messages: { queue: { allowCollaborativeSteering: true } },
    };
    config.agents = { entries: { main: {} } };
    await using result = await runConfig({ config, repair: true });
    const warnings = noteText("Doctor warnings");
    expect(warnings).toContain("tools.media.models[1].command");
    expect(warnings).toContain("tools.media.models[2].args");
    expect(warnings).toContain("{{AttachmentPath}}");
    expect(warnings).toContain("Doctor cannot choose");
    expect(warnings).not.toMatch(/tools\.media\.models\[(?:0|3|4)\]/);
    expect(result.cfg.tools?.media).toEqual(config.tools?.media);
    expect(result.shouldWriteConfig, result.pendingChangePanels?.join("\n")).toBe(false);
  });

  it("warns when internal hook entries include unsupported loader keys", async () => {
    const entries = {
      "custom-hook": {
        enabled: true,
        handler: "./hooks/custom.ts",
        extraDirs: ["./hooks"],
        env: { OPENCLAW_CUSTOM_HOOK: "1" },
      },
      "valid-hook": { enabled: true, paths: ["./tracked"] },
      "null-hook": null,
    };
    const warning = (await collectDoctorWarnings({ hooks: { internal: { entries } } })).join("\n");
    expect(warning).toContain("hooks.internal.entries.custom-hook:");
    expect(warning).toContain(
      "unsupported loader keys handler, extraDirs will not load hook modules",
    );
    expect(warning).toContain("bootstrap-extra-files for session bootstrap content");
    expect(warning).toContain("Doctor cannot rewrite this automatically");
    expect(warning).not.toContain("hooks.internal.entries.valid-hook");
    expect(warning).not.toContain("hooks.internal.entries.null-hook");
  });

  it("sanitizes config-derived doctor warnings and changes before logging", async () => {
    await using result = await runConfig({
      repair: true,
      config: {
        channels: {
          telegram: {
            accounts: { work: { botToken: "tok", allowFrom: ["@\u001b[31mtestuser"] } },
          },
          slack: {
            accounts: {
              work: { allowFrom: ["alice\u001b[31m\nforged"] },
              "ops\u001b[31m\nopen": { dmPolicy: "open" },
            },
          },
          whatsapp: { accounts: { "ops\u001b[31m\nempty": { groupPolicy: "allowlist" } } },
        },
      },
    });

    const outputs = [
      ...terminalNoteMock.mock.calls
        .filter((call) => call[1] === "Doctor warnings" || call[1] === "Doctor changes")
        .map((call) => call[0]),
      ...(result.pendingChangePanels ?? []),
    ];
    const joinedOutputs = outputs.join("\n");
    expect(outputs.some((line) => line.includes("\u001b"))).toBe(false);
    expect(outputs.some((line) => line.includes("\nforged"))).toBe(false);
    expect(joinedOutputs).toContain('channels.slack.accounts.opsopen.allowFrom: set to ["*"]');
    expect(joinedOutputs).toContain('required by dmPolicy="open"');
    expect(
      outputs.some(
        (line) =>
          line.includes('channels.whatsapp.accounts.opsempty.groupPolicy is "allowlist"') &&
          line.includes("groupAllowFrom"),
      ),
    ).toBe(true);
  });

  it('repairs dmPolicy="allowlist" by restoring allowFrom from pairing store on repair', async () => {
    const result = await withTempHome(
      async () => {
        writeChannelPairingStateSnapshot("telegram", {
          version: 1,
          requests: [],
          allowFrom: { default: ["12345"] },
        });
        await using repaired = await runConfig({
          config: { channels: { telegram: { botToken: "fake-token", dmPolicy: "allowlist" } } },
          repair: true,
        });
        return repaired.cfg;
      },
      { skipSessionCleanup: true },
    );
    closeOpenClawStateDatabaseForTest();

    expect(result.channels?.telegram?.dmPolicy).toBe("allowlist");
    expect(result.channels?.telegram?.allowFrom).toEqual(["12345"]);
  });

  it("migrates legacy toolsBySender keys to typed id entries on repair", async () => {
    await using result = await runConfig({
      repair: true,
      preflightMode: "compat",
      config: {
        channels: {
          whatsapp: {
            groups: {
              "123@g.us": {
                toolsBySender: {
                  owner: { allow: ["exec"] },
                  alice: { deny: ["exec"] },
                  "id:owner": { deny: ["exec"] },
                  "username:@ops-bot": { allow: ["fs.read"] },
                  "*": { deny: ["exec"] },
                },
              },
            },
          },
        },
      },
    });

    const toolsBySender = expectDefined(
      result.cfg.channels?.whatsapp?.groups?.["123@g.us"]?.toolsBySender,
      "repaired sender policies",
    );
    expect(toolsBySender.owner).toBeUndefined();
    expect(toolsBySender.alice).toBeUndefined();
    expect(toolsBySender["id:owner"]).toEqual({ allow: ["exec"] });
    expect(toolsBySender["id:alice"]).toEqual({ deny: ["exec"] });
    expect(toolsBySender["username:@ops-bot"]).toEqual({ allow: ["fs.read"] });
    expect(toolsBySender["*"]).toEqual({ deny: ["exec"] });
  });

  it("sets skipPluginValidationOnWrite when legacy migration is only partially valid (#76800)", async () => {
    await using result = await runConfig({
      config: { gateway: { bind: "localhost", port: "invalid" } },
      repair: true,
      preflightMode: "compat",
    });
    expect(result.skipPluginValidationOnWrite).toBe(true);
  });
  it("surfaces include confinement hint for escaped include paths", () => {
    noteDoctorConfigPreflightIssues(
      {
        path: "/tmp/openclaw-config/openclaw.json",
        exists: true,
        raw: '{"$include":"/etc/passwd"}',
        parsed: { $include: "/etc/passwd" },
        sourceConfig: {},
        resolved: {},
        runtimeConfig: {},
        config: {},
        valid: false,
        warnings: [],
        legacyIssues: [],
        issues: [
          {
            path: "$include",
            message: "Include path escapes config directory: /etc/passwd",
          },
        ],
      },
      { activeRepair: false },
    );

    expect(terminalNoteMock).toHaveBeenCalledWith(
      [
        "- $include paths must stay under: /tmp/openclaw-config",
        '- Move shared include files under that directory and update to relative paths like "./shared/common.json".',
        "- Error: Include path escapes config directory: /etc/passwd",
      ].join("\n"),
      "Doctor warnings",
    );
  });
});
