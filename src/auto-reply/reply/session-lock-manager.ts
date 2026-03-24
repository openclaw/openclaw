import net from "node:net";
import tls from "node:tls";
import { logVerbose } from "../../globals.js";
import { generateSecureUuid } from "../../infra/secure-random.js";

export interface SessionLockManager {
  acquire(
    sessionKey: string,
    ttlMs: number,
  ): Promise<{ acquired: true; ownerId: string } | { acquired: false }>;
  release(sessionKey: string, ownerId: string): Promise<void>;
  renew(sessionKey: string, ownerId: string, ttlMs: number): Promise<boolean>;
}

type RedisReply = number | string | null | RedisReply[];

type RedisCommandRunner = (args: string[]) => Promise<RedisReply>;

const DEFAULT_ACP_SESSION_LOCK_TTL_MS = 120_000;
const MIN_LOCK_TTL_MS = 1_000;
const LOCK_KEY_PREFIX = "lock:acp:session:";
const RELEASE_IF_OWNER_LUA = `if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) else return 0 end`;
const RENEW_IF_OWNER_LUA = `if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("PEXPIRE", KEYS[1], ARGV[2]) else return 0 end`;

type RedisConnectionConfig = {
  tls: boolean;
  host: string;
  port: number;
  username?: string;
  password?: string;
  database: number;
};

class RedisProtocolError extends Error {}

class RedisSocketConnection {
  private readonly socket: net.Socket | tls.TLSSocket;
  private buffer = Buffer.alloc(0);
  private pending:
    | {
        resolve: (value: RedisReply) => void;
        reject: (error: Error) => void;
      }
    | undefined;

  constructor(socket: net.Socket | tls.TLSSocket) {
    this.socket = socket;
    this.socket.on("data", (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.flushPending();
    });
    this.socket.on("error", (error) => {
      if (this.pending) {
        this.pending.reject(error);
        this.pending = undefined;
      }
    });
    this.socket.on("close", () => {
      if (this.pending) {
        this.pending.reject(new Error("Redis socket closed before response was received."));
        this.pending = undefined;
      }
    });
  }

  async sendCommand(args: string[], timeoutMs = 10_000): Promise<RedisReply> {
    if (this.pending) {
      throw new Error("Redis command pipelining is not supported by this connection.");
    }
    const payload = encodeRedisCommand(args);
    this.socket.write(payload);
    const parsed = tryParseRedisReply(this.buffer);
    if (parsed) {
      this.buffer = this.buffer.subarray(parsed.nextOffset);
      if (parsed.error) {
        throw parsed.error;
      }
      return parsed.value;
    }
    return await Promise.race([
      new Promise<RedisReply>((resolve, reject) => {
        this.pending = { resolve, reject };
      }),
      new Promise<never>((_, reject) => {
        setTimeout(
          () => reject(new Error(`Redis command timed out after ${timeoutMs}ms.`)),
          timeoutMs,
        );
      }),
    ]);
  }

  close(): void {
    this.socket.end();
    this.socket.destroy();
  }

  private flushPending(): void {
    if (!this.pending) {
      return;
    }
    const parsed = tryParseRedisReply(this.buffer);
    if (!parsed) {
      return;
    }
    this.buffer = this.buffer.subarray(parsed.nextOffset);
    const pending = this.pending;
    this.pending = undefined;
    if (parsed.error) {
      pending.reject(parsed.error);
      return;
    }
    pending.resolve(parsed.value);
  }
}

function encodeRedisCommand(args: string[]): Buffer {
  const lines: string[] = [`*${args.length}`];
  for (const arg of args) {
    lines.push(`$${Buffer.byteLength(arg)}`);
    lines.push(arg);
  }
  return Buffer.from(`${lines.join("\r\n")}\r\n`, "utf8");
}

function tryReadLine(
  buffer: Buffer,
  startOffset: number,
): { line: string; nextOffset: number } | null {
  const lineEnd = buffer.indexOf("\r\n", startOffset);
  if (lineEnd < 0) {
    return null;
  }
  const line = buffer.toString("utf8", startOffset, lineEnd);
  return { line, nextOffset: lineEnd + 2 };
}

