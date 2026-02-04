import process from "node:process";
import { execDocker, dockerContainerState } from "../agents/sandbox/docker.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const logger = createSubsystemLogger("security/gateway-container");

const GATEWAY_IMAGE = "openclaw-gateway:latest";
const GATEWAY_CONTAINER_NAME = "openclaw-gateway-secure";

export type GatewayContainerOptions = {
  proxyUrl: string;
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

const SECRET_PREFIXES = [
  "AWS_",           // AWS credentials: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN
  "AZURE_",         // Azure credentials
  "GCP_",           // Google Cloud credentials
  "GOOGLE_",        // Google credentials
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
  "_",  // Last executed command path
]);

/**
 * Filters environment variables to exclude secrets.
 * P1 Fix: Now covers AWS credentials and other common secret patterns.
 */
function filterSecretEnv(env: Record<string, string | undefined>): Record<string, string> {
  const filtered: Record<string, string> = {};
  
  for (const [key, value] of Object.entries(env)) {
    if (!value) continue;
    
    const upperKey = key.toUpperCase();
    
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
    
    filtered[key] = value;
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
    "--name", GATEWAY_CONTAINER_NAME,
    "--network", "bridge",
    "--add-host", `host.docker.internal:host-gateway`,
    // Port mapping for gateway WebSocket server (default 18789)
    "-p", "18789:18789",
    // Set secure mode flag so gateway knows to use placeholders and fetch wrapper
    "-e", "OPENCLAW_SECURE_MODE=1",
    // Tell the container where the proxy is
    "-e", `PROXY_URL=${opts.proxyUrl}`,
    // Explicitly set container paths to prevent host paths from being used
    "-e", "OPENCLAW_STATE_DIR=/home/node/.openclaw",
    "-e", "HOME=/home/node",
    "-e", "USER=node",
    "-e", "LOGNAME=node",
    "-e", "PWD=/app",
    "-e", "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    "-e", "XDG_CACHE_HOME=/home/node/.cache",
    "-e", "XDG_CONFIG_HOME=/home/node/.config",
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

  // Add filtered environment variables
  for (const [key, value] of Object.entries(filteredEnv)) {
    args.push("-e", `${key}=${value}`);
  }

  args.push(GATEWAY_IMAGE);
  
  // Run gateway with allow-unconfigured flag for secure mode
  // --bind lan makes gateway listen on 0.0.0.0 so Docker port mapping works
  args.push("node", "dist/index.js", "gateway", "--allow-unconfigured", "--bind", "lan");

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

