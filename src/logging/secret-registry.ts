import fs from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";
import { resolveOAuthDir } from "../config/paths.js";

const SECRETS_CACHE_TTL_MS = 5_000;
const MAX_CREDENTIAL_FILES = 128;
const MAX_CREDENTIAL_FILE_BYTES = 256 * 1024;
const MIN_SECRET_LENGTH = 4;
const SENSITIVE_KEY_RE = /(token|secret|password|api.?key|access|refresh)/i;
const ENV_SENSITIVE_KEY_RE =
  /(token|secret|password|api[_-]?key|access[_-]?token|refresh[_-]?token)/i;

type CacheEntry = {
  expiresAt: number;
  secrets: string[];
};

let cache: CacheEntry | null = null;

function addSecret(target: Set<string>, value: unknown): void {
  if (typeof value !== "string") {
    return;
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.length < MIN_SECRET_LENGTH) {
    return;
  }
  if (/^\$\{[^}]+\}$/.test(trimmed)) {
    return;
  }
  target.add(trimmed);
}

function collectSensitiveStrings(
  value: unknown,
  keyHint: string | undefined,
  out: Set<string>,
): void {
  if (typeof value === "string") {
    if (keyHint && SENSITIVE_KEY_RE.test(keyHint)) {
      addSecret(out, value);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectSensitiveStrings(item, keyHint, out);
    }
    return;
  }
  if (!value || typeof value !== "object") {
    return;
  }
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    collectSensitiveStrings(nested, key, out);
  }
}

function collectCredentialFileSecrets(dir: string, out: Set<string>): void {
  if (!dir || !fs.existsSync(dir)) {
    return;
  }
  const queue = [dir];
  let scannedFiles = 0;
  while (queue.length > 0 && scannedFiles < MAX_CREDENTIAL_FILES) {
    const nextDir = queue.pop();
    if (!nextDir) {
      continue;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(nextDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const absPath = path.join(nextDir, entry.name);
      if (entry.isDirectory()) {
        queue.push(absPath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      scannedFiles += 1;
      if (scannedFiles > MAX_CREDENTIAL_FILES) {
        break;
      }
      let stat: fs.Stats;
      try {
        stat = fs.statSync(absPath);
      } catch {
        continue;
      }
      if (stat.size <= 0 || stat.size > MAX_CREDENTIAL_FILE_BYTES) {
        continue;
      }
      let content: string;
      try {
        content = fs.readFileSync(absPath, "utf-8");
      } catch {
        continue;
      }
      const trimmed = content.trim();
      if (!trimmed) {
        continue;
      }
      try {
        const parsed = JSON.parse(trimmed);
        collectSensitiveStrings(parsed, undefined, out);
      } catch {
        const lines = trimmed.split(/\r?\n/);
        for (const line of lines) {
          const match = line.match(/(?:token|secret|password|api[_-]?key)\s*[:=]\s*(.+)$/i);
          if (match?.[1]) {
            addSecret(out, match[1].replace(/^["']|["']$/g, ""));
          }
        }
      }
    }
  }
}

function collectConfigSecrets(cfg: OpenClawConfig | undefined, out: Set<string>): void {
  addSecret(out, cfg?.gateway?.auth?.token);
  addSecret(out, cfg?.gateway?.auth?.password);

  const entries = cfg?.skills?.entries;
  if (!entries) {
    return;
  }
  for (const entry of Object.values(entries)) {
    addSecret(out, entry?.apiKey);
    const env = entry?.env;
    if (!env) {
      continue;
    }
    for (const envValue of Object.values(env)) {
      addSecret(out, envValue);
    }
  }
}

function collectEnvSecrets(env: NodeJS.ProcessEnv | undefined, out: Set<string>): void {
  if (!env) {
    return;
  }
  for (const [key, value] of Object.entries(env)) {
    if (!ENV_SENSITIVE_KEY_RE.test(key)) {
      continue;
    }
    addSecret(out, value);
  }
}

export function resolveRuntimeRedactionSecrets(params?: {
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  nowMs?: number;
}): string[] {
  const nowMs = params?.nowMs ?? Date.now();
  if (cache && cache.expiresAt > nowMs) {
    return cache.secrets;
  }
  const secrets = new Set<string>();
  collectConfigSecrets(params?.config, secrets);
  collectEnvSecrets(params?.env ?? process.env, secrets);
  addSecret(secrets, params?.env?.OPENCLAW_GATEWAY_TOKEN);
  addSecret(secrets, params?.env?.OPENCLAW_GATEWAY_PASSWORD);
  const credentialsDir = resolveOAuthDir(params?.env ?? process.env);
  collectCredentialFileSecrets(credentialsDir, secrets);
  const sorted = [...secrets].toSorted((a, b) => b.length - a.length);
  cache = {
    expiresAt: nowMs + SECRETS_CACHE_TTL_MS,
    secrets: sorted,
  };
  return sorted;
}

export function resetRuntimeRedactionSecretsCacheForTest(): void {
  cache = null;
}