function parseRedisValueAt(
  buffer: Buffer,
  startOffset: number,
): { value: RedisReply; nextOffset: number; error?: Error } | null {
  if (startOffset >= buffer.length) {
    return null;
  }
  const type = String.fromCharCode(buffer[startOffset]);
  const line = tryReadLine(buffer, startOffset + 1);
  if (!line) {
    return null;
  }
  if (type === "+") {
    return { value: line.line, nextOffset: line.nextOffset };
  }
  if (type === "-") {
    return {
      value: line.line,
      nextOffset: line.nextOffset,
      error: new RedisProtocolError(`Redis error reply: ${line.line}`),
    };
  }
  if (type === ":") {
    const parsed = Number.parseInt(line.line, 10);
    if (!Number.isFinite(parsed)) {
      throw new RedisProtocolError(`Invalid Redis integer reply: ${line.line}`);
    }
    return { value: parsed, nextOffset: line.nextOffset };
  }
  if (type === "$") {
    const len = Number.parseInt(line.line, 10);
    if (!Number.isFinite(len)) {
      throw new RedisProtocolError(`Invalid Redis bulk length: ${line.line}`);
    }
    if (len === -1) {
      return { value: null, nextOffset: line.nextOffset };
    }
    const bodyEnd = line.nextOffset + len;
    if (bodyEnd + 2 > buffer.length) {
      return null;
    }
    const text = buffer.toString("utf8", line.nextOffset, bodyEnd);
    return { value: text, nextOffset: bodyEnd + 2 };
  }
  if (type === "*") {
    const count = Number.parseInt(line.line, 10);
    if (!Number.isFinite(count)) {
      throw new RedisProtocolError(`Invalid Redis array length: ${line.line}`);
    }
    if (count === -1) {
      return { value: null, nextOffset: line.nextOffset };
    }
    let nextOffset = line.nextOffset;
    const values: RedisReply[] = [];
    for (let idx = 0; idx < count; idx += 1) {
      const child = parseRedisValueAt(buffer, nextOffset);
      if (!child) {
        return null;
      }
      nextOffset = child.nextOffset;
      if (child.error) {
        return {
          value: child.value,
          nextOffset,
          error: child.error,
        };
      }
      values.push(child.value);
    }
    return { value: values, nextOffset };
  }
  throw new RedisProtocolError(`Unsupported Redis response type: ${type}`);
}

function tryParseRedisReply(
  buffer: Buffer,
): { value: RedisReply; nextOffset: number; error?: Error } | null {
  return parseRedisValueAt(buffer, 0);
}

function parseRedisConnectionConfig(redisUrl: string): RedisConnectionConfig {
  const parsed = new URL(redisUrl);
  if (parsed.protocol !== "redis:" && parsed.protocol !== "rediss:") {
    throw new Error(
      `Unsupported Redis URL protocol "${parsed.protocol}". Expected redis:// or rediss://.`,
    );
  }
  const host = parsed.hostname?.trim();
  if (!host) {
    throw new Error("Redis URL must include a host.");
  }
  const portRaw = parsed.port?.trim();
  const port = portRaw ? Number.parseInt(portRaw, 10) : 6379;
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`Redis URL has invalid port: ${portRaw || "(empty)"}`);
  }
  const username = parsed.username ? decodeURIComponent(parsed.username) : undefined;
  const password = parsed.password ? decodeURIComponent(parsed.password) : undefined;
  const dbRaw = parsed.pathname.replace(/^\//, "").trim();
  const database = dbRaw ? Number.parseInt(dbRaw, 10) : 0;
  if (!Number.isFinite(database) || database < 0) {
    throw new Error(`Redis URL has invalid database index: ${dbRaw || "(empty)"}`);
  }
  return {
    tls: parsed.protocol === "rediss:",
    host,
    port,
    username,
    password,
    database,
  };
}

