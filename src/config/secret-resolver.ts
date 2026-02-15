import { execFileSync } from "node:child_process";
import { isPlainObject } from "../utils.js";

const OP_REF_RE = /^op:\/\//i;
const VAULT_REF_RE = /^vault:\/\//i;

export class SecretResolutionError extends Error {
  constructor(
    message: string,
    public readonly configPath: string,
  ) {
    super(`${message} (at ${configPath})`);
    this.name = "SecretResolutionError";
  }
}

type ResolveDeps = {
  exec?: typeof execFileSync;
};

function resolveOpSecret(ref: string, deps: ResolveDeps): string {
  const exec = deps.exec ?? execFileSync;
  try {
    const out = exec("op", ["read", ref], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return out.trim();
  } catch (err) {
    throw new Error(`1Password secret read failed: ${String(err)}`);
  }
}

function resolveVaultSecret(ref: string, deps: ResolveDeps): string {
  const exec = deps.exec ?? execFileSync;
  const body = ref.replace(/^vault:\/\//i, "");
  const [pathPart, fieldPart] = body.split("#", 2);
  const path = pathPart?.trim();
  const field = fieldPart?.trim() || "value";
  if (!path) {
    throw new Error("Vault secret ref must include a path");
  }
  try {
    const out = exec("vault", ["kv", "get", `-field=${field}`, path], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return out.trim();
  } catch (err) {
    throw new Error(`Vault secret read failed: ${String(err)}`);
  }
}

function resolveSecretRef(value: string, configPath: string, deps: ResolveDeps): string {
  const trimmed = value.trim();
  if (OP_REF_RE.test(trimmed)) {
    return resolveOpSecret(trimmed, deps);
  }
  if (VAULT_REF_RE.test(trimmed)) {
    return resolveVaultSecret(trimmed, deps);
  }
  return value;
}

function resolveAny(value: unknown, configPath: string, deps: ResolveDeps): unknown {
  if (typeof value === "string") {
    if (!OP_REF_RE.test(value.trim()) && !VAULT_REF_RE.test(value.trim())) {
      return value;
    }
    try {
      return resolveSecretRef(value, configPath, deps);
    } catch (err) {
      throw new SecretResolutionError(String(err), configPath);
    }
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => resolveAny(item, `${configPath}[${index}]`, deps));
  }
  if (isPlainObject(value)) {
    const next: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      const childPath = configPath ? `${configPath}.${key}` : key;
      next[key] = resolveAny(child, childPath, deps);
    }
    return next;
  }
  return value;
}

export function resolveConfigSecrets(obj: unknown, deps: ResolveDeps = {}): unknown {
  return resolveAny(obj, "", deps);
}

