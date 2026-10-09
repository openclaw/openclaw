import { expectDefined } from "@openclaw/normalization-core";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { MediaUnderstandingModelConfig } from "../config/types.tools.js";
import { writeChannelPairingStateSnapshot } from "../pairing/pairing-store-sqlite.test-helpers.js";
import type { PluginCapabilityConsentHandler } from "../plugins/capability-consent.js";
import { buildPluginCapabilityConsentReview } from "../plugins/capability-summary.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { noteDoctorConfigPreflightIssues } from "./doctor-config-analysis.js";
import { warmDoctorConfigFlow } from "./doctor-config-flow-warmup.test-support.js";
import { loadAndMaybeMigrateDoctorConfig } from "./doctor-config-flow.js";
import {
  getDoctorConfigInputForTest,
  runDoctorConfigWithInput,
} from "./doctor-config-flow.test-utils.js";
import { createDoctorPrompter } from "./doctor-prompter.js";

type TerminalNote = (message: string, title?: string) => void;

const terminalNoteMock = vi.hoisted(() => vi.fn<TerminalNote>());
const callGatewayMock = vi.hoisted(() => vi.fn());
const runDoctorRepairSequenceMock = vi.hoisted(() => vi.fn());
const createDoctorPluginMetadataSnapshotScopeParamsMock = vi.hoisted(() => vi.fn());
const collectDoctorPreviewNotesParamsMock = vi.hoisted(() => vi.fn());
const prepareTailscaleConfigMigrationMock = vi.hoisted(() =>
  vi.fn(({ cfg }: { cfg: OpenClawConfig }) => ({
    config: cfg,
    changes: [] as string[],
    warnings: [] as string[],
  })),
);
vi.mock("../../packages/terminal-core/src/note.js", () => ({ note: terminalNoteMock }));

vi.mock("../gateway/call.js", () => ({ callGateway: (opts: unknown) => callGatewayMock(opts) }));

vi.mock("./doctor-tailscale.js", () => ({
  prepareTailscaleConfigMigration: prepareTailscaleConfigMigrationMock,
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
      createDoctorPluginMetadataSnapshotScopeParamsMock(params);
      return actual.createDoctorPluginMetadataSnapshotScope(params);
    },
  };
});

vi.mock("../channels/plugins/bootstrap-registry.js", () => ({
  getBootstrapChannelPlugin: vi.fn((_channelId: string) => undefined),
}));

vi.mock("./doctor/shared/channel-legacy-config-migrate.js", () => ({
  applyChannelDoctorCompatibilityMigrations: (cfg: Record<string, unknown>) => ({
    next: cfg,
    changes: [],
  }),
}));

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

