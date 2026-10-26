import { beforeEach, expect, it, vi } from "vitest";
import { createPluginPackagingConfigIssues } from "../../commands/test-runtime-config-helpers.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../../config/config.js";
import {
  createGatewayServiceRunArgs as createServiceRunArgs,
  lifecycleTestRuntime,
  resetLifecycleRuntimeLogs,
  resetLifecycleServiceMocks,
  service,
  stubEmptyGatewayEnv,
} from "./test-helpers/lifecycle-core-harness.js";

const readConfigFileSnapshotMock = vi.fn();
const loadConfig = vi.fn(() => ({}));
const invalidConfigRecoveryHint = [
  'Run "openclaw doctor --fix" to repair, then retry.',
  "If startup is still blocked, inspect the adjacent .bak backup before restoring it manually.",
].join("\n");
const pluginPackagingRecoveryHints = [
  "This is a plugin packaging issue, not a local config problem.",
  "Update or reinstall the plugin after the publisher ships compiled JavaScript, or disable/uninstall the plugin until then.",
] as const;
const pluginPackagingHintItems = pluginPackagingRecoveryHints.map((text) => ({
  kind: "generic",
  text,
}));

function expectLatestRuntimeJson(payload: Record<string, unknown>) {
  expect(lifecycleTestRuntime.writeJson).toHaveBeenLastCalledWith({
    ok: false,
    hints: undefined,
    hintItems: undefined,
    warnings: undefined,
    ...payload,
  });
}

function expectWarning(result: string, warning: string) {
  expect(lifecycleTestRuntime.writeJson).toHaveBeenLastCalledWith(
    expect.objectContaining({ ok: true, result, warnings: [expect.stringContaining(warning)] }),
  );
}

vi.mock("../../config/config.js", () => ({
  getRuntimeConfig: () => loadConfig(),
  loadConfig: () => loadConfig(),
  readConfigFileSnapshot: () => readConfigFileSnapshotMock(),
}));

vi.mock("../../config/issue-format.js", () => ({
  formatConfigIssueLines: (
    issues: Array<{ path: string; message: string }>,
    _prefix: string,
    _opts?: unknown,
  ) => issues.map((i) => `${i.path}: ${i.message}`),
}));

vi.mock("../../runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime.js")>()),
  defaultRuntime: lifecycleTestRuntime,
}));

function setConfigSnapshot(
  params: Partial<Pick<ConfigFileSnapshot, "valid" | "issues" | "warnings">> = {},
  config: OpenClawConfig = {},
) {
  readConfigFileSnapshotMock.mockResolvedValue({
    exists: true,
    valid: true,
    config,
    sourceConfig: config,
    issues: [],
    warnings: [],
    legacyIssues: [],
    ...params,
  });
}

function setInvalidConfig(path: string) {
  setConfigSnapshot({
    valid: false,
    issues: [{ path, message: "Unrecognized key" }],
  });
}

import {
  runServiceRestart,
  runServiceStart,
  runServiceStop,
  runServiceUninstall,
} from "./lifecycle-core.js";

beforeEach(() => {
  resetLifecycleRuntimeLogs();
  readConfigFileSnapshotMock.mockReset();
  setConfigSnapshot();
  loadConfig.mockReset();
  loadConfig.mockReturnValue({});
  resetLifecycleServiceMocks();
  stubEmptyGatewayEnv();
});

it("restarts the recorded service and warns without repairing from invalid config (#35862)", async () => {
  setInvalidConfig("agents.defaults.pdfModel");
  const repairLoadedService = vi.fn();
  const postRestartCheck = vi.fn();

  await expect(
    runServiceRestart({
      ...createServiceRunArgs(),
      repairLoadedService,
      postRestartCheck,
      checkTokenDrift: true,
    }),
  ).resolves.toBe(true);

  expect(service.restart).toHaveBeenCalledWith(
    expect.objectContaining({ preserveDefinition: true }),
  );
  expect(repairLoadedService).not.toHaveBeenCalled();
  expect(loadConfig).not.toHaveBeenCalled();
  expect(postRestartCheck).toHaveBeenCalledWith(
    expect.objectContaining({
      activationAccepted: true,
      preserveDefinition: true,
      warnings: [expect.stringContaining("agents.defaults.pdfModel: Unrecognized key")],
    }),
  );
  expectWarning("restarted", "openclaw doctor --fix");
});

it("restarts the recorded service when config was written by a newer binary", async () => {
  setConfigSnapshot({}, { meta: { lastTouchedVersion: "9999.1.1" } });

  await expect(runServiceRestart(createServiceRunArgs())).resolves.toBe(true);
  expect(service.restart).toHaveBeenCalledTimes(1);
});
it.each([
  {
    name: "invalid config",
    issues: { issues: [{ path: "agents.defaults.pdfModel", message: "Unrecognized key" }] },
    failure: {
      error: `Gateway aborted: config is invalid.\nagents.defaults.pdfModel: Unrecognized key\n${invalidConfigRecoveryHint}`,
    },
  },
  {
    name: "plugin packaging recovery",
    issues: createPluginPackagingConfigIssues(),
    failure: {
      error: "Gateway start blocked: plugins.slots.memory: plugin not found: source-only-pack",
      hints: pluginPackagingRecoveryHints,
      hintItems: pluginPackagingHintItems,
    },
  },
])("blocks start with $name", async ({ issues, failure }) => {
  setConfigSnapshot({ valid: false, ...issues });
  await expect(runServiceStart(createServiceRunArgs())).rejects.toThrow("__exit__:1");
  expect(service.start).not.toHaveBeenCalled();
  expectLatestRuntimeJson({ action: "start", ...failure });
});

it("proceeds with start when config is valid", async () => {
  await runServiceStart(createServiceRunArgs());
  expect(service.start).toHaveBeenCalledTimes(1);
});
it("stops the service before warning about invalid config", async () => {
  setInvalidConfig("meta.lastTouchedAt");
  await runServiceStop(createServiceRunArgs());
  expect(service.stop).toHaveBeenCalledTimes(1);
  expect(service.stop.mock.invocationCallOrder[0]).toBeLessThan(
    readConfigFileSnapshotMock.mock.invocationCallOrder[0]!,
  );
  expectWarning("stopped", "meta.lastTouchedAt: Unrecognized key");
});

it("uninstalls the service and warns without rewriting invalid config", async () => {
  setInvalidConfig("memory.qmd");
  service.isLoaded.mockResolvedValueOnce(true).mockResolvedValue(false);
  await runServiceUninstall({
    ...createServiceRunArgs(),
    stopBeforeUninstall: true,
    assertNotLoadedAfterUninstall: true,
  });
  expect(service.stop).toHaveBeenCalledTimes(1);
  expect(service.uninstall).toHaveBeenCalledTimes(1);
  expect(service.uninstall.mock.invocationCallOrder[0]).toBeLessThan(
    readConfigFileSnapshotMock.mock.invocationCallOrder[0]!,
  );
  expectWarning("uninstalled", "memory.qmd: Unrecognized key");
});
