import type { GatewayPlugin } from "@buape/carbon/gateway";
import { EventEmitter } from "node:events";
import { warn, danger } from "../../globals.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { DiscordGatewayCircuitBreaker } from "./gateway-circuit-breaker.js";

/**
 * Wrapper for Discord Gateway that adds circuit breaker protection
 * against infinite resume loops
 */
export class DiscordGatewayWrapper {
  private gateway: GatewayPlugin;
  private circuitBreaker: DiscordGatewayCircuitBreaker;
  private logger = createSubsystemLogger("discord/gateway-wrapper");
  private originalEmitter?: EventEmitter;
  private wrappedEmitter: EventEmitter;
  private isResuming = false;

  constructor(
    gateway: GatewayPlugin,
    options?: {
      maxConsecutiveResumeFailures?: number;
      resetWindowMs?: number;
    },
  ) {
    this.gateway = gateway;
    this.circuitBreaker = new DiscordGatewayCircuitBreaker(options);
    this.wrappedEmitter = new EventEmitter();

    // Intercept the gateway's event emitter
    this.wrapGatewayEvents();
  }

  /**
   * Wrap the gateway's event emitter to intercept events
   */
  private wrapGatewayEvents(): void {
    // Store original emitter
    this.originalEmitter = (this.gateway as any).emitter;

    if (!this.originalEmitter) {
      this.logger.warn("Gateway emitter not found, circuit breaker may not work properly");
      return;
    }

    // Copy all listeners from original to wrapped
    const eventNames = this.originalEmitter.eventNames();
    for (const event of eventNames) {
      const listeners = this.originalEmitter.listeners(event);
      for (const listener of listeners) {
        this.wrappedEmitter.on(event, listener as any);
      }
    }

    // Set up our interceptor
    this.setupEventInterceptor();

    // Replace the gateway's emitter with our wrapped one
    (this.gateway as any).emitter = this.wrappedEmitter;
  }

  /**
   * Set up event interceptor to monitor resume attempts
   */
  private setupEventInterceptor(): void {
    // Listen to original emitter and forward/intercept events
    this.originalEmitter?.on("debug", (msg: string) => {
      // Check for resume-related messages
      if (msg.includes("Attempting resume")) {
        this.isResuming = true;
        this.circuitBreaker.recordResumeAttempt();
        this.logger.debug(`Resume attempt detected: ${msg}`);
      } else if (msg.includes("Reconnecting with backoff") && this.isResuming) {
        // Resume failed if we're reconnecting after attempting resume
        const shouldTrip = this.circuitBreaker.recordResumeFailure();
        const state = this.circuitBreaker.getState();

        if (shouldTrip) {
          this.logger.warn(
            warn(
              `Circuit breaker tripped after ${state.consecutiveFailures} consecutive resume failures. Forcing fresh identify.`,
            ),
          );

          // Clear the session to force a fresh identify
          this.clearSession();
        } else {
          this.logger.debug(`Resume failure ${state.consecutiveFailures}/${state.maxFailures}`);
        }

        this.isResuming = false;
      }

      // Forward the event
      this.wrappedEmitter.emit("debug", msg);
    });

    // Listen for successful resume/ready
    const handleSuccess = (eventType: string) => {
      if (this.isResuming) {
        this.circuitBreaker.recordResumeSuccess();
        this.logger.debug(`Resume successful via ${eventType}`);
        this.isResuming = false;
      }
    };

    // Set up other event forwarding
    const events = ["error", "warning", "metrics"] as const;
    for (const event of events) {
      this.originalEmitter?.on(event, (...args: any[]) => {
        this.wrappedEmitter.emit(event, ...args);
      });
    }

    // Intercept dispatch events for RESUMED
    const originalHandleEvent = (this.gateway as any).client?.eventHandler?.handleEvent;
    if (originalHandleEvent) {
      (this.gateway as any).client.eventHandler.handleEvent = (data: any, type: string) => {
        if (type === "RESUMED") {
          handleSuccess("RESUMED");
        } else if (type === "READY" && this.isResuming) {
          // Sometimes a fresh READY is sent instead of RESUMED
          handleSuccess("READY");
        }

        // Call original handler
        originalHandleEvent.call((this.gateway as any).client.eventHandler, data, type);
      };
    }
  }

  /**
   * Clear the session to force a fresh identify
   */
  private clearSession(): void {
    const state = (this.gateway as any).state;
    if (state) {
      state.sessionId = null;
      state.resumeGatewayUrl = null;
      state.sequence = null;
    }

    // Also clear sequence
    (this.gateway as any).sequence = null;
    (this.gateway as any).pings = [];

    // Reset the circuit breaker
    this.circuitBreaker.reset();

    this.logger.info(danger("Session cleared - will perform fresh identify on next connection"));
  }

  /**
   * Get the underlying gateway plugin
   */
  getGateway(): GatewayPlugin {
    return this.gateway;
  }

  /**
   * Get circuit breaker state for debugging
   */
  getCircuitBreakerState() {
    return this.circuitBreaker.getState();
  }
}
