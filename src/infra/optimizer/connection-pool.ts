/**
 * Connection Pool Manager
 * Optimizes HTTP connections with connection pooling and keep-alive
 */

import { EventEmitter } from "node:events";
import type { Pool } from "undici";

export interface ConnectionPoolOptions {
  maxConnectionsPerHost?: number;
  keepAlive?: boolean;
  timeout?: number;
}

export interface ConnectionPoolMetrics {
  httpRequestsServed: number;
  httpConnectionsReused: number;
  errors: number;
  httpPools: number;
}

export class ConnectionPoolManager extends EventEmitter {
  private config: Required<ConnectionPoolOptions>;
  private httpPools: Map<string, Pool> = new Map();
  private metrics = {
    httpRequestsServed: 0,
    httpConnectionsReused: 0,
    errors: 0,
  };

  constructor(options: ConnectionPoolOptions = {}) {
    super();
    this.config = {
      maxConnectionsPerHost: options.maxConnectionsPerHost ?? 50,
      keepAlive: options.keepAlive ?? true,
      timeout: options.timeout ?? 30000,
    };
  }

  private getPoolKey(url: string): string {
    try {
      const parsed = new URL(url);
      return `${parsed.protocol}//${parsed.host}`;
    } catch {
      return url;
    }
  }

  async getHttpPool(baseUrl: string): Promise<Pool> {
    const { Pool: UndiciPool } = await import("undici");
    const poolKey = this.getPoolKey(baseUrl);

    if (!this.httpPools.has(poolKey)) {
      const pool = new UndiciPool(baseUrl, {
        connections: this.config.maxConnectionsPerHost,
        pipelining: 1,
        keepAliveTimeout: this.config.keepAlive ? 30000 : undefined,
        keepAliveMaxTimeout: this.config.keepAlive ? 60000 : undefined,
      });
      this.httpPools.set(poolKey, pool);
    }

    return this.httpPools.get(poolKey)!;
  }

  async httpRequest(
    url: string,
    options: {
      method?: string;
      headers?: Record<string, string>;
      body?: string | Buffer | Uint8Array;
      signal?: AbortSignal;
    } = {},
  ): Promise<{ statusCode: number; headers: Record<string, string>; body: Buffer }> {
    const parsedUrl = new URL(url);
    const baseUrl = `${parsedUrl.protocol}//${parsedUrl.host}`;
    const pool = await this.getHttpPool(baseUrl);

    try {
      const response = await pool.request({
        method: options.method || "GET",
        path: parsedUrl.pathname + parsedUrl.search,
        headers: options.headers || {},
        body: options.body,
        signal: options.signal,
      });

      this.metrics.httpRequestsServed++;

      const chunks: Buffer[] = [];
      for await (const chunk of response.body) {
        chunks.push(chunk);
      }

      return {
        statusCode: response.statusCode,
        headers: response.headers as Record<string, string>,
        body: Buffer.concat(chunks),
      };
    } catch (error) {
      this.metrics.errors++;
      throw error;
    }
  }

  getMetrics(): ConnectionPoolMetrics {
    return {
      ...this.metrics,
      httpPools: this.httpPools.size,
    };
  }

  async close(): Promise<void> {
    const closePromises: Promise<void>[] = [];

    for (const pool of this.httpPools.values()) {
      closePromises.push(pool.destroy());
    }

    await Promise.all(closePromises);
    this.httpPools.clear();
  }
}

let globalPool: ConnectionPoolManager | null = null;

export function getConnectionPool(options?: ConnectionPoolOptions): ConnectionPoolManager {
  if (!globalPool) {
    globalPool = new ConnectionPoolManager(options);
  }
  return globalPool;
}

export async function closeConnectionPool(): Promise<void> {
  if (globalPool) {
    await globalPool.close();
    globalPool = null;
  }
}
