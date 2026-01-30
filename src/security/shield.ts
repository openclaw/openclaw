/**
 * Security shield coordinator
 * Main entry point for all security checks
 */

import type { IncomingMessage } from "node:http";
import { rateLimiter, RateLimitKeys, type RateLimitResult } from "./rate-limiter.js";
import { ipManager } from "./ip-manager.js";
import { intrusionDetector } from "./intrusion-detector.js";
import { securityLogger } from "./events/logger.js";
import { SecurityActions } from "./events/schema.js";
import type { SecurityShieldConfig } from "../config/types.security.js";
import { DEFAULT_SECURITY_CONFIG } from "../config/types.security.js";

export interface SecurityContext {
  ip: string;
  deviceId?: string;
  userId?: string;
  userAgent?: string;
  requestId?: string;
}

export interface SecurityCheckResult {
  allowed: boolean;
  reason?: string;
  rateLimitInfo?: RateLimitResult;
}

/**
 * Security shield - coordinates all security checks
 */
export class SecurityShield {
  private config: Required<SecurityShieldConfig>;

  constructor(config?: SecurityShieldConfig) {
    this.config = {
      enabled: config?.enabled ?? DEFAULT_SECURITY_CONFIG.shield.enabled,
      rateLimiting: config?.rateLimiting ?? DEFAULT_SECURITY_CONFIG.shield.rateLimiting,
      intrusionDetection:
        config?.intrusionDetection ?? DEFAULT_SECURITY_CONFIG.shield.intrusionDetection,
      ipManagement: config?.ipManagement ?? DEFAULT_SECURITY_CONFIG.shield.ipManagement,
    } as Required<SecurityShieldConfig>;
  }

  /**
   * Check if security shield is enabled
   */
  isEnabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Check if an IP is blocked
   */
  isIpBlocked(ip: string): boolean {
    if (!this.config.enabled) return false;
    return ipManager.isBlocked(ip) !== null;
  }

  /**
   * Check authentication attempt
   */
  checkAuthAttempt(ctx: SecurityContext): SecurityCheckResult {
    if (!this.config.enabled) {
      return { allowed: true };
    }

    const { ip } = ctx;

    // Check IP blocklist
    const blockReason = ipManager.isBlocked(ip);
    if (blockReason) {
      return {
        allowed: false,
        reason: `IP blocked: ${blockReason}`,
      };
    }

    // Rate limit per-IP
    if (this.config.rateLimiting?.enabled && this.config.rateLimiting.perIp?.authAttempts) {
      const limit = this.config.rateLimiting.perIp.authAttempts;
      const result = rateLimiter.check(RateLimitKeys.authAttempt(ip), limit);

      if (!result.allowed) {
        securityLogger.logRateLimit({
          action: SecurityActions.RATE_LIMIT_EXCEEDED,
          ip,
          outcome: "deny",
          severity: "warn",
          resource: "auth",
          details: {
            limit: limit.max,
            windowMs: limit.windowMs,
            retryAfterMs: result.retryAfterMs,
          },
          deviceId: ctx.deviceId,
          requestId: ctx.requestId,
        });

        return {
          allowed: false,
          reason: "Rate limit exceeded",
          rateLimitInfo: result,
        };
      }
    }

    // Rate limit per-device (if deviceId provided)
    if (
      ctx.deviceId &&
      this.config.rateLimiting?.enabled &&
      this.config.rateLimiting.perDevice?.authAttempts
    ) {
      const limit = this.config.rateLimiting.perDevice.authAttempts;
      const result = rateLimiter.check(RateLimitKeys.authAttemptDevice(ctx.deviceId), limit);

      if (!result.allowed) {
        securityLogger.logRateLimit({
          action: SecurityActions.RATE_LIMIT_EXCEEDED,
          ip,
          outcome: "deny",
          severity: "warn",
          resource: "auth",
          details: {
            limit: limit.max,
            windowMs: limit.windowMs,
            retryAfterMs: result.retryAfterMs,
          },
          deviceId: ctx.deviceId,
          requestId: ctx.requestId,
        });

        return {
          allowed: false,
          reason: "Rate limit exceeded (device)",
          rateLimitInfo: result,
        };
      }
    }

    return { allowed: true };
  }