vi.mock("./doctor-config-preflight.js", async () => {
  const { hashConfigRaw } = await import("../config/io.read-helpers.js");
  const { findDoctorLegacyConfigIssues } = await import("./doctor/shared/legacy-config-issues.js");
  return {
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

function runConfig(params: Omit<Parameters<typeof runDoctorConfigWithInput>[0], "run">) {
  return runDoctorConfigWithInput({ ...params, run: loadAndMaybeMigrateDoctorConfig });
}

async function collectDoctorWarnings(config: Record<string, unknown>): Promise<string[]> {
  terminalNoteMock.mockClear();
  const noteSpy = terminalNoteMock;
  await runConfig({ config });
  const warnings: string[] = [];
  for (const [message, title] of noteSpy.mock.calls) {
    if (title === "Doctor warnings") {
      warnings.push(message);
    }
  }
  return warnings;
}

describe("doctor config flow", () => {
  beforeAll(() => warmDoctorConfigFlow(collectDoctorWarnings));

  beforeEach(() => {
    terminalNoteMock.mockClear();
    callGatewayMock.mockReset();
    callGatewayMock.mockResolvedValue({});
    runDoctorRepairSequenceMock.mockReset();
    createDoctorPluginMetadataSnapshotScopeParamsMock.mockClear();
    collectDoctorPreviewNotesParamsMock.mockClear();
    prepareTailscaleConfigMigrationMock.mockClear();
    prepareTailscaleConfigMigrationMock.mockImplementation(({ cfg }) => ({
      config: cfg,
      changes: [],
      warnings: [],
    }));
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

    await runConfig({
      config: legacy,
      parsedConfig: legacy,
      sourceConfigBeforeMigrations: legacy,
      preflightMode: "issues",
    });
    const previewText = terminalNoteMock.mock.calls.map(([message]) => message).join("\n");
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
    const repaired = await runConfig({
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
    expect(terminalNoteMock.mock.calls.map(([message]) => message).join("\n")).toContain(
      "agents.entries.ops.contextTokens cannot be represented per model",
    );
  });

  it("preserves ownership of an explicitly empty included roster", async () => {
    const result = await runConfig({
      config: { agents: { entries: { main: {} } } },
      parsedConfig: { $include: "./agents.json" },
      sourceConfigBeforeMigrations: { agents: { entries: {} } },
      agentRosterIncludeOwned: true,
      repair: true,
    });

    expect(result.shouldWriteConfig).toBe(false);
    expect(result.cfg.agents?.entries).toEqual({ main: {} });
  });

  it("exposes cleanup-refreshed plugin metadata to later Doctor scopes", async () => {
    const refreshedSnapshot = {
      plugins: [],
      index: { installRecords: {} },
    } as unknown as PluginMetadataSnapshot;
    runDoctorRepairSequenceMock.mockImplementation(async (params: { state: unknown }) => ({
      state: params.state,
      changeNotes: ['Removed stale managed install record for bundled plugin "google-meet".'],
      warningNotes: [],
      authProfilesRepaired: false,
      pluginMetadataSnapshot: refreshedSnapshot,
    }));

    const result = await runConfig({ config: {}, repair: true });

    expect(result.pluginMetadataSnapshot).toBe(refreshedSnapshot);
    const scopeParams = createDoctorPluginMetadataSnapshotScopeParamsMock.mock.lastCall?.[0] as {
      getBaseSnapshot: () => PluginMetadataSnapshot | undefined;
    };
    expect(scopeParams.getBaseSnapshot()).toBe(refreshedSnapshot);
    expect(scopeParams.getBaseSnapshot()?.index.installRecords).not.toHaveProperty("google-meet");
    result.invalidatePluginMetadataSnapshot();
    expect(scopeParams.getBaseSnapshot()).toBeUndefined();
  });

  it("does not treat noninteractive doctor fix as plugin capability consent", async () => {
    const review = buildPluginCapabilityConsentReview({
      pluginId: "demo",
      manifest: { name: "Demo", contracts: { tools: ["demo.write"] } },
      record: { source: "npm", spec: "@example/demo" },
      config: {},
    });
    let acknowledgment: unknown = "not reviewed";
    runDoctorRepairSequenceMock.mockImplementation(
      async (params: { state: unknown; onCapabilityConsent?: PluginCapabilityConsentHandler }) => {
        acknowledgment = await expectDefined(
          params.onCapabilityConsent,
          "doctor capability handler",
        )(review);
        return {
          state: params.state,
          changeNotes: [],
          warningNotes: [],
          authProfilesRepaired: false,
        };
      },
    );
    const prompter = createDoctorPrompter({
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      options: { repair: true, yes: true, nonInteractive: true },
    });
    const confirm = vi.spyOn(prompter, "confirmRuntimeRepair");
    await runDoctorConfigWithInput({
      config: {},
      repair: true,
      run: (params) => loadAndMaybeMigrateDoctorConfig({ ...params, prompter }),
    });

    expect(acknowledgment).toBeUndefined();
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ requiresInteractiveConfirmation: true, initialValue: false }),
    );
    expect(terminalNoteMock).toHaveBeenCalledWith(
      expect.stringContaining("demo.write"),
      "Plugin capabilities",
    );
  });

  it("collects plugin blocker previews from the pre-auto-enable config", async () => {
    await runConfig({
      config: {
        plugins: { allow: ["existing-plugin"], entries: { browser: { config: {} } } },
        tools: { alsoAllow: ["browser"] },
      },
    });

    expect(collectDoctorPreviewNotesParamsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg: expect.objectContaining({
          plugins: expect.objectContaining({ allow: ["existing-plugin", "browser"] }),
        }),
        activationSourceConfig: expect.objectContaining({
          plugins: expect.objectContaining({ allow: ["existing-plugin"] }),
        }),
      }),
    );
  });

  it("does not refresh gateway before writing a config-only auth repair", async () => {
    runDoctorRepairSequenceMock.mockImplementation(
      async (params: {
        state: { cfg: Record<string, unknown>; candidate: Record<string, unknown> };
      }) => {
        const repaired = { ...params.state.candidate, auth: { order: {} } };
        return {
          state: { ...params.state, cfg: repaired, candidate: repaired, pendingChanges: true },
          changeNotes: ["Removed a stale configured auth order."],
          warningNotes: [],
          authProfilesRepaired: false,
        };
      },
    );

    const result = await runConfig({
      config: { auth: { order: { anthropic: ["anthropic:missing"] } } },
      repair: true,
    });

    expect(result.shouldWriteConfig).toBe(true);
    expect(result.cfg.auth?.order).toEqual({});
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it("keeps doctor repair silent when gateway secrets reload fails", async () => {
    callGatewayMock.mockRejectedValueOnce(new Error("gateway unavailable"));
    runDoctorRepairSequenceMock.mockImplementation(async (params: { state: unknown }) => ({
      state: params.state,
      changeNotes: ["Removed stale OAuth auth profile shadow openai-codex."],
      warningNotes: [],
      authProfilesRepaired: true,
    }));

    await expect(runConfig({ config: {}, repair: true })).resolves.toBeTruthy();

    expect(callGatewayMock).toHaveBeenNthCalledWith(1, {
      method: "secrets.reload",
      params: {},
      timeoutMs: 3000,
    });
    expect(callGatewayMock).toHaveBeenNthCalledWith(2, {
      method: "models.authStatus",
      params: { refresh: true },
      timeoutMs: 3000,
    });
  });

  it("emits warning-only stale channel cleanup without changing config", async () => {
    const input = { agents: { entries: { ops: {} } }, channels: { matrix: { enabled: true } } };
    const channelDoctor = await import("./doctor/shared/channel-doctor.js");
    vi.mocked(channelDoctor.collectChannelDoctorStaleConfigMutations).mockResolvedValueOnce([
      {
        config: { ...input, channels: { matrix: { enabled: false } } },
        changes: [],
        warnings: ["- matrix stale cleanup warning"],
      },
    ]);
    runDoctorRepairSequenceMock.mockImplementation(async (params: { state: unknown }) => ({
      state: params.state,
      changeNotes: [],
      warningNotes: [],
      authProfilesRepaired: false,
    }));

    const result = await runConfig({ config: input, repair: true });

    expect(terminalNoteMock).toHaveBeenCalledWith(
      "- matrix stale cleanup warning",
      "Doctor warnings",
    );
    expect(result.cfg).toEqual(input);
    expect(result.shouldWriteConfig).toBe(false);
  });

  it("previews and repairs hooks token reuse of gateway auth", async () => {
    const config = {
      gateway: { auth: { mode: "token", token: "shared-gateway-token-1234567890" } },
      hooks: { enabled: true, token: "shared-gateway-token-1234567890" },
    };
    const previewNotes = terminalNoteMock;
    const preview = await runConfig({ config });

    expect(preview.shouldWriteConfig).toBe(false);
    expect(preview.cfg.hooks?.token).toBe("shared-gateway-token-1234567890");
    expect(
      previewNotes.mock.calls.some(
        ([message, title]) =>
          title === "Doctor changes preview" &&
          message.includes("Rotated hooks.token because it reused active Gateway"),
      ),
    ).toBe(true);
    expect(
      previewNotes.mock.calls.some(
        ([message, title]) =>
          title === "Doctor" &&
          message.includes("openclaw doctor --fix") &&
          message.includes("rotate hooks.token"),
      ),
    ).toBe(true);

    const repair = await runConfig({ config, repair: true });

    expect(repair.shouldWriteConfig).toBe(true);
    expect(repair.cfg.hooks?.token).toMatch(/^[0-9a-f]{48}$/);
    expect(repair.cfg.hooks?.token).not.toBe("shared-gateway-token-1234567890");
  });

  it("reports invalid CLI media models without repairing them", async () => {
    const models = [
      { provider: "fixture-provider", capabilities: ["audio"] },
      { type: "cli", capabilities: ["audio"] },
      { type: "cli", command: "fixture-transcribe", capabilities: ["audio"] },
      { type: "cli", command: "fixture-transcribe", args: ["{{AttachmentPath}}"] },
      { command: "fixture-transcribe", args: ["/synthetic/audio.wav"] },
    ] satisfies MediaUnderstandingModelConfig[];
    const config: OpenClawConfig = { plugins: { enabled: false }, tools: { media: { models } } };
    config.agents = { entries: { main: {} } };
    const result = await runConfig({ config, repair: true });
    const warnings = terminalNoteMock.mock.calls
      .filter(([, title]) => title === "Doctor warnings")
      .map(([message]) => message)
      .join("\n");
    expect(warnings).toContain("tools.media.models[1].command");
    expect(warnings).toContain("tools.media.models[2].args");
    expect(warnings).toContain("{{AttachmentPath}}");
    expect(warnings).toContain("Doctor cannot choose");
    expect(warnings).not.toMatch(/tools\.media\.models\[(?:0|3|4)\]/);
    expect(result.cfg.tools?.media).toEqual(config.tools?.media);
    expect(result.shouldWriteConfig, result.pendingChangePanels?.join("\n")).toBe(false);
  });

  it("warns when internal hook entries include unsupported loader keys", async () => {
    const doctorWarnings = await collectDoctorWarnings({
      hooks: {
        internal: {
          entries: {
            "custom-hook": {
              enabled: true,
              handler: "./hooks/custom.ts",
              extraDirs: ["./hooks"],
              env: { OPENCLAW_CUSTOM_HOOK: "1" },
            },
            "valid-hook": { enabled: true, paths: ["./tracked"] },
            "null-hook": null,
          },
        },
      },
    });

    const warning = doctorWarnings.join("\n");
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
    const noteSpy = terminalNoteMock;
    try {
      const result = await runConfig({
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
        ...noteSpy.mock.calls
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
    } finally {
      noteSpy.mockClear();
    }
  });

  it("does not restore top-level allowFrom when config is intentionally default-account scoped", async () => {
    const result = await runConfig({
      repair: true,
      config: {
        channels: {
          discord: {
            accounts: {
              default: { token: "discord-default-token", allowFrom: ["123"] },
              work: { token: "discord-work-token" },
            },
          },
        },
      },
    });

    expect(result.cfg.channels?.discord?.allowFrom).toBeUndefined();
    expect(result.cfg.channels?.discord?.accounts?.default?.allowFrom).toEqual(["123"]);
  });

  it("defers absent-plugin promotion instead of creating a partial default account", async () => {
    const result = await runConfig({
      repair: true,
      config: {
        channels: {
          "uninstalled-demo": {
            dmPolicy: "allowlist",
            appToken: "covered-legacy-key",
            customAuth: "plugin-owned",
            accounts: { work: { enabled: true } },
          },
        },
      },
    });

    const channel = result.cfg.channels?.["uninstalled-demo"];
    expect(channel?.dmPolicy).toBe("allowlist");
    expect(channel?.appToken).toBe("covered-legacy-key");
    expect(channel?.customAuth).toBe("plugin-owned");
    expect(channel?.accounts).toEqual({ work: { enabled: true } });
  });

  it("seeds an empty account map for covered legacy keys without plugin declarations", async () => {
    const result = await runConfig({
      repair: true,
      config: {
        channels: {
          "legacy-demo": {
            dmPolicy: "allowlist",
            appToken: "legacy-app-token",
            accounts: {},
          },
        },
      },
    });

    const channel = result.cfg.channels?.["legacy-demo"];
    expect(channel?.dmPolicy).toBeUndefined();
    expect(channel?.appToken).toBeUndefined();
    expect(channel?.accounts).toEqual({
      default: {
        dmPolicy: "allowlist",
        appToken: "legacy-app-token",
      },
    });
  });

  it('repairs dmPolicy="allowlist" by restoring allowFrom from pairing store on repair', async () => {
    const result = await withTempHome(
      async () => {
        writeChannelPairingStateSnapshot("telegram", {
          version: 1,
          requests: [],
          allowFrom: { default: ["12345"] },
        });
        return runConfig({
          config: { channels: { telegram: { botToken: "fake-token", dmPolicy: "allowlist" } } },
          repair: true,
        });
      },
      { skipSessionCleanup: true },
    );
    closeOpenClawStateDatabaseForTest();

    expect(result.cfg.channels?.telegram?.dmPolicy).toBe("allowlist");
    expect(result.cfg.channels?.telegram?.allowFrom).toEqual(["12345"]);
  });

  it("migrates legacy toolsBySender keys to typed id entries on repair", async () => {
    const result = await runConfig({
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
    const result = await runConfig({
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
