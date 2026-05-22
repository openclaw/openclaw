import { isClaworksProduct } from "./paths.js";
import type { OpenClawConfig } from "./types.js";

export const CLAWORKS_STANDARD_GATEWAY_PORT = 18_800;

/** OpenClaw personal install default; ClaWorks must not bind here. */
export const OPENCLAW_RESERVED_GATEWAY_PORT = 18789;

export function isOpenClawReservedGatewayPort(port: number): boolean {
  return port === OPENCLAW_RESERVED_GATEWAY_PORT;
}

/** Normalize gateway.port for ClaWorks product mode (never leave 18789). */
export function coerceClaworksGatewayPort(
  port: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  if (!isClaworksProduct(env)) {
    return port;
  }
  if (!Number.isFinite(port) || port <= 0 || isOpenClawReservedGatewayPort(port)) {
    return CLAWORKS_STANDARD_GATEWAY_PORT;
  }
  return port;
}

export function claworksGatewayPortConflict(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!isClaworksProduct(env)) {
    return false;
  }
  const port = cfg.gateway?.port;
  return typeof port === "number" && isOpenClawReservedGatewayPort(port);
}

export function repairClaworksGatewayPortInConfig(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): OpenClawConfig {
  if (!claworksGatewayPortConflict(cfg, env)) {
    return cfg;
  }
  return {
    ...cfg,
    gateway: {
      ...cfg.gateway,
      port: CLAWORKS_STANDARD_GATEWAY_PORT,
    },
  };
}

function normalizeConfigSetPort(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function normalizeConfigSetPath(configPath: string | readonly (string | number)[]): string {
  if (typeof configPath === "string") {
    return configPath;
  }
  return configPath.map(String).join(".");
}

/** Reject config set that would point ClaWorks at OpenClaw's reserved port. */
export function formatClaworksReservedPortConfigSetError(
  configPath: string | readonly (string | number)[],
  value: unknown,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (!isClaworksProduct(env)) {
    return null;
  }
  if (normalizeConfigSetPath(configPath) !== "gateway.port") {
    return null;
  }
  const port = normalizeConfigSetPort(value);
  if (port === null || !isOpenClawReservedGatewayPort(port)) {
    return null;
  }
  return (
    `gateway.port ${OPENCLAW_RESERVED_GATEWAY_PORT} is reserved for OpenClaw. ` +
    `ClaWorks must use ${CLAWORKS_STANDARD_GATEWAY_PORT}. ` +
    `Run \`claworks config set gateway.port ${CLAWORKS_STANDARD_GATEWAY_PORT}\`.`
  );
}
