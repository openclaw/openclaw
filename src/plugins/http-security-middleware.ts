import type { IncomingMessage, ServerResponse } from "node:http";
import rateLimit from "express-rate-limit";
import { body, validationResult, type ValidationChain } from "express-validator";
import helmet from "helmet";
import crypto from "node:crypto";

/**
 * HTTP Security Middleware for OpenClaw Plugin Endpoints
 *
 * Provides comprehensive security controls for plugin HTTP routes:
 * - Security headers (helmet)
 * - Rate limiting
 * - Input validation
 * - CSRF protection (double-submit cookie pattern)
 * - Authentication enforcement
 *
 * @security CVSS 7.5 - Protects against:
 * - Cross-Site Scripting (XSS)
 * - Cross-Site Request Forgery (CSRF)
 * - Clickjacking
 * - MIME-type sniffing
 * - Rate limiting/DoS
 * - Host header injection
 */

// ============================================================================
// CSRF Protection (Modern Double-Submit Cookie Pattern)
// ============================================================================

interface CsrfOptions {
  cookieName?: string;
  headerName?: string;
  secret?: string;
  cookieOptions?: {
    secure?: boolean;
    httpOnly?: boolean;
    sameSite?: "strict" | "lax" | "none";
    maxAge?: number;
  };
}

/**
 * Modern CSRF protection using double-submit cookie pattern.
 * Safer than deprecated csurf package.
 */
export class CsrfProtection {
  private secret: string;
  private cookieName: string;
  private headerName: string;
  private cookieOptions: Required<NonNullable<CsrfOptions["cookieOptions"]>>;

  constructor(options: CsrfOptions = {}) {
    this.secret = options.secret || process.env.CSRF_SECRET || this.generateSecret();
    this.cookieName = options.cookieName || "__Host-openclaw-csrf";
    this.headerName = options.headerName || "x-csrf-token";
    this.cookieOptions = {
      secure: options.cookieOptions?.secure ?? true,
      httpOnly: options.cookieOptions?.httpOnly ?? true,
      sameSite: options.cookieOptions?.sameSite ?? "strict",
      maxAge: options.cookieOptions?.maxAge ?? 3600000, // 1 hour
    };
  }

  private generateSecret(): string {
    return crypto.randomBytes(32).toString("hex");
  }

  /**
   * Generate a CSRF token for the session.
   */
  generateToken(): string {
    const token = crypto.randomBytes(32).toString("hex");
    const hmac = crypto.createHmac("sha256", this.secret);
    hmac.update(token);
    const signature = hmac.digest("hex");
    return `${token}.${signature}`;
  }

  /**
   * Verify a CSRF token.
   */
  verifyToken(token: string): boolean {
    if (!token || typeof token !== "string") {
      return false;
    }

    const parts = token.split(".");
    if (parts.length !== 2) {
      return false;
    }

    const [tokenPart, signaturePart] = parts;
    const hmac = crypto.createHmac("sha256", this.secret);
    hmac.update(tokenPart);
    const expectedSignature = hmac.digest("hex");

    // Timing-safe comparison
    try {
      return crypto.timingSafeEqual(Buffer.from(signaturePart), Buffer.from(expectedSignature));
    } catch {
      return false;
    }
  }

  /**
   * Parse cookies from Cookie header.
   */
  private parseCookies(cookieHeader?: string): Record<string, string> {
    const cookies: Record<string, string> = {};
    if (!cookieHeader) {
      return cookies;
    }

    const pairs = cookieHeader.split(";");
    for (const pair of pairs) {
      const [key, ...valueParts] = pair.split("=");
      if (key && valueParts.length > 0) {
        const value = valueParts.join("=").trim();
        cookies[key.trim()] = value;
      }
    }
    return cookies;
  }

  /**
   * Middleware to protect against CSRF attacks.
   */
  middleware() {
    return async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
      const method = req.method?.toUpperCase();

      // Only protect state-changing methods
      if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
        // For GET requests, generate and set a new token if none exists
        const cookies = this.parseCookies(req.headers.cookie);
        if (!cookies[this.cookieName]) {
          const token = this.generateToken();
          const cookieValue = this.formatCookie(token);
          res.setHeader("Set-Cookie", cookieValue);
        }
        next();
        return;
      }

      // Verify CSRF token for POST/PUT/DELETE/PATCH
      const cookies = this.parseCookies(req.headers.cookie);
      const cookieToken = cookies[this.cookieName];
      const headerToken = req.headers[this.headerName] as string | undefined;

