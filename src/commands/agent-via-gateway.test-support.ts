import path from "node:path";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayLockOptions } from "../infra/gateway-lock.js";

export function createLocalGatewayLockOptions(
  stateDir: string,
  overrides: Partial<GatewayLockOptions> = {},
): GatewayLockOptions {
  return {
    allowInTests: true,
    env: {
      ...process.env,
      OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
      OPENCLAW_STATE_DIR: stateDir,
    },
    lockDir: path.join(stateDir, "gateway-locks"),
    timeoutMs: 100,
    ...overrides,
  };
}

export function createExplicitSystemAgentConfig(
  agentId: string,
  agentIds: string[],
): OpenClawConfig {
  return {
    agents: {
      ownership: "explicit",
      defaults: { systemAgent: { agentId } },
      entries: Object.fromEntries(agentIds.map((id) => [id, {}])),
    },
  };
}

export function createGatewayTimeoutError() {
  const err = new Error("gateway timeout after 90000ms");
  err.name = "GatewayTransportError";
  return Object.assign(err, {
    kind: "timeout",
    timeoutMs: 90_000,
    connectionDetails: {
      url: "ws://127.0.0.1:18789",
      urlSource: "local loopback",
      message: "Gateway target: ws://127.0.0.1:18789",
    },
  });
}

export function createGatewayClosedError() {
  const err = new Error("gateway closed (1006 abnormal closure): no close reason");
  err.name = "GatewayTransportError";
  return Object.assign(err, {
    kind: "closed",
    code: 1006,
    reason: "no close reason",
    connectionDetails: {
      url: "ws://127.0.0.1:18789",
      urlSource: "local loopback",
      message: "Gateway target: ws://127.0.0.1:18789",
    },
  });
}

export function createGatewayNormalCloseError() {
  const err = new Error("gateway closed (1000 normal closure): no close reason");
  err.name = "GatewayTransportError";
  return Object.assign(err, {
    kind: "closed",
    code: 1000,
    reason: "no close reason",
    connectionDetails: {
      url: "ws://127.0.0.1:18789",
      urlSource: "local loopback",
      message: "Gateway target: ws://127.0.0.1:18789",
    },
  });
}
