import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PreManagedServiceStop } from "./update-command-service-context-types.js";

const boundary = vi.hoisted(() => ({
  contexts: vi.fn(),
  maintenance: vi.fn(),
  finish: vi.fn(),
  repair: vi.fn(),
}));
vi.mock("./update-command-database-context.js", () => ({
  inspectUpdateDatabaseContexts: boundary.contexts,
}));
vi.mock("./update-command-managed-context.js", () => ({
  revalidateUpdateDatabaseContext: async () => {},
  captureOwnedManagedUpdateContext: async () => undefined,
}));
vi.mock("./update-command-service-plan.js", async (original) => ({
  ...(await original<typeof import("./update-command-service-plan.js")>()),
  resolvePackageRuntimePreflight: async () => ({
    ok: true,
    value: { nodeRunner: "/target/node" },
  }),
}));
vi.mock("./update-command-plugin-preflight.js", () => ({
  preflightConfiguredNpmPluginTargets: async () => [],
}));
vi.mock("../../state/openclaw-state-ownership.js", async (original) => ({
  ...(await original<typeof import("../../state/openclaw-state-ownership.js")>()),
  assertOpenClawStateWriteAllowedAtPath: async () => {},
}));
vi.mock("../../plugins/plugin-lifecycle-lease.js", () => ({
  withPluginLifecycleLease: async (_options: unknown, run: () => unknown) => await run(),
}));
vi.mock("./update-command-service.js", async () => {
  const { UpdateCommandAbort } = await import("./update-command-windows-task.js");
  return {
    maybeStopManagedServiceBeforeMutableUpdate: boundary.maintenance,
    mutableUpdateGatewayServiceBlock: () => false,
    UpdateCommandAbort,
  };
});
vi.mock("./update-command-post-update.js", () => ({ finishUpdate: boundary.finish }));
vi.mock("./update-command-config.js", () => ({
  maybeRepairLegacyConfigForUpdateChannel: boundary.repair,
}));

const { finishAlreadyCurrentUpdate } = await import("./update-command-noop.js");

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(process, "platform", "get").mockReturnValue("linux");
});
afterEach(() => vi.restoreAllMocks());

it("repairs an admitted legacy config when the core is current without an explicit channel", async () => {
  const root = "/target/install";
  const configSnapshot = {
    path: "/operator/openclaw.json",
    raw: '{"agents":{"list":[]}}',
    parsed: { agents: { list: [] } },
    sourceConfig: { agents: { list: [] } },
    config: {},
    valid: false,
    issues: [{ path: "agents.list", message: "Invalid configuration field" }],
  };
  const repairedSnapshot = {
    ...configSnapshot,
    raw: '{"agents":{"entries":{}}}',
    parsed: { agents: { entries: {} } },
    sourceConfig: { agents: { entries: {} } },
    config: { agents: { entries: {} } },
    valid: true,
    issues: [],
  };
  const plan = {
    snapshot: configSnapshot,
    config: { update: { channel: "beta" } },
    nextConfig: { agents: { entries: {} }, update: { channel: "beta" } },
    changes: ["Moved agents.list to agents.entries."],
    includeIdentity: {},
  };
  boundary.contexts.mockResolvedValue({
    foreground: true,
    service: undefined,
    services: new Map(),
    contexts: [{ env: {}, configSnapshot, legacyConfigPlan: plan }],
  });
  boundary.repair.mockResolvedValue(repairedSnapshot);
  const refuseUpdate = vi.fn();

  await finishAlreadyCurrentUpdate({
    root,
    managedServiceRootRedirect: null,
    opts: { yes: true, json: true },
    result: {
      status: "skipped",
      mode: "npm",
      root,
      reason: "already-current",
      before: { version: "2026.10.1-beta.1" },
      after: { version: "2026.10.1-beta.1" },
      steps: [],
      durationMs: 0,
    },
    requestedChannel: null,
    storedChannel: "beta",
    channel: "beta",
    shouldRestart: false,
    updateStepTimeoutMs: 30_000,
    invocationCwd: root,
    startedAt: 0,
    controlPlaneUpdateSentinelMeta: null,
    stop: vi.fn(),
    refuseUpdate,
  });

  expect(boundary.repair).toHaveBeenCalledWith({
    configSnapshot,
    plan,
    jsonMode: true,
  });
  expect(boundary.finish).toHaveBeenCalledWith(
    expect.objectContaining({
      configSnapshot: repairedSnapshot,
      result: expect.objectContaining({ status: "ok" }),
      storedChannel: "beta",
    }),
  );
  expect(boundary.finish.mock.calls[0]?.[0].result).not.toHaveProperty("reason");
  expect(refuseUpdate).not.toHaveBeenCalled();
});

it.each([
  { managedServiceRoot: undefined, foreground: false },
  { managedServiceRoot: "/serving/install", foreground: false },
  { managedServiceRoot: "/serving/install", foreground: true },
])(
  "refreshes already-current policy only for native admission (root=$managedServiceRoot, foreground=$foreground)",
  async ({ managedServiceRoot, foreground }) => {
    const root = "/target/install";
    const serviceRoot = managedServiceRoot ?? root;
    const before: PreManagedServiceStop = {
      stopped: false,
      inspected: true,
      runtimeInspected: true,
      running: true,
      serviceUpdateVerdict: {
        kind: "owned",
        root: serviceRoot,
        fingerprint: "admitted-service",
        refreshDefinition: true,
      },
    };
    boundary.contexts.mockResolvedValue({
      foreground,
      service: before,
      services: new Map([[serviceRoot, before]]),
      contexts: [{ env: {}, configSnapshot: { sourceConfig: {}, config: {}, valid: true } }],
    });
    boundary.maintenance.mockResolvedValue(before);
    const refuseUpdate = vi.fn();
    await finishAlreadyCurrentUpdate({
      root,
      managedServiceRoot,
      managedServiceRootRedirect: null,
      opts: { yes: true, json: true },
      result: {
        status: "skipped",
        mode: "npm",
        root,
        reason: "already-current",
        before: { version: "2026.9.5" },
        after: { version: "2026.9.5" },
        steps: [],
        durationMs: 0,
      },
      requestedChannel: null,
      storedChannel: "stable",
      channel: "stable",
      shouldRestart: true,
      updateStepTimeoutMs: 30_000,
      invocationCwd: root,
      startedAt: 0,
      controlPlaneUpdateSentinelMeta: null,
      stop: vi.fn(),
      refuseUpdate,
    });

    expect(refuseUpdate).not.toHaveBeenCalled();
    expect(boundary.maintenance).toHaveBeenCalledTimes(foreground ? 0 : 1);
    for (const [index, phase] of (foreground ? [] : ["refresh"]).entries()) {
      expect(boundary.maintenance).toHaveBeenNthCalledWith(
        index + 1,
        expect.objectContaining({
          phase,
          root: serviceRoot,
          expectedService: before,
        }),
      );
      expect(boundary.maintenance.mock.calls[index]?.[0].handoffRoot).toBe(
        managedServiceRoot ? root : undefined,
      );
    }
    expect(boundary.finish).toHaveBeenCalledWith(
      expect.objectContaining({
        root,
        serviceRuntimeRefreshRequired: managedServiceRoot !== undefined,
        preManagedServiceStop: foreground ? undefined : before,
      }),
    );
  },
);
