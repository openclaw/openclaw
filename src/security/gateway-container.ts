import process from "node:process";
import { execDocker, dockerContainerState } from "../agents/sandbox/docker.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const logger = createSubsystemLogger("security/gateway-container");

const GATEWAY_IMAGE = "openclaw-gateway:latest";
const GATEWAY_CONTAINER_NAME = "openclaw-gateway-secure";

export type GatewayContainerOptions = {
  proxyUrl: string;
  /** Gateway WebSocket port (host and container) */
  gatewayPort: number;
  env?: Record<string, string | undefined>;
  /** Bind mounts in format ["host:container:ro"] */
  binds?: string[];
};

/**
 * P1 Fix: Comprehensive list of secret env var patterns.
 * Includes suffixes, prefixes, and exact matches for common secrets.
 */
const SECRET_SUFFIXES = [
  "_API_KEY",
  "_TOKEN",
  "_SECRET",
  "_PASSWORD",
  "_CREDENTIAL",
  "_CREDENTIALS",
  "_KEY",
  "_PRIVATE_KEY",
];

const SECRET_PREFIXES: string[] = [
  // Removed AWS_, AZURE_, GOOGLE_, GCP_ - too broad, blocks non-secret config
  // like AWS_REGION, GOOGLE_CLOUD_PROJECT. Use exact matches instead.
];

const SECRET_EXACT_MATCHES = new Set([
  // AWS specific
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  // Database
  "DATABASE_URL",
  "DATABASE_PASSWORD",
  "DB_PASSWORD",
  "REDIS_URL",
  "REDIS_PASSWORD",
  "MONGO_URL",
  "MONGODB_URI",
  "POSTGRES_PASSWORD",
  "MYSQL_PASSWORD",
  // Auth
  "PASSWORD",
  "COOKIE",
  "SESSION_SECRET",
  "JWT_SECRET",
  "AUTH_SECRET",
  // Generic
  "PRIVATE_KEY",
  "SECRET",
  "CREDENTIALS",
  // Path-related (prevent host paths in container)
  "HOME",
  "OPENCLAW_STATE_DIR",
  "OPENCLAW_CONFIG_PATH",
  "CLAWDBOT_STATE_DIR",
  "CLAWDBOT_CONFIG_PATH",
  // User/session related (prevent host user leaking)
  "USER",
  "LOGNAME",
  "USERNAME",
  "PWD",
  "OLDPWD",
  "PATH",
  // XDG dirs (contain host paths)
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_RUNTIME_DIR",
  // NVM (contains host paths)
  "NVM_DIR",
  "NVM_BIN",
  "NVM_INC",
  // Shell internals (contain host paths)
  "_", // Last executed command path
]);

/**
 * Env vars that should be passed to container despite matching secret patterns.
 * These are OpenClaw-specific credentials needed for gateway operation.
 */
const ALLOWED_SECRET_ENV_VARS = new Set([
  "OPENCLAW_GATEWAY_TOKEN", // Gateway auth token
  "OPENCLAW_GATEWAY_PASSWORD", // Gateway auth password
  "CLAWDBOT_GATEWAY_TOKEN", // Legacy alias
  "CLAWDBOT_GATEWAY_PASSWORD", // Legacy alias
  "PROXY_AUTH_TOKEN", // Proxy client auth (generated per-session)
]);

/**
 * Filters environment variables to exclude secrets.
 * P1 Fix: Now covers AWS credentials and other common secret patterns.
 */
function filterSecretEnv(env: Record<string, string | undefined>): Record<string, string> {
  const filtered: Record<string, string> = {};

  for (const [key, value] of Object.entries(env)) {
    if (!value) {
      continue;
    }

    const upperKey = key.toUpperCase();

    // Allow OpenClaw-specific env vars needed for gateway operation
    if (ALLOWED_SECRET_ENV_VARS.has(upperKey)) {
      filtered[upperKey] = value;
      continue;
    }

    // Check exact matches first
    if (SECRET_EXACT_MATCHES.has(upperKey)) {
      logger.debug(`Filtered secret env var (exact match): ${key}`);
      continue;
    }

    // Check suffixes
    const hasSuffix = SECRET_SUFFIXES.some((suffix) => upperKey.endsWith(suffix));
    if (hasSuffix) {
      logger.debug(`Filtered secret env var (suffix): ${key}`);
      continue;
    }

    // Check prefixes (these cloud provider env vars often contain credentials)
    const hasPrefix = SECRET_PREFIXES.some((prefix) => upperKey.startsWith(prefix));
    if (hasPrefix) {
      logger.debug(`Filtered secret env var (prefix): ${key}`);
      continue;
    }

    filtered[upperKey] = value;
  }

  return filtered;
}