  /**
   * Log failed authentication attempt
   * Triggers intrusion detection for brute force
   */
  logAuthFailure(ctx: SecurityContext, reason: string): void {
    if (!this.config.enabled) return;

    const { ip } = ctx;

    // Log the failure
    securityLogger.logAuth({
      action: SecurityActions.AUTH_FAILED,
      ip,
      outcome: "deny",
      severity: "warn",
      resource: "gateway_auth",
      details: { reason },
      deviceId: ctx.deviceId,
      userId: ctx.userId,
      userAgent: ctx.userAgent,
      requestId: ctx.requestId,
    });

    // Check for brute force pattern
    if (this.config.intrusionDetection?.enabled) {
      const event = {
        timestamp: new Date().toISOString(),
        eventId: "",
        severity: "warn" as const,
        category: "authentication" as const,
        ip,
        action: SecurityActions.AUTH_FAILED,
        resource: "gateway_auth",
        outcome: "deny" as const,
        details: { reason },
      };

      intrusionDetector.checkBruteForce({ ip, event });
    }
  }

  /**
   * Check connection rate limit
   */
  checkConnection(ctx: SecurityContext): SecurityCheckResult {
    if (!this.config.enabled) {
      return { allowed: true };
    }

    const { ip } = ctx;

    // Check IP blocklist
    const blockReason = ipManager.isBlocked(ip);
    if (blockReason) {
      return {
        allowed: false,
        reason: `IP blocked: ${blockReason}`,
      };
    }

    // Rate limit connections
    if (this.config.rateLimiting?.enabled && this.config.rateLimiting.perIp?.connections) {
      const limit = this.config.rateLimiting.perIp.connections;
      const result = rateLimiter.check(RateLimitKeys.connection(ip), limit);

      if (!result.allowed) {
        securityLogger.logRateLimit({
          action: SecurityActions.CONNECTION_LIMIT_EXCEEDED,
          ip,
          outcome: "deny",
          severity: "warn",
          resource: "gateway_connection",
          details: {
            limit: limit.max,
            windowMs: limit.windowMs,
          },
          requestId: ctx.requestId,
        });

        // Check for port scanning
        if (this.config.intrusionDetection?.enabled) {
          const event = {
            timestamp: new Date().toISOString(),
            eventId: "",
            severity: "warn" as const,
            category: "network_access" as const,
            ip,
            action: SecurityActions.CONNECTION_LIMIT_EXCEEDED,
            resource: "gateway_connection",
            outcome: "deny" as const,
            details: {},
          };

          intrusionDetector.checkPortScanning({ ip, event });
        }

        return {
          allowed: false,
          reason: "Connection rate limit exceeded",
          rateLimitInfo: result,
        };
      }
    }

    return { allowed: true };
  }

  /**
   * Check request rate limit
   */
  checkRequest(ctx: SecurityContext): SecurityCheckResult {
    if (!this.config.enabled) {
      return { allowed: true };
    }

    const { ip } = ctx;

    // Check IP blocklist
    const blockReason = ipManager.isBlocked(ip);
    if (blockReason) {
      return {
        allowed: false,
        reason: `IP blocked: ${blockReason}`,
      };
    }

    // Rate limit requests
    if (this.config.rateLimiting?.enabled && this.config.rateLimiting.perIp?.requests) {
      const limit = this.config.rateLimiting.perIp.requests;
      const result = rateLimiter.check(RateLimitKeys.request(ip), limit);

      if (!result.allowed) {
        securityLogger.logRateLimit({
          action: SecurityActions.RATE_LIMIT_EXCEEDED,
          ip,
          outcome: "deny",
          severity: "warn",
          resource: "gateway_request",
          details: {
            limit: limit.max,
            windowMs: limit.windowMs,
          },
          requestId: ctx.requestId,
        });

        return {
          allowed: false,
          reason: "Request rate limit exceeded",
          rateLimitInfo: result,
        };
      }
    }

    return { allowed: true };
  }