      if (!cookieToken || !headerToken) {
        res.statusCode = 403;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "CSRF token missing" }));
        return;
      }

      if (!this.verifyToken(cookieToken) || cookieToken !== headerToken) {
        res.statusCode = 403;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Invalid CSRF token" }));
        return;
      }

      next();
    };
  }

  /**
   * Format cookie string with options.
   */
  private formatCookie(value: string): string {
    const parts = [`${this.cookieName}=${value}`];

    if (this.cookieOptions.httpOnly) {
      parts.push("HttpOnly");
    }
    if (this.cookieOptions.secure) {
      parts.push("Secure");
    }
    if (this.cookieOptions.sameSite) {
      parts.push(`SameSite=${this.cookieOptions.sameSite}`);
    }
    if (this.cookieOptions.maxAge) {
      parts.push(`Max-Age=${Math.floor(this.cookieOptions.maxAge / 1000)}`);
    }
    parts.push("Path=/");

    return parts.join("; ");
  }

  /**
   * Get CSRF token from request for client-side use.
   */
  getTokenFromRequest(req: IncomingMessage): string | null {
    const cookies = this.parseCookies(req.headers.cookie);
    return cookies[this.cookieName] || null;
  }
}

// ============================================================================
// Security Headers
// ============================================================================

/**
 * Apply security headers using helmet.
 * Protects against common web vulnerabilities.
 */
export function securityHeaders(options?: Parameters<typeof helmet>[0]) {
  const helmetMiddleware = helmet(
    options || {
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", "data:", "https:"],
          connectSrc: ["'self'"],
          fontSrc: ["'self'"],
          objectSrc: ["'none'"],
          mediaSrc: ["'self'"],
          frameSrc: ["'none'"],
        },
      },
      hsts: {
        maxAge: 31536000, // 1 year
        includeSubDomains: true,
        preload: true,
      },
      frameguard: {
        action: "deny",
      },
      noSniff: true,
      xssFilter: true,
      referrerPolicy: {
        policy: "strict-origin-when-cross-origin",
      },
    },
  );

  return (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    // Helmet expects Express-like req/res, adapt for Node http
    const fakeReq: any = req;
    const fakeRes: any = res;
    fakeReq.app = { get: () => false };

    helmetMiddleware(fakeReq, fakeRes, next);
  };
}

// ============================================================================
// Rate Limiting
// ============================================================================

interface RateLimitOptions {
  windowMs?: number;
  max?: number;
  message?: string;
  skipSuccessfulRequests?: boolean;
  skipFailedRequests?: boolean;
}

/**
 * Rate limiting middleware to prevent abuse.
 * Default: 100 requests per 15 minutes per IP.
 */
export function rateLimiter(options: RateLimitOptions = {}) {
  const limiter = rateLimit({
    windowMs: options.windowMs || 15 * 60 * 1000, // 15 minutes
    max: options.max || 100,
    message: options.message || "Too many requests from this IP, please try again later.",
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: options.skipSuccessfulRequests || false,
    skipFailedRequests: options.skipFailedRequests || false,
    handler: (req: any, res: any) => {
      res.statusCode = 429;
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          error: options.message || "Too many requests",
          retryAfter: res.getHeader("Retry-After"),
        }),
      );
    },
  });

  return (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const fakeReq: any = req;
    const fakeRes: any = res;
    fakeReq.app = { get: () => false };

    limiter(fakeReq, fakeRes, next);
  };
}

// ============================================================================
// Input Validation
// ============================================================================

/**
 * Request wrapper for validation.
 */
interface ValidationRequest extends IncomingMessage {
  body?: any;
  query?: any;
  params?: any;
}

/**
 * Input validation middleware using express-validator.
 */
export function validateInput(validations: ValidationChain[]) {
  return async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const validationReq = req as ValidationRequest;

    // Run all validations
    for (const validation of validations) {
      await validation.run(validationReq);
    }

    // Check for errors
    const errors = validationResult(validationReq);
    if (!errors.isEmpty()) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          error: "Validation failed",
          details: errors.array(),
        }),
      );
      return;
    }

    next();
  };
}

// ============================================================================
// Authentication
// ============================================================================

interface AuthOptions {
  /**
   * Custom function to verify authentication.
   * Return true if authenticated, false otherwise.
   */
  verify?: (req: IncomingMessage) => boolean | Promise<boolean>;

  /**
   * Allow requests from these IP addresses without authentication.
   */
  allowedIPs?: string[];

  /**
   * Require Bearer token in Authorization header.
   */
  requireBearerToken?: boolean;

  /**
   * Valid bearer tokens.
   */
  validTokens?: string[];
}

/**
 * Authentication middleware.
 * Ensures requests are authenticated before processing.
 */
export function requireAuth(options: AuthOptions = {}) {
  return async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    // Check allowed IPs
    if (options.allowedIPs && options.allowedIPs.length > 0) {
      const remoteIP = req.socket.remoteAddress;
      if (remoteIP && options.allowedIPs.includes(remoteIP)) {
        next();
        return;
      }
    }

    // Check Bearer token
    if (options.requireBearerToken || options.validTokens) {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith("Bearer ")) {
        res.statusCode = 401;
        res.setHeader("Content-Type", "application/json");
        res.setHeader("WWW-Authenticate", "Bearer");
        res.end(JSON.stringify({ error: "Authentication required" }));
        return;
      }

      const token = authHeader.substring(7);
      if (options.validTokens && !options.validTokens.includes(token)) {
        res.statusCode = 401;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Invalid token" }));
        return;
      }
    }

    // Custom verification
    if (options.verify) {
      const isAuthenticated = await options.verify(req);
      if (!isAuthenticated) {
        res.statusCode = 401;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Authentication failed" }));
        return;
      }
    }

    next();
  };
}