async function connectRedis(config: RedisConnectionConfig): Promise<RedisSocketConnection> {
  const socket: net.Socket | tls.TLSSocket = await new Promise((resolve, reject) => {
    const connectHandler = () => {
      cleanup();
      resolve(rawSocket);
    };
    const errorHandler = (error: Error) => {
      cleanup();
      reject(error);
    };
    const timeoutHandler = () => {
      cleanup();
      reject(new Error("Redis connection timed out."));
    };
    const cleanup = () => {
      rawSocket.off("connect", connectHandler);
      rawSocket.off("error", errorHandler);
      rawSocket.off("timeout", timeoutHandler);
    };
    const rawSocket = config.tls
      ? tls.connect({ host: config.host, port: config.port })
      : net.createConnection({ host: config.host, port: config.port });
    rawSocket.setTimeout(10_000);
    rawSocket.on("connect", connectHandler);
    rawSocket.on("error", errorHandler);
    rawSocket.on("timeout", timeoutHandler);
  });
  const connection = new RedisSocketConnection(socket);
  if (config.password) {
    const authArgs = config.username
      ? ["AUTH", config.username, config.password]
      : ["AUTH", config.password];
    await connection.sendCommand(authArgs);
  }
  if (config.database !== 0) {
    await connection.sendCommand(["SELECT", String(config.database)]);
  }
  return connection;
}

function createRedisCommandRunner(redisUrl: string): RedisCommandRunner {
  // No shared Redis client currently exists in this repo; keep lock-scoped RESP wiring local.
  const config = parseRedisConnectionConfig(redisUrl);
  return async (args: string[]) => {
    const connection = await connectRedis(config);
    try {
      return await connection.sendCommand(args);
    } finally {
      connection.close();
    }
  };
}

function toPositiveTtlMs(ttlMs: number): number {
  if (!Number.isFinite(ttlMs)) {
    return DEFAULT_ACP_SESSION_LOCK_TTL_MS;
  }
  return Math.max(MIN_LOCK_TTL_MS, Math.floor(ttlMs));
}

function lockKeyForSession(sessionKey: string): string {
  return `${LOCK_KEY_PREFIX}${sessionKey}`;
}

type LocalLockEntry = {
  ownerId: string;
  expiresAtMs: number;
};

export class LocalSessionLockManager implements SessionLockManager {
  private readonly locks = new Map<string, LocalLockEntry>();

  async acquire(
    sessionKey: string,
    ttlMs: number,
  ): Promise<{ acquired: true; ownerId: string } | { acquired: false }> {
    this.clearIfExpired(sessionKey);
    if (this.locks.has(sessionKey)) {
      return { acquired: false };
    }
    const ownerId = generateSecureUuid();
    this.locks.set(sessionKey, {
      ownerId,
      expiresAtMs: Date.now() + toPositiveTtlMs(ttlMs),
    });
    return { acquired: true, ownerId };
  }

  async release(sessionKey: string, ownerId: string): Promise<void> {
    this.clearIfExpired(sessionKey);
    const lock = this.locks.get(sessionKey);
    if (!lock || lock.ownerId !== ownerId) {
      return;
    }
    this.locks.delete(sessionKey);
  }

  async renew(sessionKey: string, ownerId: string, ttlMs: number): Promise<boolean> {
    this.clearIfExpired(sessionKey);
    const lock = this.locks.get(sessionKey);
    if (!lock || lock.ownerId !== ownerId) {
      return false;
    }
    lock.expiresAtMs = Date.now() + toPositiveTtlMs(ttlMs);
    this.locks.set(sessionKey, lock);
    return true;
  }

  private clearIfExpired(sessionKey: string): void {
    const lock = this.locks.get(sessionKey);
    if (!lock) {
      return;
    }
    if (lock.expiresAtMs <= Date.now()) {
      this.locks.delete(sessionKey);
    }
  }
}

export class RedisSessionLockManager implements SessionLockManager {
  private readonly runRedisCommand: RedisCommandRunner;
  private readonly ownerIdFactory: () => string;

