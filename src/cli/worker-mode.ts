import { normalize, isAbsolute } from "node:path";
import { FLAG_TERMINATOR } from "../infra/cli-root-options.js";

export interface WorkerModeEnv {
  teamName: string;
  memberName: string;
  role: string;
  configPath: string;
  notifyPort: number;
}

export type WorkerFactory = (env: WorkerModeEnv) => Promise<void>;

let _factory: WorkerFactory | null = null;

export function isWorkerMode(argv: string[]): boolean {
  const args = argv.slice(2);
  for (const arg of args) {
    if (arg === FLAG_TERMINATOR) {
      break;
    }
    if (arg === "--mode=worker") {
      return true;
    }
  }
  return false;
}

export function parseWorkerModeEnv(): WorkerModeEnv {
  function requireEnv(key: string): string {
    const value = process.env[key];
    if (!value || !value.trim()) {
      throw new Error(
        `[openclaw] --mode=worker: required environment variable ${key} is missing or empty`,
      );
    }
    return value.trim();
  }

  const teamName = requireEnv("OPENCLAW_TEAM_NAME");
  const memberName = requireEnv("OPENCLAW_MEMBER_NAME");
  const role = requireEnv("OPENCLAW_ROLE");

  const rawConfigPath = requireEnv("OPENCLAW_CONFIG_PATH");
  if (!isAbsolute(rawConfigPath)) {
    throw new Error(
      `[openclaw] --mode=worker: OPENCLAW_CONFIG_PATH must be an absolute path, got: ${rawConfigPath}`,
    );
  }
  const normalizedConfigPath = normalize(rawConfigPath);
  if (normalizedConfigPath !== rawConfigPath) {
    throw new Error(
      `[openclaw] --mode=worker: OPENCLAW_CONFIG_PATH must not contain traversal segments (..): ${rawConfigPath}`,
    );
  }

  const rawPort = requireEnv("OPENCLAW_NOTIFY_PORT");
  const notifyPort = Number.parseInt(rawPort, 10);
  if (!Number.isInteger(notifyPort) || notifyPort < 1024 || notifyPort > 65535) {
    throw new Error(
      `[openclaw] --mode=worker: OPENCLAW_NOTIFY_PORT must be an integer in range 1024-65535, got: ${rawPort}`,
    );
  }

  return { teamName, memberName, role, configPath: normalizedConfigPath, notifyPort };
}

export function registerWorkerFactory(fn: WorkerFactory | null): void {
  _factory = fn;
}

export function getRegisteredWorkerFactory(): WorkerFactory | null {
  return _factory;
}

export async function runWorkerMode(env: WorkerModeEnv): Promise<void> {
  const factory = _factory;
  if (!factory) {
    throw new Error(
      `[openclaw] --mode=worker: no worker factory registered.\n` +
        `Install a plugin that provides worker support (e.g. openclaw-teams).`,
    );
  }
  return factory(env);
}