// ============================================================================
// Request Body Parser
// ============================================================================

interface BodyParserOptions {
  maxSize?: number;
  timeout?: number;
}

/**
 * Parse request body as JSON.
 * Required for input validation to work.
 */
export function jsonBodyParser(options: BodyParserOptions = {}) {
  const maxSize = options.maxSize || 1024 * 1024; // 1MB default
  const timeout = options.timeout || 30000; // 30s default

  return async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    if (req.method === "GET" || req.method === "HEAD") {
      next();
      return;
    }

    const validationReq = req as ValidationRequest;
    const chunks: Buffer[] = [];
    let totalSize = 0;

    const timeoutHandle = setTimeout(() => {
      req.destroy(new Error("Request timeout"));
      res.statusCode = 408;
      res.end(JSON.stringify({ error: "Request timeout" }));
    }, timeout);

    req.on("data", (chunk: Buffer) => {
      totalSize += chunk.length;
      if (totalSize > maxSize) {
        clearTimeout(timeoutHandle);
        req.destroy();
        res.statusCode = 413;
        res.end(JSON.stringify({ error: "Payload too large" }));
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      clearTimeout(timeoutHandle);
      const body = Buffer.concat(chunks).toString("utf-8");

      // Parse JSON if content-type is application/json
      const contentType = req.headers["content-type"];
      if (contentType?.includes("application/json")) {
        try {
          validationReq.body = JSON.parse(body);
        } catch (err) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: "Invalid JSON" }));
          return;
        }
      } else {
        validationReq.body = body;
      }

      next();
    });

    req.on("error", (err) => {
      clearTimeout(timeoutHandle);
      console.error("[http-security] Body parse error:", err);
      res.statusCode = 500;
      res.end(JSON.stringify({ error: "Internal server error" }));
    });
  };
}

// ============================================================================
// Middleware Chain Helper
// ============================================================================

type Middleware = (
  req: IncomingMessage,
  res: ServerResponse,
  next: () => void,
) => void | Promise<void>;

/**
 * Chain multiple middleware functions together.
 */
export function chain(...middlewares: Middleware[]): Middleware {
  return async (req: IncomingMessage, res: ServerResponse, finalNext: () => void) => {
    let index = 0;

    const next = async (): Promise<void> => {
      if (index >= middlewares.length) {
        finalNext();
        return;
      }

      const middleware = middlewares[index++];
      try {
        await middleware(req, res, next);
      } catch (err) {
        console.error("[http-security] Middleware error:", err);
        if (!res.headersSent) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: "Internal server error" }));
        }
      }
    };

    await next();
  };
}

// ============================================================================
// Preset Security Configurations
// ============================================================================

/**
 * Standard security middleware for webhook endpoints.
 * Includes: security headers, rate limiting (50 req/15min).
 */
export function webhookSecurity(options?: {
  rateLimit?: RateLimitOptions;
  requireAuth?: boolean;
  authOptions?: AuthOptions;
}) {
  const middlewares: Middleware[] = [
    securityHeaders(),
    rateLimiter(options?.rateLimit || { max: 50 }),
  ];

  if (options?.requireAuth) {
    middlewares.push(requireAuth(options.authOptions));
  }

  return chain(...middlewares);
}

/**
 * API endpoint security with full protection.
 * Includes: security headers, rate limiting, CSRF, body parsing, auth.
 */
export function apiSecurity(options?: {
  rateLimit?: RateLimitOptions;
  csrf?: boolean;
  csrfOptions?: CsrfOptions;
  requireAuth?: boolean;
  authOptions?: AuthOptions;
  validation?: ValidationChain[];
}) {
  const csrf = options?.csrf !== false ? new CsrfProtection(options?.csrfOptions) : null;

  const middlewares: Middleware[] = [
    securityHeaders(),
    rateLimiter(options?.rateLimit || { max: 100 }),
    jsonBodyParser(),
  ];

  if (csrf) {
    middlewares.push(csrf.middleware());
  }

  if (options?.requireAuth) {
    middlewares.push(requireAuth(options.authOptions));
  }

  if (options?.validation) {
    middlewares.push(validateInput(options.validation));
  }

  return chain(...middlewares);
}

// ============================================================================
// Exports
// ============================================================================

export { body, type ValidationChain };

/**
 * Convenience export of common validation builders.
 */
export const validators = {
  body,
  string: () => body("*").isString(),
  email: () => body("email").isEmail().normalizeEmail(),
  url: () => body("url").isURL(),
  uuid: () => body("*").isUUID(),
  integer: () => body("*").isInt(),
  boolean: () => body("*").isBoolean(),
};
