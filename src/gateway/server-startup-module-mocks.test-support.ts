import { vi } from "vitest";
import * as updateStartup from "../infra/update-startup.js";
import * as startupLog from "./server-startup-log.js";
import * as updateSentinel from "./server-update-sentinel.js";
import * as systemCa from "./system-ca-warmup.js";

type SystemCaWarmup = typeof systemCa.beginMacOSSystemCaWarmupOnce;

const systemCaMock = vi.hoisted(() => ({ current: undefined as SystemCaWarmup | undefined }));

// Bind before startup captures the static import; unmodified fixtures use the real owner.
vi.mock("./system-ca-warmup.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./system-ca-warmup.js")>();
  return {
    ...actual,
    beginMacOSSystemCaWarmupOnce: (options?: Parameters<SystemCaWarmup>[0]) =>
      (systemCaMock.current ?? actual.beginMacOSSystemCaWarmupOnce)(options),
  };
});

export type GatewayStartupModuleMocks = {
  logGatewayStartup: (
    params: Parameters<typeof startupLog.logGatewayStartup>[0],
  ) => void | Promise<void>;
  refreshLatestUpdateRestartSentinel: typeof updateSentinel.prepareLatestUpdateRestartSentinel;
  createGatewayUpdateCheck: typeof updateStartup.createGatewayUpdateCheck;
  warmSystemCa: typeof systemCa.beginMacOSSystemCaWarmupOnce;
};

export function installGatewayStartupModuleMocks(
  mocks: GatewayStartupModuleMocks,
  restorers: Array<() => void>,
): void {
  // Existing hoisted mocks are stable across resetModules; never implement a mock with itself.
  if (startupLog.logGatewayStartup !== mocks.logGatewayStartup) {
    const spy = vi.spyOn(startupLog, "logGatewayStartup");
    spy.mockImplementation(async (params) => mocks.logGatewayStartup(params));
    restorers.push(() => spy.mockRestore());
  }
  if (
    updateSentinel.prepareLatestUpdateRestartSentinel !== mocks.refreshLatestUpdateRestartSentinel
  ) {
    const spy = vi.spyOn(updateSentinel, "prepareLatestUpdateRestartSentinel");
    spy.mockImplementation(mocks.refreshLatestUpdateRestartSentinel);
    restorers.push(() => spy.mockRestore());
  }
  if (updateStartup.createGatewayUpdateCheck !== mocks.createGatewayUpdateCheck) {
    const spy = vi.spyOn(updateStartup, "createGatewayUpdateCheck");
    spy.mockImplementation(mocks.createGatewayUpdateCheck);
    restorers.push(() => spy.mockRestore());
  }
  if (systemCa.beginMacOSSystemCaWarmupOnce !== mocks.warmSystemCa) {
    const previous = systemCaMock.current;
    systemCaMock.current = mocks.warmSystemCa;
    restorers.push(() => {
      systemCaMock.current = previous;
    });
  }
}

// Gate the actual lazy import; the exported hook factory remains synchronous.
export async function installGatewayHookModuleLoad(
  waitForLoad: () => Promise<void>,
  restorers: Array<() => void>,
): Promise<void> {
  const owner = await import("../plugins/hooks.js");
  // mock-isolation: Preserve the captured hook namespace while delaying only future imports.
  vi.doMock("../plugins/hooks.js", () => waitForLoad().then(() => owner));
  restorers.push(() => {
    // mock-isolation: Restore captured namespaces without resetting Gateway singletons.
    vi.doMock("../plugins/hooks.js", () => owner);
  });
}

export async function installGatewaySubagentModuleLoad(
  waitForLoad: () => Promise<void>,
  activate: typeof import("../agents/subagents/registry/subagent-registry.js").activateSubagentRegistry,
  restorers: Array<() => void>,
): Promise<void> {
  const owner = await import("../agents/subagents/registry/subagent-registry.js");
  // mock-isolation: Delay registry loading and observe activation without restoring live runs.
  vi.doMock("../agents/subagents/registry/subagent-registry.js", () =>
    waitForLoad().then(() => ({ ...owner, activateSubagentRegistry: activate })),
  );
  restorers.push(() => {
    // mock-isolation: Restore the captured registry without resetting live Gateway singletons.
    vi.doMock("../agents/subagents/registry/subagent-registry.js", () => owner);
  });
}
