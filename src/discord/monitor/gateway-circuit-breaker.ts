/**
 * Circuit breaker for Discord WebSocket resume loops
 * Prevents infinite resume attempts when session is stale
 */
export class DiscordGatewayCircuitBreaker {
  private consecutiveResumeFailures = 0;
  private lastResumeAttempt = 0;
  private readonly maxConsecutiveFailures: number;
  private readonly resetWindowMs: number;

  constructor(options?: { maxConsecutiveFailures?: number; resetWindowMs?: number }) {
    this.maxConsecutiveFailures = options?.maxConsecutiveFailures ?? 5;
    this.resetWindowMs = options?.resetWindowMs ?? 60000; // 1 minute
  }

  /**
   * Record a resume attempt
   */
  recordResumeAttempt(): void {
    this.lastResumeAttempt = Date.now();
  }

  /**
   * Record a successful resume
   */
  recordResumeSuccess(): void {
    this.consecutiveResumeFailures = 0;
    this.lastResumeAttempt = 0;
  }

  /**
   * Record a failed resume attempt
   * @returns true if circuit breaker should trip (abandon session)
   */
  recordResumeFailure(): boolean {
    const now = Date.now();

    // If it's been more than the reset window since last attempt, reset counter
    if (this.lastResumeAttempt && now - this.lastResumeAttempt > this.resetWindowMs) {
      this.consecutiveResumeFailures = 0;
    }

    this.consecutiveResumeFailures++;
    this.lastResumeAttempt = now;

    return this.shouldTripBreaker();
  }

  /**
   * Check if circuit breaker should trip
   */
  shouldTripBreaker(): boolean {
    return this.consecutiveResumeFailures >= this.maxConsecutiveFailures;
  }

  /**
   * Reset the circuit breaker
   */
  reset(): void {
    this.consecutiveResumeFailures = 0;
    this.lastResumeAttempt = 0;
  }

  /**
   * Get current state for debugging
   */
  getState(): {
    consecutiveFailures: number;
    maxFailures: number;
    shouldTrip: boolean;
  } {
    return {
      consecutiveFailures: this.consecutiveResumeFailures,
      maxFailures: this.maxConsecutiveFailures,
      shouldTrip: this.shouldTripBreaker(),
    };
  }
}
