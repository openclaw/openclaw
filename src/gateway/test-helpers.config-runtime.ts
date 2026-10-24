import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { asNonArrayRecord } from "@openclaw/normalization-core/record-coerce";
import { vi } from "vitest";
import { applyImplicitAgentRosterDefaults } from "../config/implicit-agent-roster.js";
import type { ConfigWriteOptions } from "../config/io.js";
import { applyPluginAutoEnable } from "../config/plugin-auto-enable.js";
import { finalizeRuntimeSnapshotWrite } from "../config/runtime-snapshot.js";
import { getRuntimeConfigWriteApplication } from "../config/runtime-write-application.js";
import type { AgentBinding } from "../config/types.agents.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../config/types.js";
import { validateConfigObjectWithPlugins } from "../config/validation.js";
import { writeJsonAtomic } from "../infra/json-files.js";
import { writeConfigMachineState } from "../state/config-machine-state-write.js";
import { buildTestConfigSnapshot } from "./test-helpers.config-snapshots.js";
import { testConfigRoot, testIsNixMode, testState } from "./test-helpers.runtime-state.js";

type GatewayConfigRuntime = Pick<
  typeof import("../config/io.js"),
  "getRuntimeConfigSnapshot" | "setRuntimeConfigSnapshot"
>;
type GatewayConfigOverrides = Pick<
  typeof import("../config/config.js"),
  | "CONFIG_PATH"
  | "STATE_DIR"
  | "isNixMode"
  | "applyConfigOverrides"
  | "getRuntimeConfig"
  | "parseConfigJson5"
  | "validateConfigObject"
  | "readConfigFileSnapshot"
  | "readConfigFileSnapshotWithPluginMetadata"
  | "readConfigFileSnapshotForWrite"
  | "writeConfigFile"
>;

const resolveConfigPath = () => path.join(testConfigRoot.value, "openclaw.json");

const composeTestConfig = (baseConfig: Record<string, unknown>) => {
  const fileAgents = asNonArrayRecord(baseConfig.agents);
  const defaults = {
    model: { primary: "anthropic/claude-opus-4-6" },
    workspace: path.join(testConfigRoot.value, "workspace"),
    ...asNonArrayRecord(fileAgents.defaults),
    ...testState.agentConfig,
  };
  const fileBindings = Array.isArray(baseConfig.bindings)
    ? (baseConfig.bindings as AgentBinding[])
    : undefined;

  const overrideChannels =
    testState.channelsConfig && typeof testState.channelsConfig === "object"
      ? { ...testState.channelsConfig }
      : {};
  const mergedChannels = { ...asNonArrayRecord(baseConfig.channels), ...overrideChannels };
  if (testState.allowFrom !== undefined) {
    mergedChannels.whatsapp = {
      ...asNonArrayRecord(mergedChannels.whatsapp),
      allowFrom: testState.allowFrom,
    };
  }
  const fileSession = asNonArrayRecord(baseConfig.session);
  const session: Record<string, unknown> = {
    ...fileSession,
    mainKey: fileSession.mainKey ?? "main",
    ...(typeof testState.sessionStorePath === "string"
      ? { store: testState.sessionStorePath }
      : {}),
    ...testState.sessionConfig,
  };

  const fileGateway: Record<string, unknown> = {
    ...asNonArrayRecord(baseConfig.gateway),
    ...(testState.gatewayBind ? { bind: testState.gatewayBind } : {}),
    ...(testState.gatewayAuth ? { auth: testState.gatewayAuth } : {}),
  };
  if (testState.gatewayControlUi) {
    fileGateway.controlUi = {
      ...asNonArrayRecord(fileGateway.controlUi),
      ...testState.gatewayControlUi,
    };
  }
  const fileCron = {
    ...asNonArrayRecord(baseConfig.cron),
    ...(typeof testState.cronEnabled === "boolean" ? { enabled: testState.cronEnabled } : {}),
    ...(typeof testState.cronTriggersEnabled === "boolean"
      ? { triggers: { enabled: testState.cronTriggersEnabled } }
      : {}),
  };
  if (typeof testState.cronStorePath === "string") {
    writeConfigMachineState("cron.store", testState.cronStorePath);
  }
  const composed = {
    ...baseConfig,
    agents: { ...fileAgents, ...testState.agentsConfig, defaults },
    bindings: testState.bindingsConfig ?? fileBindings,
    channels: Object.keys(mergedChannels).length > 0 ? mergedChannels : undefined,
    session,
    gateway: Object.keys(fileGateway).length > 0 ? fileGateway : undefined,
    hooks: testState.hooksConfig ?? baseConfig.hooks,
    cron: Object.keys(fileCron).length > 0 ? fileCron : undefined,
  } as OpenClawConfig;
  return applyImplicitAgentRosterDefaults(composed) as OpenClawConfig;
};

