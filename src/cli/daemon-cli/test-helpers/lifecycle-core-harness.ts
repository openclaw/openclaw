import { vi } from "vitest";

export const runtimeLogs: string[] = [];

export const defaultRuntime = {
  log: (message: string) => runtimeLogs.push(message),
  error: vi.fn(),
  exit: (code: number) => {
    throw new Error(`__exit__:${code}`);
  },
};

export const service = {
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
  service.readCommand.mockResolvedValue({ environment: {} });
  service.restart.mockResolvedValue({ outcome: "completed" });
}

export function stubEmptyGatewayEnv() {
  vi.unstubAllEnvs();
  vi.stubEnv("OPENCLAW_GATEWAY_TOKEN", "");
  vi.stubEnv("CLAWDBOT_GATEWAY_TOKEN", "");
  vi.stubEnv("OPENCLAW_GATEWAY_URL", "");
  vi.stubEnv("CLAWDBOT_GATEWAY_URL", "");
}