  constructor(params: {
    redisUrl?: string;
    runRedisCommand?: RedisCommandRunner;
    ownerIdFactory?: () => string;
  }) {
    if (!params.redisUrl && !params.runRedisCommand) {
      throw new Error("RedisSessionLockManager requires redisUrl or runRedisCommand.");
    }
    this.runRedisCommand =
      params.runRedisCommand ??
      createRedisCommandRunner(
        params.redisUrl ??
          (() => {
            throw new Error("Missing redisUrl");
          })(),
      );
    this.ownerIdFactory = params.ownerIdFactory ?? generateSecureUuid;
  }

  async acquire(
    sessionKey: string,
    ttlMs: number,
  ): Promise<{ acquired: true; ownerId: string } | { acquired: false }> {
    const ownerId = this.ownerIdFactory();
    const result = await this.runRedisCommand([
      "SET",
      lockKeyForSession(sessionKey),
      ownerId,
      "NX",
      "PX",
      String(toPositiveTtlMs(ttlMs)),
    ]);
    if (result === "OK") {
      return { acquired: true, ownerId };
    }
    return { acquired: false };
  }

  async release(sessionKey: string, ownerId: string): Promise<void> {
    await this.runRedisCommand([
      "EVAL",
      RELEASE_IF_OWNER_LUA,
      "1",
      lockKeyForSession(sessionKey),
      ownerId,
    ]);
  }

  async renew(sessionKey: string, ownerId: string, ttlMs: number): Promise<boolean> {
    const result = await this.runRedisCommand([
      "EVAL",
      RENEW_IF_OWNER_LUA,
      "1",
      lockKeyForSession(sessionKey),
      ownerId,
      String(toPositiveTtlMs(ttlMs)),
    ]);
    return Number(result) === 1;
  }
}

class FailClosedSessionLockManager implements SessionLockManager {
  private readonly reason: string;

  constructor(reason: string) {
    this.reason = reason;
  }

  async acquire(
    _sessionKey: string,
    _ttlMs: number,
  ): Promise<{ acquired: true; ownerId: string } | { acquired: false }> {
    throw new Error(`Redis ACP session lock manager unavailable: ${this.reason}`);
  }

  async release(_sessionKey: string, _ownerId: string): Promise<void> {}

  async renew(_sessionKey: string, _ownerId: string, _ttlMs: number): Promise<boolean> {
    return false;
  }
}

export function resolveAcpSessionLockTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.OPENCLAW_ACP_SESSION_LOCK_TTL_MS?.trim();
  if (!raw) {
    return DEFAULT_ACP_SESSION_LOCK_TTL_MS;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_ACP_SESSION_LOCK_TTL_MS;
  }
  return toPositiveTtlMs(parsed);
}

function resolveRedisLockUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const normalized = env.OPENCLAW_ACP_SESSION_LOCK_REDIS_URL?.trim();
  return normalized || null;
}

let ACP_SESSION_LOCK_MANAGER_SINGLETON: SessionLockManager | null = null;

export function getAcpSessionLockManager(env: NodeJS.ProcessEnv = process.env): SessionLockManager {
  if (ACP_SESSION_LOCK_MANAGER_SINGLETON) {
    return ACP_SESSION_LOCK_MANAGER_SINGLETON;
  }
  const redisUrl = resolveRedisLockUrl(env);
  if (!redisUrl) {
    ACP_SESSION_LOCK_MANAGER_SINGLETON = new LocalSessionLockManager();
    logVerbose("dispatch-acp-lock: backend=local redis_configured=false");
    return ACP_SESSION_LOCK_MANAGER_SINGLETON;
  }
  try {
    ACP_SESSION_LOCK_MANAGER_SINGLETON = new RedisSessionLockManager({ redisUrl });
    logVerbose("dispatch-acp-lock: backend=redis");
    return ACP_SESSION_LOCK_MANAGER_SINGLETON;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ACP_SESSION_LOCK_MANAGER_SINGLETON = new FailClosedSessionLockManager(message);
    logVerbose(`dispatch-acp-lock: backend=redis init_failed=${message} fail_closed=true`);
    return ACP_SESSION_LOCK_MANAGER_SINGLETON;
  }
}

export function resetAcpSessionLockManagerForTests(): void {
  ACP_SESSION_LOCK_MANAGER_SINGLETON = null;
}