export function loadGatewayTestConfig(): OpenClawConfig {
  const configPath = resolveConfigPath();
  let fileConfig: Record<string, unknown> = {};
  try {
    if (fsSync.existsSync(configPath)) {
      const raw = fsSync.readFileSync(configPath, "utf-8");
      fileConfig = JSON.parse(raw) as Record<string, unknown>;
    }
  } catch {
    fileConfig = {};
  }
  return applyPluginAutoEnable({
    config: composeTestConfig(fileConfig),
    env: process.env,
  }).config;
}

/** Creates gateway-test overrides without importing the facade that re-exports mocked IO. */
export function createGatewayConfigOverrides(actual: GatewayConfigRuntime): GatewayConfigOverrides {
  const readConfigFileSnapshot = async (): Promise<ConfigFileSnapshot> => {
    const configPath = resolveConfigPath();
    const snapshot = (overrides: Partial<Parameters<typeof buildTestConfigSnapshot>[0]>) =>
      buildTestConfigSnapshot({
        path: configPath,
        exists: true,
        raw: null,
        parsed: {},
        valid: true,
        config: overrides.config ?? composeTestConfig({}),
        issues: [],
        legacyIssues: [],
        ...overrides,
      });
    if (testState.legacyIssues.length > 0) {
      const raw = JSON.stringify(testState.legacyParsed ?? {});
      return snapshot({
        raw,
        parsed: testState.legacyParsed ?? {},
        valid: false,
        issues: testState.legacyIssues.map(({ path: issuePath, message }) => ({
          path: issuePath,
          message,
        })),
        legacyIssues: testState.legacyIssues,
      });
    }
    try {
      await fs.access(configPath);
    } catch {
      return snapshot({ exists: false });
    }
    try {
      const raw = await fs.readFile(configPath, "utf-8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      return snapshot({ raw, parsed, config: composeTestConfig(parsed) });
    } catch (err) {
      return snapshot({
        valid: false,
        issues: [{ path: "", message: `read failed: ${String(err)}` }],
      });
    }
  };

  const writeConfigFile = vi.fn(
    async (cfg: Record<string, unknown>, options?: ConfigWriteOptions) => {
      const configPath = resolveConfigPath();
      await writeJsonAtomic(configPath, cfg, { durable: false, trailingNewline: true });
      const config = loadGatewayTestConfig();
      await finalizeRuntimeSnapshotWrite({
        nextSourceConfig: config,
        freshConfig: config,
        hadBothSnapshots: true,
        refreshOptions: options?.runtimeRefresh,
        createRefreshError: (detail, cause) => new Error(detail, { cause }),
        formatRefreshError: String,
        notifyCommittedWrite: () => {
          if (options) {
            getRuntimeConfigWriteApplication(options)?.claim()?.settle("applied");
          }
        },
      });
      return {
        persistedHash: "test-config-hash",
        persistedConfig: composeTestConfig(cfg),
      };
    },
  );

  const loadRuntimeAwareTestConfig = () => {
    const runtimeSnapshot = actual.getRuntimeConfigSnapshot();
    if (runtimeSnapshot) {
      return runtimeSnapshot;
    }
    const config = loadGatewayTestConfig();
    actual.setRuntimeConfigSnapshot(config);
    return config;
  };

  return {
    get CONFIG_PATH() {
      return resolveConfigPath();
    },
    get STATE_DIR() {
      return path.dirname(resolveConfigPath());
    },
    get isNixMode() {
      return testIsNixMode.value;
    },
    applyConfigOverrides: (cfg: OpenClawConfig) =>
      composeTestConfig(cfg as Record<string, unknown>),
    getRuntimeConfig: loadRuntimeAwareTestConfig,
    parseConfigJson5: (raw: string) => {
      try {
        return { ok: true, parsed: JSON.parse(raw) as unknown };
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    },
    validateConfigObject: (parsed: unknown) => ({
      ok: true,
      config: parsed as Record<string, unknown>,
      issues: [],
    }),
    readConfigFileSnapshot,
    readConfigFileSnapshotWithPluginMetadata: async () => {
      const snapshot = await readConfigFileSnapshot();
      const validation = validateConfigObjectWithPlugins(snapshot.config, {
        env: process.env,
        pluginValidation: "skip",
      });
      return {
        snapshot: {
          ...snapshot,
          valid: validation.ok,
          issues: validation.ok ? [] : validation.issues,
          warnings: validation.warnings,
        },
      };
    },
    readConfigFileSnapshotForWrite: async () => ({
      snapshot: await readConfigFileSnapshot(),
      writeOptions: { expectedConfigPath: resolveConfigPath() },
    }),
    writeConfigFile,
  };
}
