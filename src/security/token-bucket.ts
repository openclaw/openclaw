/**
 * Token bucket algorithm for rate limiting
 *
 * Allows burst traffic while enforcing long-term rate limits.
 * Each bucket has a capacity and refill rate.
 */

export interface TokenBucketConfig {
  /** Maximum number of tokens (burst capacity) */
  capacity: number;
  /** Tokens refilled per millisecond */
  refillRate: number;
}

export class TokenBucket {
  private tokens: number;
  private lastRefillTime: number;

  constructor(private readonly config: TokenBucketConfig) {
    this.tokens = config.capacity;
    this.lastRefillTime = Date.now();
  }

  /**
   * Try to consume tokens
   * Returns true if tokens were available and consumed
   */
  consume(count: number = 1): boolean {
    this.refill();

    if (this.tokens >= count) {
      this.tokens -= count;
      return true;
    }

    return false;
  }

  /**
   * Get current token count
   */
  getTokens(): number {
    this.refill();
    return Math.floor(this.tokens);
  }

  /**
   * Get time until next token is available (in milliseconds)
   */
  getRetryAfterMs(count: number = 1): number {
    this.refill();

    if (this.tokens >= count) {
      return 0;
    }

    // If count exceeds capacity, we can never fulfill this request
    if (count > this.config.capacity) {
      return Infinity;
    }

    const tokensNeeded = count - this.tokens;
    return Math.ceil(tokensNeeded / this.config.refillRate);
  }

  /**
   * Reset bucket to full capacity
   */
  reset(): void {
    this.tokens = this.config.capacity;
    this.lastRefillTime = Date.now();
  }

  /**
   * Refill tokens based on elapsed time
   */
  private refill(): void {
    const now = Date.now();
    const elapsedMs = now - this.lastRefillTime;

    if (elapsedMs > 0) {
      const tokensToAdd = elapsedMs * this.config.refillRate;
      this.tokens = Math.min(this.config.capacity, this.tokens + tokensToAdd);
      this.lastRefillTime = now;
    }
  }
}

/**
 * Create a token bucket from max/window configuration
 */
export function createTokenBucket(params: { max: number; windowMs: number }): TokenBucket {
  const { max, windowMs } = params;

  // Refill rate: max tokens over windowMs
  const refillRate = max / windowMs;

  return new TokenBucket({
    capacity: max,
    refillRate,
  });
}
