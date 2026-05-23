/**
 * ClaWorks Redis session / cache adapter.
 *
 * Lazy-loads the `ioredis` package so the module is safe to import even when
 * Redis is not installed. If the package is unavailable, every operation
 * throws a descriptive error rather than crashing at startup.
 *
 * Usage:
 *   import { createRedisAdapter } from "./redis-adapter.js";
 *   const redis = createRedisAdapter({ url: process.env.CLAWORKS_REDIS_URL });
 *   await redis.set("session:abc", JSON.stringify(data), { ttlSeconds: 3600 });
 */

// ─── Types ────────────────────────────────────────────────────────────────────

/** Minimal subset of ioredis Redis client that we rely on. */
type RedisClient = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<"OK" | null>;
  setex(key: string, seconds: number, value: string): Promise<"OK">;
  del(key: string): Promise<number>;
  exists(key: string): Promise<number>;
  quit(): Promise<"OK">;
};

type IORedisCtor = new (url: string) => RedisClient;

type IoRedisModule = { default: IORedisCtor } | IORedisCtor;

export type RedisAdapterOptions = {
  /** Redis connection URL, e.g. redis://localhost:6379 or redis://:password@host:port */
  url: string;
};

export type RedisSetOptions = {
  /** Time-to-live in seconds. If omitted, the key persists indefinitely. */
  ttlSeconds?: number;
};

export type RedisAdapter = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, opts?: RedisSetOptions): Promise<void>;
  del(key: string): Promise<void>;
  has(key: string): Promise<boolean>;
  /** Close the underlying connection pool. Call on process shutdown. */
  close(): Promise<void>;
};

// ─── Module loader ────────────────────────────────────────────────────────────

function buildMissingPackageError(cause: unknown): Error {
  return new Error(
    [
      "claworks redis-adapter: ioredis is not installed.",
      "Add it as a dependency: pnpm add ioredis",
      "Or disable Redis-backed features and use the in-memory fallback.",
      String(cause),
    ].join(" "),
    { cause },
  );
}

type LoaderDeps = {
  importIoRedis: () => Promise<IoRedisModule>;
};

export function createRedisClientLoader(overrides: Partial<LoaderDeps> = {}): {
  load(): Promise<IORedisCtor>;
} {
  const deps: LoaderDeps = {
    importIoRedis: overrides.importIoRedis ?? (() => import("ioredis")),
  };

  let loadPromise: Promise<IORedisCtor> | null = null;

  return {
    async load(): Promise<IORedisCtor> {
      if (!loadPromise) {
        loadPromise = deps
          .importIoRedis()
          .then((mod): IORedisCtor => {
            // ioredis exports a class as default
            const ctor = "default" in mod ? mod.default : (mod as unknown as IORedisCtor);
            if (typeof ctor !== "function") {
              throw new Error("ioredis module did not export a constructor");
            }
            return ctor as IORedisCtor;
          })
          .catch((err) => {
            loadPromise = null;
            throw buildMissingPackageError(err);
          });
      }
      return loadPromise;
    },
  };
}

// ─── Adapter factory ──────────────────────────────────────────────────────────

const defaultLoader = createRedisClientLoader();

/**
 * Create a Redis-backed key/value adapter. The underlying ioredis client is
 * initialized lazily on the first operation.
 */
export function createRedisAdapter(opts: RedisAdapterOptions): RedisAdapter {
  let clientPromise: Promise<RedisClient> | null = null;

  async function client(): Promise<RedisClient> {
    if (!clientPromise) {
      clientPromise = defaultLoader.load().then((Ctor) => new Ctor(opts.url));
    }
    return clientPromise;
  }

  return {
    async get(key: string): Promise<string | null> {
      return (await client()).get(key);
    },

    async set(key: string, value: string, setOpts?: RedisSetOptions): Promise<void> {
      const c = await client();
      if (setOpts?.ttlSeconds != null && setOpts.ttlSeconds > 0) {
        await c.setex(key, setOpts.ttlSeconds, value);
      } else {
        await c.set(key, value);
      }
    },

    async del(key: string): Promise<void> {
      await (await client()).del(key);
    },

    async has(key: string): Promise<boolean> {
      return (await (await client()).exists(key)) > 0;
    },

    async close(): Promise<void> {
      if (clientPromise) {
        const c = await clientPromise;
        await c.quit();
        clientPromise = null;
      }
    },
  };
}

// ─── Env-based factory ────────────────────────────────────────────────────────

/**
 * Build a RedisAdapter from the CLAWORKS_REDIS_URL environment variable.
 * Returns `null` if the variable is not set (allows callers to fall back to
 * in-process storage).
 */
export function createRedisAdapterFromEnv(): RedisAdapter | null {
  const url = process.env["CLAWORKS_REDIS_URL"]?.trim();
  if (!url) return null;
  return createRedisAdapter({ url });
}
