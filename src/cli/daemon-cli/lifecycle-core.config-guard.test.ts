// Daemon lifecycle config guard tests cover config checks before service lifecycle actions.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
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
  const calls = lifecycleTestRuntime.writeJson.mock.calls;
  expect(calls[calls.length - 1]?.[0]).toEqual({
    ok: false,
    hints: undefined,
    hintItems: undefined,
    warnings: undefined,
    ...payload,
  });
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

function setConfigSnapshot(params: {
  exists: boolean;
  valid: boolean;
  issues?: Array<{ path: string; message: string }>;
  warnings?: Array<{ path: string; message: string }>;
  legacyIssues?: Array<{ path: string; message: string }>;
  lastTouchedVersion?: string;
}) {
  const config = params.lastTouchedVersion
    ? { meta: { lastTouchedVersion: params.lastTouchedVersion } }
    : {};
  readConfigFileSnapshotMock.mockResolvedValue({
    exists: params.exists,
    valid: params.valid,
    config,
    sourceConfig: config,
    issues: params.issues ?? [],
    warnings: params.warnings ?? [],
    legacyIssues: params.legacyIssues ?? [],
  });
}

function setPluginPackagingInvalidSnapshot() {
  setConfigSnapshot({
    exists: true,
    valid: false,
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
  });
}

function createServiceRunArgs() {
  return {
    serviceNoun: "Gateway",
    service,
    renderStartHints: () => [],
    opts: { json: true },
  };
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
  setConfigSnapshot({ exists: true, valid: true });
  loadConfig.mockReset();
  loadConfig.mockReturnValue({});
  resetLifecycleServiceMocks();
  stubEmptyGatewayEnv();
});

describe("runServiceRestart config pre-flight (#35862)", () => {
  it("restarts the recorded service and warns without repairing from invalid config", async () => {
    setConfigSnapshot({
      exists: true,
      valid: false,
      issues: [{ path: "agents.defaults.pdfModel", message: "Unrecognized key" }],
    });
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
    expect(lifecycleTestRuntime.writeJson).toHaveBeenLastCalledWith(
      expect.objectContaining({
        ok: true,
        result: "restarted",
        warnings: [expect.stringContaining("openclaw doctor --fix")],
      }),
    );
  });

  it("restarts the recorded service when config was written by a newer binary", async () => {
    setConfigSnapshot({ exists: true, valid: true, lastTouchedVersion: "9999.1.1" });

    await expect(runServiceRestart(createServiceRunArgs())).resolves.toBe(true);
    expect(service.restart).toHaveBeenCalledTimes(1);
  });
});

describe("runServiceStart config pre-flight (#35862)", () => {
  it("aborts start when config is invalid", async () => {
    setConfigSnapshot({
      exists: true,
      valid: false,
      issues: [{ path: "agents.defaults.pdfModel", message: "Unrecognized key" }],
    });

    await expect(runServiceStart(createServiceRunArgs())).rejects.toThrow("__exit__:1");

    expect(service.start).not.toHaveBeenCalled();
    expectLatestRuntimeJson({
      action: "start",
      error: `Gateway aborted: config is invalid.\nagents.defaults.pdfModel: Unrecognized key\n${invalidConfigRecoveryHint}`,
    });
  });

  it("points start at plugin packaging recovery for packaging-only invalid config", async () => {
    setPluginPackagingInvalidSnapshot();

    await expect(runServiceStart(createServiceRunArgs())).rejects.toThrow("__exit__:1");

    expect(service.start).not.toHaveBeenCalled();
    expectLatestRuntimeJson({
      action: "start",
      error: "Gateway start blocked: plugins.slots.memory: plugin not found: source-only-pack",
      hints: pluginPackagingRecoveryHints,
      hintItems: pluginPackagingHintItems,
    });
  });

  it("proceeds with start when config is valid", async () => {
    setConfigSnapshot({ exists: true, valid: true });

    await runServiceStart(createServiceRunArgs());

    expect(service.start).toHaveBeenCalledTimes(1);
  });
});

describe("runServiceStop future-config guard", () => {
  it("stops the service before warning about invalid config", async () => {
    setConfigSnapshot({
      exists: true,
      valid: false,
      issues: [{ path: "meta.lastTouchedAt", message: "Unrecognized key" }],
    });
    await runServiceStop(createServiceRunArgs());

    expect(service.stop).toHaveBeenCalledTimes(1);
    expect(service.stop.mock.invocationCallOrder[0]).toBeLessThan(
      readConfigFileSnapshotMock.mock.invocationCallOrder[0]!,
    );
    expect(lifecycleTestRuntime.writeJson).toHaveBeenLastCalledWith(
      expect.objectContaining({
        ok: true,
        result: "stopped",
        warnings: [expect.stringContaining("meta.lastTouchedAt: Unrecognized key")],
      }),
    );
  });

  it("uninstalls the service and warns without rewriting invalid config", async () => {
    setConfigSnapshot({
      exists: true,
      valid: false,
      issues: [{ path: "memory.qmd", message: "Unrecognized key" }],
    });
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
    expect(lifecycleTestRuntime.writeJson).toHaveBeenLastCalledWith(
      expect.objectContaining({
        ok: true,
        result: "uninstalled",
        warnings: [expect.stringContaining("memory.qmd: Unrecognized key")],
      }),
    );
  });
});
