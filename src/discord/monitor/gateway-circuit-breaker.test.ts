import { DiscordGatewayCircuitBreaker } from "./gateway-circuit-breaker.js";

describe("DiscordGatewayCircuitBreaker", () => {
  it("should trip after max consecutive failures", () => {
    const breaker = new DiscordGatewayCircuitBreaker({
      maxConsecutiveFailures: 3,
    });

    // Record failures
    expect(breaker.recordResumeFailure()).toBe(false);
    expect(breaker.recordResumeFailure()).toBe(false);
    expect(breaker.recordResumeFailure()).toBe(true); // Should trip

    expect(breaker.shouldTripBreaker()).toBe(true);
  });

  it("should reset counter on success", () => {
    const breaker = new DiscordGatewayCircuitBreaker({
      maxConsecutiveFailures: 3,
    });

    // Record some failures
    breaker.recordResumeFailure();
    breaker.recordResumeFailure();

    // Record success
    breaker.recordResumeSuccess();

    // Counter should be reset
    const state = breaker.getState();
    expect(state.consecutiveFailures).toBe(0);
    expect(state.shouldTrip).toBe(false);
  });

  it("should reset failures after window expires", () => {
    const breaker = new DiscordGatewayCircuitBreaker({
      maxConsecutiveFailures: 3,
      resetWindowMs: 100, // 100ms window for testing
    });

    // Record a failure
    breaker.recordResumeAttempt();
    breaker.recordResumeFailure();

    // Wait for window to expire
    setTimeout(() => {
      // Record another failure - should reset counter
      breaker.recordResumeAttempt();
      const shouldTrip = breaker.recordResumeFailure();

      expect(shouldTrip).toBe(false);
      expect(breaker.getState().consecutiveFailures).toBe(1);
    }, 150);
  });
});
