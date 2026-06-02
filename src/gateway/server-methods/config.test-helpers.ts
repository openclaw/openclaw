import { vi, type Mock } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

type UnknownMock = Mock<(...args: unknown[]) => unknown>;
type GatewayLogMocks = {
  error: UnknownMock;
  warn: UnknownMock;
  info: UnknownMock;
  debug: UnknownMock;
};
type ConfigHandlerHarness = {
  options: GatewayRequestHandlerOptions;
  respond: UnknownMock;
  logGateway: GatewayLogMocks;
  disconnectClientsUsingSharedGatewayAuth: UnknownMock;
};

function createGatewayLog(): GatewayLogMocks {
  return {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  };
}

/** Build the read/write snapshot fixture shape expected by config mutation handlers. */
export function createConfigWriteSnapshot(config: OpenClawConfig) {
  return {
    snapshot: {
      path: "/tmp/openclaw.json",
      exists: true,
      raw: JSON.stringify(config, null, 2),
      parsed: config,
      sourceConfig: config,
      resolved: config,
      valid: true,
      runtimeConfig: config,
      config,
      hash: "base-hash",
      issues: [],
      warnings: [],
      legacyIssues: [],
    },
    writeOptions: {} as Record<string, never>,
  };
}

/** Create config handler options with captured response/log/shared-auth disconnect mocks. */
export function createConfigHandlerHarness(args?: {
  method?: string;
  params?: unknown;
  overrides?: Partial<GatewayRequestHandlerOptions>;
  contextOverrides?: Partial<GatewayRequestHandlerOptions["context"]>;
}): ConfigHandlerHarness {
  const logGateway = createGatewayLog();
  const disconnectClientsUsingSharedGatewayAuth = vi.fn();
  const respond = vi.fn();
  const options = {
    req: { type: "req", id: "1", method: args?.method ?? "config.get" },
    params: args?.params ?? {},
    client: null,
    isWebchatConnect: () => false,
    respond,
    context: {
      logGateway,
      disconnectClientsUsingSharedGatewayAuth,
      ...args?.contextOverrides,
    },
    ...args?.overrides,
  } as unknown as GatewayRequestHandlerOptions;
  return {
    options,
    respond,
    logGateway,
    disconnectClientsUsingSharedGatewayAuth,
  };
}

/** Let deferred config-write side effects, such as shared-auth disconnects, run once. */
export async function flushConfigHandlerMicrotasks() {
  await new Promise<void>((resolve) => {
    queueMicrotask(resolve);
  });
}
