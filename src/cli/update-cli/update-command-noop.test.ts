import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createTestConfigSnapshot } from "../../commands/test-runtime-config-helpers.js";
import { finishParams, updateResult } from "./update-command-maintenance-fixtures.test-support.js";
import type { PreManagedServiceStop } from "./update-command-service-context-types.js";

const boundary = vi.hoisted(() => ({
  contexts: vi.fn(),
  maintenance: vi.fn(),
  finish: vi.fn(),
}));
vi.mock("./update-command-database-context.js", () => ({
  inspectUpdateDatabaseContexts: boundary.contexts,
}));
vi.mock("./update-command-managed-context.js", async (original) => ({
  ...(await original<typeof import("./update-command-managed-context.js")>()),
  captureOwnedManagedUpdateContext: async () => undefined,
}));
vi.mock("./update-command-runtime-preflight.js", async (original) => ({
  ...(await original<typeof import("./update-command-runtime-preflight.js")>()),
  resolvePackageRuntimePreflight: async () => ({
    ok: true,
    value: { nodeRunner: "/target/node" },
  }),
}));
vi.mock("./update-command-plugin-preflight.js", () => ({
  preflightConfiguredNpmPluginTargets: async () => [],
}));
vi.mock("../../state/openclaw-state-ownership-preflight.js", async (original) => ({
  ...(await original<typeof import("../../state/openclaw-state-ownership-preflight.js")>()),
  assertOpenClawStateWriteAllowedAtPath: async () => {},
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

const { finishAlreadyCurrentUpdate } = await import("./update-command-noop.js");

beforeEach(() => vi.resetAllMocks());
afterEach(() => vi.restoreAllMocks());

it.each([
  { platform: "linux", managedServiceRoot: undefined, foreground: false },
  { platform: "linux", managedServiceRoot: "/serving/install", foreground: false },
  { platform: "linux", managedServiceRoot: "/serving/install", foreground: true },
  { platform: "darwin", managedServiceRoot: undefined, foreground: false },
  { platform: "win32", managedServiceRoot: undefined, foreground: false },
] as const)(
  "refreshes already-current policy only for native Linux admission (platform=$platform, root=$managedServiceRoot, foreground=$foreground)",
  async ({ platform, managedServiceRoot, foreground }) => {
    vi.spyOn(process, "platform", "get").mockReturnValue(platform);
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
      managedServiceRoot,
      managedServiceRootRedirect: null,
      ...finishParams({
        root,
        configSnapshot: createTestConfigSnapshot({}),
        result: updateResult({
          status: "skipped",
          root,
          reason: "already-current",
          before: { version: "2026.9.5" },
          after: { version: "2026.9.5" },
          durationMs: 0,
        }),
        opts: { yes: true, json: true },
        startedAt: 0,
      }),
      invocationCwd: root,
      stop: vi.fn(),
      refuseUpdate,
    });

    expect(refuseUpdate).not.toHaveBeenCalled();
    const refresh = platform === "linux" && !foreground;
    expect(boundary.maintenance).toHaveBeenCalledTimes(refresh ? 1 : 0);
    if (refresh) {
      expect(boundary.maintenance).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          phase: "refresh",
          root: serviceRoot,
          expectedService: before,
          handoffRoot: managedServiceRoot ? root : undefined,
        }),
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
