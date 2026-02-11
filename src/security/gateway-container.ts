import process from "node:process";
import { execDocker, dockerContainerState } from "../agents/sandbox/docker.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const logger = createSubsystemLogger("security/gateway-container");

const GATEWAY_IMAGE = "openclaw-gateway:latest";
const GATEWAY_CONTAINER_NAME = "openclaw-gateway-secure";

export type GatewayContainerOptions = {
  /** Gateway WebSocket port (host and container) */
  gatewayPort: number;
  /** Port the relay listens on inside the internal network */
  proxyPort: number;
  /** Port the host proxy is listening on (defaults to proxyPort if not set) */
  hostProxyPort?: number;
  /** Unix socket path to the host proxy (Linux/macOS). Mutually exclusive with TCP mode. */
  proxySocketPath?: string;
  env?: Record<string, string | undefined>;
  /** Bind mounts in format ["host:container:ro"] */
  binds?: string[];
};

const SECURE_NETWORK_NAME = "openclaw-secure-net";
const RELAY_CONTAINER_NAME = "openclaw-relay";
const SOCAT_IMAGE = "alpine/socat";
const RELAY_SOCKET_MOUNT = "/tmp/proxy.sock";

/**
 * Create the internal Docker network (blocks all outbound internet).
 * Idempotent — silently succeeds if the network already exists.
 */
async function ensureSecureNetwork(): Promise<void> {
  const result = await execDocker(["network", "inspect", SECURE_NETWORK_NAME], { allowFailure: true });
  if (result.code === 0) {
    logger.debug(`Network ${SECURE_NETWORK_NAME} already exists`);
    return;
  }
  logger.info(`Creating internal Docker network: ${SECURE_NETWORK_NAME}`);
  await execDocker(["network", "create", "--internal", SECURE_NETWORK_NAME]);
}

/**
 * Remove the internal Docker network.
 */
async function removeSecureNetwork(): Promise<void> {
  try {
    await execDocker(["network", "rm", SECURE_NETWORK_NAME], { allowFailure: true });
    logger.info(`Removed network: ${SECURE_NETWORK_NAME}`);
  } catch {
    // Network may not exist or may still have endpoints
  }
}

/**
 * Start a socat relay container that bridges the internal network to the host proxy.
 *
 * Socket mode (Linux/macOS): mount the host proxy's Unix socket into the relay.
 *   socat TCP-LISTEN → UNIX-CONNECT:/tmp/proxy.sock
 *   No TCP exposure on any network interface.
 *
 * TCP mode (Windows): relay connects to host.docker.internal (Docker Desktop loopback).
 *   socat TCP-LISTEN → TCP:host.docker.internal:port
 *   Proxy is on 127.0.0.1, reachable only via Docker Desktop's host gateway.
 */
async function startRelayContainer(
  proxyPort: number,
  hostProxyPort: number,
  proxySocketPath?: string,
): Promise<void> {
  // Remove any existing relay
  try {
    await execDocker(["rm", "-f", RELAY_CONTAINER_NAME], { allowFailure: true });
  } catch {
    // ignore
  }

  // Always start on the internal network — never on bridge.
  // On Docker Desktop (Windows), host.docker.internal resolves from any network,
  // so there's no need to start on bridge and then hot-swap networks.
  const network = SECURE_NETWORK_NAME;

  const args = [
    "run", "-d",
    "--name", RELAY_CONTAINER_NAME,
    "--network", network,
    "--restart", "unless-stopped",
  ];

  if (proxySocketPath) {
    // Socket mode: mount host socket into relay container
    args.push("-v", `${proxySocketPath}:${RELAY_SOCKET_MOUNT}:ro`);
    args.push(
      SOCAT_IMAGE,
      `TCP-LISTEN:${proxyPort},fork,reuseaddr`,
      `UNIX-CONNECT:${RELAY_SOCKET_MOUNT}`,
    );
  } else {
    // TCP mode (Windows): reach host via Docker Desktop's host.docker.internal
    args.push(
      "--add-host", "host.docker.internal:host-gateway",
      SOCAT_IMAGE,
      `TCP-LISTEN:${proxyPort},fork,reuseaddr`,
      `TCP:host.docker.internal:${hostProxyPort}`,
    );
  }

  await execDocker(args);

  const mode = proxySocketPath ? `socket:${proxySocketPath}` : `tcp:host.docker.internal:${hostProxyPort}`;
  logger.info(`Relay container started: ${RELAY_CONTAINER_NAME} (${mode} → port ${proxyPort})`);
}

