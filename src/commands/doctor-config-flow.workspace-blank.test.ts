// Doctor config-flow orchestration for a saved blank workspace (P1-b): the real
// shared Doctor migration must strip the blank before Doctor resolves the
// sole-agent workspace, so a strict resolver cannot abort the repair.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadAndMaybeMigrateDoctorConfig } from "./doctor-config-flow.js";
import {
  getDoctorConfigInputForTest,
  runDoctorConfigWithInput,
} from "./doctor-config-flow.test-utils.js";

const terminalNoteMock = vi.hoisted(() => vi.fn());
const callGatewayMock = vi.hoisted(() => vi.fn());
const runDoctorConfigPreflightOptionsMock = vi.hoisted(() => vi.fn());
const prepareTailscaleConfigMigrationMock = vi.hoisted(() =>
  vi.fn(({ cfg }: { cfg: Record<string, unknown> }) => ({
    config: cfg,
    changes: [],
    warnings: [],
  })),
);
const collectImplicitFallbackClobberWarningsMock = vi.hoisted(() =>
  vi.fn<(cfg: unknown) => string[]>(() => []),
);
const noteImplicitFallbackClobberWarningsMock = vi.hoisted(() =>
  vi.fn<(cfg: unknown) => void>((cfg) => {
    const warnings = collectImplicitFallbackClobberWarningsMock(cfg);
    if (warnings.length > 0) {
      terminalNoteMock(warnings.join("\n"), "Doctor warnings");
    }
  }),
);

vi.mock("../../packages/terminal-core/src/note.js", () => ({
  note: terminalNoteMock,
}));

vi.mock("../gateway/call.js", () => ({
  callGateway: (opts: unknown) => callGatewayMock(opts),
}));

vi.mock("./doctor-tailscale.js", () => ({
  prepareTailscaleConfigMigration: prepareTailscaleConfigMigrationMock,
}));

vi.mock("./doctor-config-preflight.js", async () => {
  const fsLocal = await import("node:fs/promises");
  const pathLocal = await import("node:path");
  const { hashConfigRaw } = await import("../config/io.read-helpers.js");
  const { findLegacyConfigIssues } = await import("../config/legacy.js");
  const { listPluginDoctorLegacyConfigRules } =
    await import("../plugins/doctor-contract-registry.js");

  function resolveConfigPath() {
    const stateDir =
      process.env.OPENCLAW_STATE_DIR ||
      (process.env.HOME ? pathLocal.join(process.env.HOME, ".openclaw") : "");
    return process.env.OPENCLAW_CONFIG_PATH || pathLocal.join(stateDir, "openclaw.json");
  }

  return {
    runDoctorConfigPreflight: vi.fn(async (options: unknown) => {
      runDoctorConfigPreflightOptionsMock(options);
      const injected = getDoctorConfigInputForTest();
      const configPath = injected?.path ?? resolveConfigPath();
      let parsed: Record<string, unknown> = injected?.parsed
        ? structuredClone(injected.parsed)
        : injected?.config
          ? structuredClone(injected.config)
          : {};
      let injectedEffectiveConfig = injected?.config ? structuredClone(injected.config) : parsed;
      let exists = injected?.exists ?? false;
      let raw: string | null = exists ? JSON.stringify(parsed) : null;
      if (!injected) {
        try {
          const contents = await fsLocal.readFile(configPath, "utf-8");
          parsed = JSON.parse(contents) as Record<string, unknown>;
          raw = contents;
          exists = true;
          injectedEffectiveConfig = parsed;
        } catch {
          parsed = {};
          injectedEffectiveConfig = parsed;
        }
      }
      const sourceConfigBeforeMigrations = injected?.sourceConfigBeforeMigrations
        ? structuredClone(injected.sourceConfigBeforeMigrations)
        : injectedEffectiveConfig;
      if (injected?.preflightMode === "fast") {
        return {
          snapshot: {
            exists,
            path: configPath,
            raw,
            hash: hashConfigRaw(raw),
            parsed,
            agentRosterIncludeOwned: injected?.agentRosterIncludeOwned === true,
            sourceConfigBeforeMigrations,
            config: injectedEffectiveConfig,
            sourceConfig: injectedEffectiveConfig,
            valid: true,
            warnings: [],
            legacyIssues: [],
          },
          baseConfig: injectedEffectiveConfig,
        };
      }
      const legacyIssues = findLegacyConfigIssues(
        parsed,
        parsed,
        listPluginDoctorLegacyConfigRules({ pluginIds: [] }),
      );
      return {
        snapshot: {
          exists,
          path: configPath,
          raw,
          hash: hashConfigRaw(raw),
          parsed,
          agentRosterIncludeOwned: injected?.agentRosterIncludeOwned === true,
          sourceConfigBeforeMigrations,
          config: injectedEffectiveConfig,
          sourceConfig: injectedEffectiveConfig,
          valid: legacyIssues.length === 0,
          warnings: [],
          legacyIssues,
        },
        baseConfig: injectedEffectiveConfig,
      };
    }),
  };
});

describe("doctor config flow (saved blank workspace)", () => {
  beforeEach(() => {
    terminalNoteMock.mockClear();
    callGatewayMock.mockReset();
    callGatewayMock.mockResolvedValue({});
    prepareTailscaleConfigMigrationMock.mockClear();
    prepareTailscaleConfigMigrationMock.mockImplementation(
      ({ cfg }: { cfg: Record<string, unknown> }) => ({
        config: cfg,
        changes: [],
        warnings: [],
      }),
    );
    collectImplicitFallbackClobberWarningsMock.mockClear();
    collectImplicitFallbackClobberWarningsMock.mockReturnValue([]);
    noteImplicitFallbackClobberWarningsMock.mockClear();
  });

  it("migrates a saved blank workspace before Doctor resolves it so a sole agent can be repaired", async () => {
    const result = await runDoctorConfigWithInput({
      config: {
        agents: { entries: { main: { workspace: " " } } },
        gateway: { mode: "local" },
      },
      repair: true,
      preflightMode: "compat",
      run: loadAndMaybeMigrateDoctorConfig,
    });

    // The strict resolver (which throws on an explicit blank) must not abort the
    // repair: Doctor resolves the sole-agent workspace as omitted and the shared
    // migration strips the saved blank so the agent keeps its default directory.
    expect(result.cfg.agents?.entries?.main?.workspace).toBeUndefined();
    expect(result.shouldWriteConfig).toBe(true);
    expect(result.pendingChangePanels?.join("\n")).toContain(
      "Removed blank agents.entries.main.workspace",
    );
  });
});
