import { describe, it, expect, beforeEach } from "vitest";
import {
  pushOperation,
  popOperation,
  getCurrentOperation,
  clearOperationStack,
  addBreadcrumb,
  sanitizeError,
  createContextualError,
  formatContextualError,
  sanitizeContextualErrorForSlack,
  runInContext,
  runInContextAsync,
} from "./error-context.js";

describe("ErrorContext", () => {
  beforeEach(() => {
    clearOperationStack();
  });

  describe("operation stack", () => {
    it("should manage operation contexts", () => {
      runInContext(() => {
        expect(getCurrentOperation()).toBeUndefined();

        pushOperation({ operation: "test-op", sessionKey: "sess-123" });
        expect(getCurrentOperation()?.operation).toBe("test-op");

        pushOperation({ operation: "nested-op" });
        expect(getCurrentOperation()?.operation).toBe("nested-op");

        popOperation();
        expect(getCurrentOperation()?.operation).toBe("test-op");

        popOperation();
        expect(getCurrentOperation()).toBeUndefined();
      });
    });

    it("should clear operation stack", () => {
      runInContext(() => {
        pushOperation({ operation: "op1" });
        pushOperation({ operation: "op2" });
        clearOperationStack();

        expect(getCurrentOperation()).toBeUndefined();
      });
    });

    it("should track breadcrumbs", () => {
      runInContext(() => {
        pushOperation({ operation: "test" });
        addBreadcrumb("step 1");
        addBreadcrumb("step 2");

        const ctx = getCurrentOperation();
        expect(ctx?.breadcrumbs).toHaveLength(2);
        expect(ctx?.breadcrumbs?.[0]).toContain("step 1");
        expect(ctx?.breadcrumbs?.[1]).toContain("step 2");
      });
    });
  });

  describe("context isolation (AsyncLocalStorage)", () => {
    it("should isolate contexts between concurrent sessions", async () => {
      const results: string[] = [];

      await Promise.all([
        runInContextAsync(async () => {
          pushOperation({ operation: "session-A", sessionKey: "key-A" });
          await new Promise((r) => setTimeout(r, 10)); // Simulate async work
          results.push(`A:${getCurrentOperation()?.operation}`);
          addBreadcrumb("A completed");
          results.push(`A-crumbs:${getCurrentOperation()?.breadcrumbs?.length}`);
        }),
        runInContextAsync(async () => {
          pushOperation({ operation: "session-B", sessionKey: "key-B" });
          await new Promise((r) => setTimeout(r, 5)); // Finishes before A
          results.push(`B:${getCurrentOperation()?.operation}`);
          addBreadcrumb("B completed");
          results.push(`B-crumbs:${getCurrentOperation()?.breadcrumbs?.length}`);
        }),
      ]);

      // Each session should see only its own operation
      expect(results).toContain("A:session-A");
      expect(results).toContain("B:session-B");
      // Each session should have exactly 1 breadcrumb (its own)
      expect(results).toContain("A-crumbs:1");
      expect(results).toContain("B-crumbs:1");
    });

    it("should maintain separate stacks in nested contexts", () => {
      runInContext(() => {
        pushOperation({ operation: "outer" });

        runInContext(() => {
          // Inner context starts fresh
          expect(getCurrentOperation()).toBeUndefined();
          pushOperation({ operation: "inner" });
          expect(getCurrentOperation()?.operation).toBe("inner");
        });

        // Outer context is unchanged
        expect(getCurrentOperation()?.operation).toBe("outer");
      });
    });
  });

  describe("sanitizeError", () => {
    it("should return non-Error objects as strings without marking sanitized", () => {
      const result = sanitizeError("simple string");
      expect(result.message).toBe("simple string");
      // No actual sanitization happened, so sanitized should be false
      expect(result.sanitized).toBe(false);
    });

    it("should redact file paths to sensitive files", () => {
      const err = new Error("Config loaded from /home/user/.openclawrc");
      const result = sanitizeError(err);

      expect(result.message).toContain("[REDACTED]");
      expect(result.sanitized).toBe(true);
    });

    it("should redact .env file paths", () => {
      const err = new Error("Error reading /app/.env.production");
      const result = sanitizeError(err);

      expect(result.message).toContain("[REDACTED]");
      expect(result.sanitized).toBe(true);
    });

    it("should redact OpenAI-style API keys", () => {
      const err = new Error("Invalid key: sk-abc123def456ghi789jklmnopqrst");
      const result = sanitizeError(err);

      expect(result.message).not.toContain("sk-abc");
      expect(result.message).toContain("[REDACTED]");
      expect(result.sanitized).toBe(true);
    });

    it("should redact GitHub tokens", () => {
      const err = new Error("Auth failed with ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij");
      const result = sanitizeError(err);

      expect(result.message).not.toContain("ghp_");
      expect(result.sanitized).toBe(true);
    });

    it("should redact Slack tokens", () => {
      const err = new Error("Slack error: xoxb-123456789-abcdefghij");
      const result = sanitizeError(err);

      expect(result.message).not.toContain("xoxb-");
      expect(result.sanitized).toBe(true);
    });

    it("should redact JWTs", () => {
      const jwt =
        "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
      const err = new Error(`Token expired: ${jwt}`);
      const result = sanitizeError(err);

      expect(result.message).not.toContain("eyJ");
      expect(result.sanitized).toBe(true);
    });

    it("should redact URLs with secret query params", () => {
      const err = new Error("Failed at https://api.example.com?token=secret123");
      const result = sanitizeError(err);

      expect(result.message).toContain("[REDACTED]");
      expect(result.message).not.toContain("secret123");
      expect(result.sanitized).toBe(true);
    });

    it("should redact password assignments", () => {
      const err = new Error('Connection failed: password="super_secret_123"');
      const result = sanitizeError(err);

      expect(result.message).not.toContain("super_secret");
      expect(result.sanitized).toBe(true);
    });

    it("should NOT redact UUIDs (not secrets)", () => {
      const err = new Error("Session: 550e8400-e29b-41d4-a716-446655440000");
      const result = sanitizeError(err);

      expect(result.message).toBe("Session: 550e8400-e29b-41d4-a716-446655440000");
      expect(result.sanitized).toBe(false);
    });

    it("should NOT redact commit hashes (not secrets)", () => {
      const err = new Error("Deployed from commit abc123def456789012345678901234567890abcd");
      const result = sanitizeError(err);

      // Commit hash should remain intact
      expect(result.message).toContain("abc123def456789012345678901234567890abcd");
      expect(result.sanitized).toBe(false);
    });

    it("should NOT redact session identifiers (not secrets)", () => {
      const err = new Error("Session ID: agent:main:subagent:54d3d43a-596a");
      const result = sanitizeError(err);

      expect(result.message).toBe("Session ID: agent:main:subagent:54d3d43a-596a");
      expect(result.sanitized).toBe(false);
    });

    it("should not modify clean errors", () => {
      const err = new Error("Something went wrong");
      const result = sanitizeError(err);

      expect(result.message).toBe("Something went wrong");
      expect(result.sanitized).toBe(false);
    });
  });

  describe("createContextualError", () => {
    it("should create error with context", () => {
      const err = createContextualError("test error", {
        code: "TEST_ERROR",
        context: { sessionKey: "sess-123", operation: "test" },
      });

      expect(err.message).toBe("test error");
      expect(err.code).toBe("TEST_ERROR");
      expect(err.context.sessionKey).toBe("sess-123");
      expect(err.context.operation).toBe("test");
    });

    it("should inherit context from operation stack", () => {
      runInContext(() => {
        pushOperation({ sessionKey: "sess-456", operation: "stack-op" });
        addBreadcrumb("test breadcrumb");

        const err = createContextualError("inherited error");

        expect(err.context.sessionKey).toBe("sess-456");
        expect(err.context.operation).toBe("stack-op");
        expect(err.context.breadcrumbs).toHaveLength(1);
      });
    });

    it("should preserve original error", () => {
      const original = new Error("original");
      const err = createContextualError("wrapper", { originalError: original });

      expect(err.originalError).toBe(original);
    });
  });

  describe("formatContextualError", () => {
    it("should format error with all context", () => {
      const err = createContextualError("test message", {
        code: "CODE",
        context: {
          sessionKey: "sess-abc123def456",
          operation: "my-operation",
        },
      });

      const formatted = formatContextualError(err);

      expect(formatted).toContain("[sess-ab");
      expect(formatted).toContain("{my-operation}");
      expect(formatted).toContain("ERR_CODE");
      expect(formatted).toContain("test message");
    });

    it("should include breadcrumbs in formatted output", () => {
      runInContext(() => {
        pushOperation({ operation: "test" });
        addBreadcrumb("step 1");
        addBreadcrumb("step 2");

        const err = createContextualError("error with crumbs");
        const formatted = formatContextualError(err);

        expect(formatted).toContain("Breadcrumbs:");
        expect(formatted).toContain("step 1");
        expect(formatted).toContain("step 2");
      });
    });
  });

  describe("sanitizeContextualErrorForSlack", () => {
    it("should sanitize error message with secrets", () => {
      const err = createContextualError("Token: sk-abcdef1234567890abcdef1234567890");
      const sanitized = sanitizeContextualErrorForSlack(err);

      expect(sanitized.message).not.toContain("sk-abcdef");
      expect(sanitized.sanitized).toBe(true);
    });

    it("should NOT mark sanitized=true when no secrets present", () => {
      const err = createContextualError("normal error message", {
        context: { sessionKey: "sess-123" },
      });
      const sanitized = sanitizeContextualErrorForSlack(err);

      expect(sanitized.message).toBe("normal error message");
      expect(sanitized.sanitized).toBe(false);
    });

    it("should sanitize breadcrumbs with secrets", () => {
      runInContext(() => {
        pushOperation({ operation: "test" });
        addBreadcrumb("Auth failed at https://api.example.com?token=secret");

        const err = createContextualError("error");
        const sanitized = sanitizeContextualErrorForSlack(err);

        expect(sanitized.context.breadcrumbs?.[0]).toContain("[REDACTED]");
        expect(sanitized.sanitized).toBe(true);
      });
    });

    it("should preserve non-sensitive content", () => {
      const err = createContextualError("normal error message", {
        context: { sessionKey: "sess-123" },
      });
      const sanitized = sanitizeContextualErrorForSlack(err);

      expect(sanitized.message).toBe("normal error message");
      expect(sanitized.context.sessionKey).toBe("sess-123");
    });
  });
});