export async function stopGatewayContainer(): Promise<void> {
  const state = await dockerContainerState(GATEWAY_CONTAINER_NAME);
  if (state.exists) {
    logger.info(`Stopping existing gateway container: ${GATEWAY_CONTAINER_NAME}`);
    await execDocker(["rm", "-f", GATEWAY_CONTAINER_NAME]);
  }
}

export async function startGatewayContainer(opts: GatewayContainerOptions): Promise<string> {
  await stopGatewayContainer();

  const filteredEnv = filterSecretEnv(opts.env || process.env);

  const args = [
    "run",
    "-d",
    "--name",
    GATEWAY_CONTAINER_NAME,
    "--network",
    "bridge",
    "--add-host",
    `host.docker.internal:host-gateway`,
    // Port mapping for gateway WebSocket server - bind to localhost only for secure mode
    "-p",
    `127.0.0.1:${opts.gatewayPort}:${opts.gatewayPort}`,
    // Tell container to bind to the configured port
    "-e",
    `PORT=${opts.gatewayPort}`,
    // Set secure mode flag so gateway knows to use placeholders and fetch wrapper
    "-e",
    "OPENCLAW_SECURE_MODE=1",
    // Tell the container where the proxy is
    "-e",
    `PROXY_URL=${opts.proxyUrl}`,
    // Explicitly set container paths to prevent host paths from being used
    "-e",
    "OPENCLAW_STATE_DIR=/home/node/.openclaw",
    "-e",
    "HOME=/home/node",
    "-e",
    "USER=node",
    "-e",
    "LOGNAME=node",
    "-e",
    "PWD=/app",
    "-e",
    "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    "-e",
    "XDG_CACHE_HOME=/home/node/.cache",
    "-e",
    "XDG_CONFIG_HOME=/home/node/.config",
  ];

  // Add bind mounts for tools/skills
  for (const bind of opts.binds || []) {
    // Validate bind mount format
    if (bind.includes(":")) {
      args.push("-v", bind);
      logger.info(`Adding bind mount: ${bind}`);
    } else {
      logger.warn(`Invalid bind mount format (expected host:container[:ro]): ${bind}`);
    }
  }

  // Keys that are explicitly set above - don't override with filteredEnv
  const explicitlySetKeys = new Set([
    "PORT",
    "OPENCLAW_SECURE_MODE",
    "PROXY_URL",
    "OPENCLAW_STATE_DIR",
    "HOME",
    "USER",
    "LOGNAME",
    "PWD",
    "PATH",
    "XDG_CACHE_HOME",
    "XDG_CONFIG_HOME",
  ]);

  // Add filtered environment variables (excluding explicitly set keys)
  for (const [key, value] of Object.entries(filteredEnv)) {
    if (explicitlySetKeys.has(key.toUpperCase())) {
      logger.debug(`Skipping explicitly set env var: ${key}`);
      continue;
    }
    args.push("-e", `${key}=${value}`);
  }

  args.push(GATEWAY_IMAGE);

  // Run gateway with allow-unconfigured flag for secure mode
  // Bind to loopback inside container - host port forwarding still works via Docker NAT
  // This prevents other containers on the bridge network from directly accessing the gateway
  args.push("node", "dist/index.js", "gateway", "--allow-unconfigured", "--bind", "loopback");

  logger.info(`Starting gateway container: ${GATEWAY_CONTAINER_NAME}`);
  await execDocker(args);

  return GATEWAY_CONTAINER_NAME;
}

/**
 * Checks if the gateway container is running and healthy.
 */
export async function isGatewayContainerRunning(): Promise<boolean> {
  const state = await dockerContainerState(GATEWAY_CONTAINER_NAME);
  return state.exists && state.running;
}

/**
 * Gets the gateway container logs.
 */
export async function getGatewayContainerLogs(lines: number = 50): Promise<string> {
  try {
    const result = await execDocker(["logs", "--tail", String(lines), GATEWAY_CONTAINER_NAME]);
    // execDocker returns {stdout, stderr, code} - combine for logs
    return result.stdout + (result.stderr ? "\n" + result.stderr : "");
  } catch (err) {
    return `Failed to get logs: ${String(err)}`;
  }
}
