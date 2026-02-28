import { Pool, PoolClient, QueryResult } from "pg";
import { buildPostgresConfig } from "../../db/config.js";

/**
 * EvidenceRepository handles database operations for evidence records.
 * Uses centralized PostgreSQL configuration for test-aware connection setup.
 */
export class EvidenceRepository {
  private pool: Pool;
  private retryCount = 0;
  private maxRetries = 3;
  private retryDelay = 1000;

  constructor() {
    const cfg = buildPostgresConfig();

    this.pool = new Pool(cfg);

    // Handle connection errors
    this.pool.on("error", (err: Error) => {
      console.error("Unexpected error on idle client", err);
    });
  }

  /**
   * Execute a query with retry logic on connection failures.
   */
  async query<T = any>(
    text: string,
    values?: any[]
  ): Promise<QueryResult<T>> {
    try {
      return await this.pool.query(text, values);
    } catch (error) {
      if (
        this.retryCount < this.maxRetries &&
        this.isConnectionError(error)
      ) {
        this.retryCount++;
        await new Promise((resolve) => setTimeout(resolve, this.retryDelay));
        return this.query(text, values);
      }
      this.retryCount = 0;
      throw error;
    }
  }

  /**
   * Get a client from the pool for transaction support.
   */
  async getClient(): Promise<PoolClient> {
    return this.pool.connect();
  }

  /**
   * Close the connection pool.
   */
  async close(): Promise<void> {
    return this.pool.end();
  }

  /**
   * Check if error is connection-related and retryable.
   */
  private isConnectionError(error: any): boolean {
    if (!error) return false;
    const code = error.code;
    // ECONNREFUSED, ENOTFOUND, ETIMEDOUT, EHOSTUNREACH
    return (
      code === "ECONNREFUSED" ||
      code === "ENOTFOUND" ||
      code === "ETIMEDOUT" ||
      code === "EHOSTUNREACH" ||
      (error.message && error.message.includes("connect"))
    );
  }
}
