// Cleanup command test support provides non-exiting runtimes and log captures for cleanup suites.
import { vi } from "vitest";
import type { GatewayService } from "../daemon/service-types.js";
import { createNonExitingRuntime, type RuntimeEnv } from "../runtime.js";
import type { MockFn } from "../test-utils/vitest-mock-fn.js";

const resolveCleanupPlanForDryRun = vi.fn();
export const resolveCleanupPlanForRemoval: MockFn<
  typeof import("./cleanup-plan.js").resolveCleanupPlanForRemoval
> = vi.fn();
export const removePath: MockFn<typeof import("./cleanup-utils.js").removePath> = vi.fn();
const removeConfigCredentialsAndSessions = vi.fn();
export const removeStateAndLinkedPaths: MockFn<
  typeof import("./cleanup-utils.js").removeStateAndLinkedPaths
> = vi.fn();
export const removeWorkspaceDirs: MockFn<typeof import("./cleanup-utils.js").removeWorkspaceDirs> =
  vi.fn();
type CleanupGatewayService = {
  notLoadedText: string;
  isLoaded: MockFn<GatewayService["isLoaded"]>;
  isAbsent: MockFn<NonNullable<GatewayService["isAbsent"]>>;
  stop: MockFn<GatewayService["stop"]>;
  uninstall: MockFn<GatewayService["uninstall"]>;
};
const gatewayServiceState = vi.hoisted((): CleanupGatewayService => ({
  notLoadedText: "is not installed",
  isLoaded: vi.fn(),
  isAbsent: vi.fn(),
  stop: vi.fn(),
  uninstall: vi.fn(),
}));
export const gatewayService: CleanupGatewayService = gatewayServiceState;
const cleanupConfigState = vi.hoisted(() => ({ isNixMode: false }));

vi.mock("../config/config.js", () => ({
  get isNixMode() {
    return cleanupConfigState.isNixMode;
  },
  resolveConfigPath: () => "/tmp/.openclaw/openclaw.json",
}));

vi.mock("../daemon/service.js", () => ({
  resolveGatewayService: () => gatewayService,
}));

vi.mock("./cleanup-plan.js", () => ({
  resolveCleanupPlanForDryRun,
  resolveCleanupPlanForRemoval,
}));

vi.mock("./cleanup-utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./cleanup-utils.js")>()),
  removePath,
  removeConfigCredentialsAndSessions,
  removeStateAndLinkedPaths,
  removeWorkspaceDirs,
}));

export function createCleanupCommandRuntime() {
  return createNonExitingRuntime();
}

export function resetCleanupCommandMocks() {
  vi.clearAllMocks();
  const cleanupPlan = {
    cfg: {},
    stateDir: "/tmp/.openclaw",
    configPath: "/tmp/.openclaw/openclaw.json",
    oauthDir: "/tmp/.openclaw/credentials",
    configInsideState: true,
    oauthInsideState: true,
    workspaceDirs: ["/tmp/.openclaw/workspace"],
  };
  resolveCleanupPlanForDryRun.mockResolvedValue(cleanupPlan);
  resolveCleanupPlanForRemoval.mockResolvedValue(cleanupPlan);
  removePath.mockResolvedValue({ ok: true });
  removeConfigCredentialsAndSessions.mockReset().mockResolvedValue(true);
  removeStateAndLinkedPaths.mockResolvedValue(true);
  removeWorkspaceDirs.mockResolvedValue([]);
  gatewayService.isLoaded.mockReset().mockResolvedValue(true);
  gatewayService.isAbsent.mockReset().mockResolvedValue(false);
  gatewayService.stop.mockReset().mockResolvedValue(undefined);
  gatewayService.uninstall.mockReset().mockResolvedValue(undefined);
  cleanupConfigState.isNixMode = false;
}

export function setCleanupNixMode(value: boolean) {
  cleanupConfigState.isNixMode = value;
}

export function silenceCleanupCommandRuntime(runtime: RuntimeEnv) {
  vi.spyOn(runtime, "log").mockImplementation(() => {});
  vi.spyOn(runtime, "error").mockImplementation(() => {});
}

export function cleanupCommandLogMessages(runtime: RuntimeEnv): string[] {
  const calls = (runtime.log as MockFn<(...args: unknown[]) => void>).mock.calls;
  return calls.map((call) => String(call[0]));
}

export function cleanupCommandErrorMessages(runtime: RuntimeEnv): string[] {
  const calls = (runtime.error as MockFn<(...args: unknown[]) => void>).mock.calls;
  return calls.map((call) => String(call[0]));
}