/**
 * Stop and remove the relay container.
 */
async function stopRelayContainer(): Promise<void> {
  try {
    await execDocker(["rm", "-f", RELAY_CONTAINER_NAME], { allowFailure: true });
    logger.info(`Removed relay container: ${RELAY_CONTAINER_NAME}`);
  } catch {
    // ignore
  }
}

/**
 * Full cleanup: gateway container, relay container, and internal network.
 */
export async function stopGatewayContainer(): Promise<void> {
  const state = await dockerContainerState(GATEWAY_CONTAINER_NAME);
  if (state.exists) {
    logger.info(`Stopping existing gateway container: ${GATEWAY_CONTAINER_NAME}`);
    await execDocker(["rm", "-f", GATEWAY_CONTAINER_NAME]);
  }
  await stopRelayContainer();
  await removeSecureNetwork();
}

export async function startGatewayContainer(opts: GatewayContainerOptions): Promise<string> {
  await stopGatewayContainer();

  // Set up network isolation: internal network + relay
  await ensureSecureNetwork();
  await startRelayContainer(opts.proxyPort, opts.hostProxyPort ?? opts.proxyPort, opts.proxySocketPath);

  const filteredEnv = filterSecretEnv(opts.env || process.env);

  // Resolve the relay container's IP on the internal network for PROXY_URL
  // The gateway container uses the relay's hostname (Docker DNS on user-defined networks)
  const proxyUrl = `http://${RELAY_CONTAINER_NAME}:${opts.proxyPort}`;

  const args = [
    "run",
    "-d",
    "--name",
    GATEWAY_CONTAINER_NAME,
    // Internal-only network: blocks ALL outbound internet access
    "--network",
    SECURE_NETWORK_NAME,
    // Port mapping for gateway WebSocket server - bind to localhost only
    // This works because Docker creates a proxy on the host that forwards to the container
    // even on internal networks (the host can always reach its own containers)
    "-p",
    `127.0.0.1:${opts.gatewayPort}:${opts.gatewayPort}`,
    // Tell container to bind to the configured port
    "-e",
    `PORT=${opts.gatewayPort}`,
    // Set secure mode flag so gateway knows to use placeholders and fetch wrapper
    "-e",
    "OPENCLAW_SECURE_MODE=1",
    // Tell the container where the proxy is (via relay on the internal network)
    "-e",
    `PROXY_URL=${proxyUrl}`,
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
    if (/^[^:]+:[^:]+(:(ro|rw))?$/.test(bind)) {
      args.push("-v", bind);
      logger.info(`Adding bind mount: ${bind}`);
    } else {
      logger.warn(`Invalid bind mount format (expected host:container[:ro|rw]): ${bind}`);
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
    if (/[\n\r]/.test(value ?? "")) {
      logger.warn(`Skipping env var with newline: ${key}`);
      continue;
    }
    args.push("-e", `${key}=${value}`);
  }

  args.push(GATEWAY_IMAGE);

  // Run gateway with allow-unconfigured flag for secure mode
  // Bind to 0.0.0.0 inside container since we're on an internal network (no external exposure)
  args.push("node", "dist/index.js", "gateway", "--allow-unconfigured", "--bind", "loopback");

  logger.info(`Starting gateway container: ${GATEWAY_CONTAINER_NAME} (network: ${SECURE_NETWORK_NAME})`);
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
      filtered[key] = value;
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

    filtered[key] = value;
  }

  return filtered;
}