  /**
   * Check pairing request rate limit
   */
  checkPairingRequest(params: {
    channel: string;
    sender: string;
    ip: string;
  }): SecurityCheckResult {
    if (!this.config.enabled) {
      return { allowed: true };
    }

    const { channel, sender, ip } = params;

    // Check IP blocklist
    const blockReason = ipManager.isBlocked(ip);
    if (blockReason) {
      return {
        allowed: false,
        reason: `IP blocked: ${blockReason}`,
      };
    }

    // Rate limit pairing requests
    if (this.config.rateLimiting?.enabled && this.config.rateLimiting.perSender?.pairingRequests) {
      const limit = this.config.rateLimiting.perSender.pairingRequests;
      const result = rateLimiter.check(RateLimitKeys.pairingRequest(channel, sender), limit);

      if (!result.allowed) {
        securityLogger.logPairing({
          action: SecurityActions.PAIRING_RATE_LIMIT,
          ip,
          outcome: "deny",
          severity: "warn",
          details: {
            channel,
            sender,
            limit: limit.max,
            windowMs: limit.windowMs,
          },
        });

        return {
          allowed: false,
          reason: "Pairing rate limit exceeded",
          rateLimitInfo: result,
        };
      }
    }

    return { allowed: true };
  }

  /**
   * Check webhook rate limit
   */
  checkWebhook(params: { token: string; path: string; ip: string }): SecurityCheckResult {
    if (!this.config.enabled) {
      return { allowed: true };
    }

    const { token, path, ip } = params;

    // Check IP blocklist
    const blockReason = ipManager.isBlocked(ip);
    if (blockReason) {
      return {
        allowed: false,
        reason: `IP blocked: ${blockReason}`,
      };
    }

    // Rate limit per token
    if (this.config.rateLimiting?.enabled && this.config.rateLimiting.webhook?.perToken) {
      const limit = this.config.rateLimiting.webhook.perToken;
      const result = rateLimiter.check(RateLimitKeys.webhookToken(token), limit);

      if (!result.allowed) {
        securityLogger.logRateLimit({
          action: SecurityActions.RATE_LIMIT_EXCEEDED,
          ip,
          outcome: "deny",
          severity: "warn",
          resource: `webhook:${path}`,
          details: {
            token: `${token.substring(0, 8)}...`,
            limit: limit.max,
            windowMs: limit.windowMs,
          },
        });

        return {
          allowed: false,
          reason: "Webhook rate limit exceeded (token)",
          rateLimitInfo: result,
        };
      }
    }

    // Rate limit per path
    if (this.config.rateLimiting?.enabled && this.config.rateLimiting.webhook?.perPath) {
      const limit = this.config.rateLimiting.webhook.perPath;
      const result = rateLimiter.check(RateLimitKeys.webhookPath(path), limit);

      if (!result.allowed) {
        securityLogger.logRateLimit({
          action: SecurityActions.RATE_LIMIT_EXCEEDED,
          ip,
          outcome: "deny",
          severity: "warn",
          resource: `webhook:${path}`,
          details: {
            limit: limit.max,
            windowMs: limit.windowMs,
          },
        });

        return {
          allowed: false,
          reason: "Webhook rate limit exceeded (path)",
          rateLimitInfo: result,
        };
      }
    }

    return { allowed: true };
  }

  /**
   * Extract IP from request
   */
  static extractIp(req: IncomingMessage): string {
    // Try X-Forwarded-For first (if behind proxy)
    const forwarded = req.headers["x-forwarded-for"];
    if (forwarded) {
      // Handle both string and array cases (array can come from some proxies)
      const forwardedStr = Array.isArray(forwarded) ? forwarded[0] : forwarded;
      const ips = typeof forwardedStr === "string" ? forwardedStr.split(",") : [];
      const clientIp = ips[0]?.trim();
      if (clientIp) return clientIp;
    }

    // Try X-Real-IP
    const realIp = req.headers["x-real-ip"];
    if (realIp && typeof realIp === "string") {
      return realIp.trim();
    }

    // Fall back to socket remote address
    return req.socket?.remoteAddress ?? "unknown";
  }
}

/**
 * Singleton security shield instance
 */
export let securityShield: SecurityShield;

/**
 * Initialize security shield with config
 */
export function initSecurityShield(config?: SecurityShieldConfig): void {
  securityShield = new SecurityShield(config);
}

/**
 * Get security shield instance (creates default if not initialized)
 */
export function getSecurityShield(): SecurityShield {
  if (!securityShield) {
    securityShield = new SecurityShield();
  }
  return securityShield;
}
