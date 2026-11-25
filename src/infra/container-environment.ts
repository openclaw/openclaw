import fs from "node:fs";
import { parseTcpPort } from "./tcp-port.js";

// Internal launcher transport for the existing published-port fact, never persisted config.
export function resolveContainerPublishedGatewayPort(
  env: NodeJS.ProcessEnv = process.env,
): number | undefined {
  const raw = env.OPENCLAW_CONTAINER_PUBLISHED_GATEWAY_PORT;
  if (raw === undefined) {
    return undefined;
  }
  // Compose accepts host-qualified or dynamically allocated publish mappings.
  // Only a concrete IPv4 loopback/wildcard host port supplies localhost defaults.
  const mapped = /^(?:127\.0\.0\.1|0\.0\.0\.0):(\d+)$/.exec(raw);
  if (!mapped && (raw.includes(":") || /^\d+-\d+$/.test(raw))) {
    return undefined;
  }
  const value = mapped?.[1] ?? raw;
  if (/^0+$/.test(value)) {
    return undefined;
  }
  const port = parseTcpPort(value);
  if (port === null) {
    throw new Error("Invalid container published Gateway port; expected 1–65535.");
  }
  return port;
}

// Container identity is process-stable; cache misses as well as detections.
let containerEnvironmentCache: boolean | undefined;

export function isContainerEnvironment(): boolean {
  return (containerEnvironmentCache ??= detectContainerEnvironment());
}

function detectContainerEnvironment(): boolean {
  if (process.env.FLY_MACHINE_ID?.trim() && process.env.FLY_APP_NAME?.trim()) {
    return true;
  }

  for (const sentinelPath of ["/.dockerenv", "/run/.containerenv", "/var/run/.containerenv"]) {
    try {
      fs.accessSync(sentinelPath, fs.constants.F_OK);
      return true;
    } catch {
      // Not present; try the next signal.
    }
  }

  try {
    const cgroup = fs.readFileSync("/proc/1/cgroup", "utf8");
    if (
      /\/docker\/|cri-containerd-[0-9a-f]|containerd\/[0-9a-f]{64}|\/kubepods[/.]|\blxc\b/.test(
        cgroup,
      )
    ) {
      return true;
    }
  } catch {
    // /proc may not exist on non-Linux platforms.
  }

  return false;
}
