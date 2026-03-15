import { vi } from "vitest";
import type { GatewayService } from "../../../daemon/service.js";
import type { RuntimeEnv } from "../../../runtime.js";
import type { MockFn } from "../../../test-utils/vitest-mock-fn.js";

export const runtimeLogs: string[] = [];

type LifecycleRuntimeHarness = RuntimeEnv & {
  error: MockFn<RuntimeEnv["error"]>;
  exit: MockFn<RuntimeEnv["exit"]>;
};

type LifecycleServiceHarness = GatewayService & {
  install: MockFn<GatewayService["install"]>;
  uninstall: MockFn<GatewayService["uninstall"]>;
  stop: MockFn<GatewayService["stop"]>;
  isLoaded: MockFn<GatewayService["isLoaded"]>;
  readCommand: MockFn<GatewayService["readCommand"]>;
  readRuntime: MockFn<GatewayService["readRuntime"]>;
  restart: MockFn<GatewayService["restart"]>;
};

export const defaultRuntime: LifecycleRuntimeHarness = {
  log: (...args: unknown[]) => {
    runtimeLogs.push(args.map((arg) => String(arg)).join(" "));
  },
  error: vi.fn(),
  exit: vi.fn((code: number) => {
    throw new Error(`__exit__:${code}`);
  }),
};

export const service: LifecycleServiceHarness = {
  label: "TestService",
  loadedText: "loaded",
  notLoadedText: "not loaded",
  install: vi.fn(),
  uninstall: vi.fn(),
  stop: vi.fn(),
  isLoaded: vi.fn(),
  readCommand: vi.fn(),
  readRuntime: vi.fn(),
  restart: vi.fn(),
};

export function resetLifecycleRuntimeLogs() {
  runtimeLogs.length = 0;
}

export function resetLifecycleServiceMocks() {
  service.isLoaded.mockClear();
  service.readCommand.mockClear();
  service.restart.mockClear();
  service.isLoaded.mockResolvedValue(true);
  service.readCommand.mockResolvedValue({ programArguments: [], environment: {} });
  service.restart.mockResolvedValue({ outcome: "completed" });
}

export function stubEmptyGatewayEnv() {
  vi.unstubAllEnvs();
  vi.stubEnv("OPENCLAW_GATEWAY_TOKEN", "");
  vi.stubEnv("CLAWDBOT_GATEWAY_TOKEN", "");
  vi.stubEnv("OPENCLAW_GATEWAY_URL", "");
  vi.stubEnv("CLAWDBOT_GATEWAY_URL", "");
}
