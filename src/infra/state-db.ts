import { Pool } from "pg";

let pool: Pool | null = null;

type EnvLike = Record<string, string | undefined>;

export function resolveStateDbUrl(env: EnvLike = process.env as EnvLike): string | null {
  const url = env.OPENCLAW_STATE_DB_URL?.trim();
  if (!url) {
    return null;
  }
  return url;
}

export function hasStateDbConfigured(env: EnvLike = process.env as EnvLike): boolean {
  return Boolean(resolveStateDbUrl(env));
}

export function getStateDbPool(env: EnvLike = process.env as EnvLike): Pool | null {
  const url = resolveStateDbUrl(env);
  if (!url) {
    return null;
  }
  if (!pool) {
    pool = new Pool({ connectionString: url });
  }
  return pool;
}

export async function closeStateDbPool(): Promise<void> {
  if (!pool) {
    return;
  }
  const current = pool;
  pool = null;
  await current.end();
}
