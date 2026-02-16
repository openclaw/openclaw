import type { IncomingMessage, ServerResponse } from "node:http";
import http from "node:http";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  securityHeaders,
  rateLimiter,
  validateInput,
  requireAuth,
  jsonBodyParser,
  chain,
  webhookSecurity,
  apiSecurity,
  CsrfProtection,
  body,
} from "../../src/plugins/http-security-middleware.js";

/**
 * HTTP Security Middleware Test Suite
 *
 * Tests security controls for plugin HTTP endpoints:
 * - Security headers (helmet)
 * - Rate limiting
 * - Input validation
 * - CSRF protection
 * - Authentication
 */

describe("HTTP Security Middleware", () => {
  let server: http.Server | null = null;
  const TEST_PORT = 9876;
  const BASE_URL = `http://localhost:${TEST_PORT}`;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => {
        server!.close(() => resolve());
      });
      server = null;
    }
  });

  const makeRequest = async (
    path: string,
    options: {
      method?: string;
      headers?: Record<string, string>;
      body?: string;
    } = {},
  ): Promise<{
    statusCode: number;
    headers: Record<string, string | string[] | undefined>;
    body: string;
  }> => {
    return new Promise((resolve, reject) => {
      const req = http.request(
        `${BASE_URL}${path}`,
        {
          method: options.method || "GET",
          headers: options.headers || {},
        },
        (res) => {
          let body = "";
          res.on("data", (chunk) => (body += chunk));
          res.on("end", () => {
            resolve({
              statusCode: res.statusCode || 500,
              headers: res.headers as Record<string, string | string[] | undefined>,
              body,
            });
          });
        },
      );

      req.on("error", reject);

      if (options.body) {
        req.write(options.body);
      }

      req.end();
    });
  };

  describe("Security Headers", () => {
    it("should set security headers", async () => {
      server = http.createServer((req, res) => {
        const middleware = securityHeaders();
        middleware(req, res, () => {
          res.statusCode = 200;
          res.end("OK");
        });
      });

      await new Promise<void>((resolve) => {
        server!.listen(TEST_PORT, resolve);
      });

      const response = await makeRequest("/");

      expect(response.statusCode).toBe(200);
      expect(response.headers["x-content-type-options"]).toBe("nosniff");
      expect(response.headers["x-frame-options"]).toBe("DENY");
      expect(response.headers["strict-transport-security"]).toContain("max-age=31536000");
    });

    it("should set CSP headers", async () => {
      server = http.createServer((req, res) => {
        const middleware = securityHeaders();
        middleware(req, res, () => {
          res.statusCode = 200;
          res.end("OK");
        });
      });

      await new Promise<void>((resolve) => {
        server!.listen(TEST_PORT, resolve);
      });

      const response = await makeRequest("/");

      expect(response.headers["content-security-policy"]).toBeDefined();
      expect(response.headers["content-security-policy"]).toContain("default-src 'self'");
    });
  });

  describe("Rate Limiting", () => {
    it("should allow requests under limit", async () => {
      server = http.createServer((req, res) => {
        const middleware = rateLimiter({ windowMs: 60000, max: 5 });
        middleware(req, res, () => {
          res.statusCode = 200;
          res.end("OK");
        });
      });

      await new Promise<void>((resolve) => {
        server!.listen(TEST_PORT, resolve);
      });

      // Make 3 requests - should all succeed
      for (let i = 0; i < 3; i++) {
        const response = await makeRequest("/");
        expect(response.statusCode).toBe(200);
      }
    });

    it("should block requests over limit", async () => {
      server = http.createServer((req, res) => {
        const middleware = rateLimiter({ windowMs: 60000, max: 3 });
        middleware(req, res, () => {
          res.statusCode = 200;
          res.end("OK");
        });
      });

      await new Promise<void>((resolve) => {
        server!.listen(TEST_PORT, resolve);
      });

      // Make 4 requests - 4th should be rate limited
      const responses = [];
      for (let i = 0; i < 4; i++) {
        responses.push(await makeRequest("/"));
      }

      expect(responses[0].statusCode).toBe(200);
      expect(responses[1].statusCode).toBe(200);
      expect(responses[2].statusCode).toBe(200);
      expect(responses[3].statusCode).toBe(429);
    });

    it("should include rate limit headers", async () => {
      server = http.createServer((req, res) => {
        const middleware = rateLimiter({ windowMs: 60000, max: 10 });
        middleware(req, res, () => {
          res.statusCode = 200;
          res.end("OK");
        });
      });

      await new Promise<void>((resolve) => {
        server!.listen(TEST_PORT, resolve);
      });

      const response = await makeRequest("/");

      expect(response.headers["ratelimit-limit"]).toBeDefined();
      expect(response.headers["ratelimit-remaining"]).toBeDefined();
    });
  });

  describe("Input Validation", () => {
    it("should accept valid input", async () => {
      server = http.createServer((req, res) => {
        const middleware = chain(
          jsonBodyParser(),
          validateInput([body("email").isEmail(), body("name").isString().notEmpty()]),
        );

        middleware(req, res, () => {
          res.statusCode = 200;
          res.end("OK");
        });
      });

      await new Promise<void>((resolve) => {
        server!.listen(TEST_PORT, resolve);
      });

      const response = await makeRequest("/", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ email: "test@example.com", name: "Test User" }),
      });

      expect(response.statusCode).toBe(200);
    });

    it("should reject invalid input", async () => {
      server = http.createServer((req, res) => {
        const middleware = chain(
          jsonBodyParser(),
          validateInput([body("email").isEmail(), body("name").isString().notEmpty()]),
        );

        middleware(req, res, () => {
          res.statusCode = 200;
          res.end("OK");
        });
      });

      await new Promise<void>((resolve) => {
        server!.listen(TEST_PORT, resolve);
      });

      const response = await makeRequest("/", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ email: "invalid-email", name: "" }),
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.error).toBe("Validation failed");
      expect(body.details).toBeDefined();
    });
  });

  describe("Authentication", () => {
    it("should allow authenticated requests", async () => {
      server = http.createServer((req, res) => {
        const middleware = requireAuth({
          requireBearerToken: true,
          validTokens: ["test-token-123"],
        });

        middleware(req, res, () => {
          res.statusCode = 200;
          res.end("OK");
        });
      });

      await new Promise<void>((resolve) => {
        server!.listen(TEST_PORT, resolve);
      });

      const response = await makeRequest("/", {
        headers: {
          Authorization: "Bearer test-token-123",
        },
      });

      expect(response.statusCode).toBe(200);
    });

    it("should reject missing auth", async () => {
      server = http.createServer((req, res) => {
        const middleware = requireAuth({
          requireBearerToken: true,
          validTokens: ["test-token-123"],
        });

        middleware(req, res, () => {
          res.statusCode = 200;
          res.end("OK");
        });
      });

      await new Promise<void>((resolve) => {
        server!.listen(TEST_PORT, resolve);
      });

      const response = await makeRequest("/");

      expect(response.statusCode).toBe(401);
      expect(response.headers["www-authenticate"]).toBe("Bearer");
    });

    it("should reject invalid token", async () => {
      server = http.createServer((req, res) => {
        const middleware = requireAuth({
          requireBearerToken: true,
          validTokens: ["valid-token"],
        });

        middleware(req, res, () => {
          res.statusCode = 200;
          res.end("OK");
        });
      });

      await new Promise<void>((resolve) => {
        server!.listen(TEST_PORT, resolve);
      });

      const response = await makeRequest("/", {
        headers: {
          Authorization: "Bearer invalid-token",
        },
      });

      expect(response.statusCode).toBe(401);
    });
  });

  describe("CSRF Protection", () => {
    it("should allow GET requests without token", async () => {
      const csrf = new CsrfProtection();

      server = http.createServer((req, res) => {
        const middleware = csrf.middleware();
        middleware(req, res, () => {
          res.statusCode = 200;
          res.end("OK");
        });
      });

      await new Promise<void>((resolve) => {
        server!.listen(TEST_PORT, resolve);
      });

      const response = await makeRequest("/");

      expect(response.statusCode).toBe(200);
      expect(response.headers["set-cookie"]).toBeDefined();
    });

    it("should reject POST without CSRF token", async () => {
      const csrf = new CsrfProtection();

      server = http.createServer((req, res) => {
        const middleware = csrf.middleware();
        middleware(req, res, () => {
          res.statusCode = 200;
          res.end("OK");
        });
      });

      await new Promise<void>((resolve) => {
        server!.listen(TEST_PORT, resolve);
      });

      const response = await makeRequest("/", {
        method: "POST",
        body: "test",
      });

      expect(response.statusCode).toBe(403);
      const body = JSON.parse(response.body);
      expect(body.error).toBe("CSRF token missing");
    });

    it("should accept POST with valid CSRF token", async () => {
      const csrf = new CsrfProtection();
      const token = csrf.generateToken();

      server = http.createServer((req, res) => {
        const middleware = csrf.middleware();
        middleware(req, res, () => {
          res.statusCode = 200;
          res.end("OK");
        });
      });

      await new Promise<void>((resolve) => {
        server!.listen(TEST_PORT, resolve);
      });

      const response = await makeRequest("/", {
        method: "POST",
        headers: {
          Cookie: `__Host-openclaw-csrf=${token}`,
          "x-csrf-token": token,
        },
        body: "test",
      });

      expect(response.statusCode).toBe(200);
    });

    it("should reject POST with mismatched CSRF token", async () => {
      const csrf = new CsrfProtection();
      const cookieToken = csrf.generateToken();
      const headerToken = csrf.generateToken();

      server = http.createServer((req, res) => {
        const middleware = csrf.middleware();
        middleware(req, res, () => {
          res.statusCode = 200;
          res.end("OK");
        });
      });

      await new Promise<void>((resolve) => {
        server!.listen(TEST_PORT, resolve);
      });

      const response = await makeRequest("/", {
        method: "POST",
        headers: {
          Cookie: `__Host-openclaw-csrf=${cookieToken}`,
          "x-csrf-token": headerToken,
        },
        body: "test",
      });

      expect(response.statusCode).toBe(403);
    });
  });

  describe("Body Parser", () => {
    it("should parse JSON body", async () => {
      let parsedBody: any = null;

      server = http.createServer((req, res) => {
        const middleware = jsonBodyParser();
        middleware(req, res, () => {
          parsedBody = (req as any).body;
          res.statusCode = 200;
          res.end("OK");
        });
      });

      await new Promise<void>((resolve) => {
        server!.listen(TEST_PORT, resolve);
      });

      await makeRequest("/", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ test: "value" }),
      });

      expect(parsedBody).toEqual({ test: "value" });
    });

    it("should reject oversized payloads", async () => {
      server = http.createServer((req, res) => {
        const middleware = jsonBodyParser({ maxSize: 100 });
        middleware(req, res, () => {
          res.statusCode = 200;
          res.end("OK");
        });
      });

      await new Promise<void>((resolve) => {
        server!.listen(TEST_PORT, resolve);
      });

      const largeBody = "a".repeat(1000);
      const response = await makeRequest("/", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: largeBody,
      });

      expect(response.statusCode).toBe(413);
    });

    it("should reject invalid JSON", async () => {
      server = http.createServer((req, res) => {
        const middleware = jsonBodyParser();
        middleware(req, res, () => {
          res.statusCode = 200;
          res.end("OK");
        });
      });

      await new Promise<void>((resolve) => {
        server!.listen(TEST_PORT, resolve);
      });

      const response = await makeRequest("/", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: "{invalid json",
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe("Middleware Chaining", () => {
    it("should chain multiple middlewares", async () => {
      const executionOrder: string[] = [];

      const middleware1 = (req: IncomingMessage, res: ServerResponse, next: () => void) => {
        executionOrder.push("middleware1");
        next();
      };

      const middleware2 = (req: IncomingMessage, res: ServerResponse, next: () => void) => {
        executionOrder.push("middleware2");
        next();
      };

      const middleware3 = (req: IncomingMessage, res: ServerResponse, next: () => void) => {
        executionOrder.push("middleware3");
        next();
      };

      server = http.createServer((req, res) => {
        const chained = chain(middleware1, middleware2, middleware3);
        chained(req, res, () => {
          executionOrder.push("final");
          res.statusCode = 200;
          res.end("OK");
        });
      });

      await new Promise<void>((resolve) => {
        server!.listen(TEST_PORT, resolve);
      });

      await makeRequest("/");

      expect(executionOrder).toEqual(["middleware1", "middleware2", "middleware3", "final"]);
    });
  });

  describe("Preset Configurations", () => {
    it("should apply webhook security preset", async () => {
      server = http.createServer((req, res) => {
        const middleware = webhookSecurity();
        middleware(req, res, () => {
          res.statusCode = 200;
          res.end("OK");
        });
      });

      await new Promise<void>((resolve) => {
        server!.listen(TEST_PORT, resolve);
      });

      const response = await makeRequest("/");

      expect(response.statusCode).toBe(200);
      expect(response.headers["x-content-type-options"]).toBe("nosniff");
      expect(response.headers["ratelimit-limit"]).toBeDefined();
    });

    it("should apply API security preset", async () => {
      server = http.createServer((req, res) => {
        const middleware = apiSecurity({ csrf: false });
        middleware(req, res, () => {
          res.statusCode = 200;
          res.end("OK");
        });
      });

      await new Promise<void>((resolve) => {
        server!.listen(TEST_PORT, resolve);
      });

      const response = await makeRequest("/", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ test: "value" }),
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers["x-content-type-options"]).toBe("nosniff");
    });
  });
});
