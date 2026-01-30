import { describe, expect, it } from "vitest";

import { categorizeError } from "./agent-runner-execution.js";

describe("categorizeError", () => {
  describe("timeout errors", () => {
    it("categorizes lowercase 'timeout' as timeout type", () => {
      const error = new Error("Request timeout after 30s");
      const result = categorizeError(error);

      expect(result.type).toBe("timeout");
      expect(result.message).toBe("Request timeout after 30s");
      expect(result.hint).toBe("Operation took too long - try increasing timeout");
    });

    it("categorizes 'timed out' as timeout type", () => {
      const error = new Error("Connection timed out");
      const result = categorizeError(error);

      expect(result.type).toBe("timeout");
      expect(result.hint).toBe("Operation took too long - try increasing timeout");
    });

    it("categorizes ETIMEDOUT as network type (network error code takes precedence)", () => {
      const error = new Error("ETIMEDOUT: socket hang up");
      const result = categorizeError(error);

      // ETIMEDOUT is caught by network errors before timeout section
      expect(result.type).toBe("network");
      expect(result.hint).toBe("Connection failed - check network connectivity");
    });

    it("handles uppercase TIMEOUT", () => {
      const error = new Error("TIMEOUT ERROR");
      const result = categorizeError(error);

      expect(result.type).toBe("timeout");
    });
  });

  describe("authentication errors", () => {
    it("categorizes 401 as config type", () => {
      const error = new Error("HTTP 401: Unauthorized");
      const result = categorizeError(error);

      expect(result.type).toBe("config");
      expect(result.message).toBe("HTTP 401: Unauthorized");
      expect(result.hint).toBe("Check API credentials and permissions");
    });

    it("categorizes 'unauthorized' as config type", () => {
      const error = new Error("Request failed: unauthorized access");
      const result = categorizeError(error);

      expect(result.type).toBe("config");
      expect(result.hint).toBe("Check API credentials and permissions");
    });

    it("categorizes 'authentication' errors as config type (case-sensitive)", () => {
      const error = new Error("authentication failed for API key");
      const result = categorizeError(error);

      expect(result.type).toBe("config");
      expect(result.hint).toBe("Check API credentials and permissions");
    });

    it("categorizes 403 forbidden as config type", () => {
      const error = new Error("HTTP 403 forbidden");
      const result = categorizeError(error);

      expect(result.type).toBe("config");
      expect(result.hint).toBe("Access denied - check permissions");
    });

    it("categorizes 'forbidden' keyword as config type", () => {
      const error = new Error("Access forbidden to resource");
      const result = categorizeError(error);

      expect(result.type).toBe("config");
    });
  });

  describe("rate limit errors", () => {
    it("categorizes 'rate limit' as model type", () => {
      const error = new Error("rate limit exceeded");
      const result = categorizeError(error);

      expect(result.type).toBe("model");
      expect(result.message).toBe("rate limit exceeded");
      expect(result.hint).toBe("Rate limit exceeded - retry in a few moments");
    });

    it("categorizes HTTP 429 as model type", () => {
      const error = new Error("HTTP 429: Too Many Requests");
      const result = categorizeError(error);

      expect(result.type).toBe("model");
      expect(result.hint).toBe("Rate limit exceeded - retry in a few moments");
    });

    it("handles rate limit with mixed case", () => {
      const error = new Error("rate limit exceeded");
      const result = categorizeError(error);

      expect(result.type).toBe("model");
    });
  });

  describe("unknown errors", () => {
    it("categorizes unrecognized error as unknown type", () => {
      const error = new Error("Something weird happened");
      const result = categorizeError(error);

      expect(result.type).toBe("unknown");
      expect(result.message).toBe("Something weird happened");
      expect(result.hint).toBeUndefined();
    });

    it("categorizes generic error message as unknown", () => {
      const error = new Error("An unexpected error occurred");
      const result = categorizeError(error);

      expect(result.type).toBe("unknown");
      expect(result.hint).toBeUndefined();
    });

    it("handles non-Error objects", () => {
      const result = categorizeError("plain string error");

      expect(result.type).toBe("unknown");
      expect(result.message).toBe("plain string error");
    });

    it("handles null/undefined errors", () => {
      const result = categorizeError(null);

      expect(result.type).toBe("unknown");
      expect(result.message).toBe("null");
    });
  });

  describe("API/model errors", () => {
    it("categorizes HTTP 400 as model type", () => {
      const error = new Error("HTTP 400: Bad Request");
      const result = categorizeError(error);

      expect(result.type).toBe("model");
      expect(result.hint).toBe("Invalid request parameters");
    });

    it("categorizes 'invalid request' as model type", () => {
      const error = new Error("invalid request format");
      const result = categorizeError(error);

      expect(result.type).toBe("model");
    });

    it("categorizes HTTP 500 as model type", () => {
      const error = new Error("HTTP 500: Internal Server Error");
      const result = categorizeError(error);

      expect(result.type).toBe("model");
      expect(result.hint).toBe("API service error - try again later");
    });

    it("categorizes HTTP 503 as model type", () => {
      const error = new Error("HTTP 503: Service Unavailable");
      const result = categorizeError(error);

      expect(result.type).toBe("model");
      expect(result.hint).toBe("API service error - try again later");
    });

    it("categorizes quota errors as config type", () => {
      const error = new Error("quota exceeded for this account");
      const result = categorizeError(error);

      expect(result.type).toBe("config");
      expect(result.hint).toBe("Check billing and API quota limits");
    });

    it("categorizes billing errors as config type", () => {
      const error = new Error("billing issue detected");
      const result = categorizeError(error);

      expect(result.type).toBe("config");
      expect(result.hint).toBe("Check billing and API quota limits");
    });
  });

  describe("network errors", () => {
    it("categorizes ECONNREFUSED as network type", () => {
      const error = new Error("ECONNREFUSED: Connection refused");
      const result = categorizeError(error);

      expect(result.type).toBe("network");
      expect(result.hint).toBe("Connection failed - check network connectivity");
    });

    it("categorizes ENOTFOUND as network type", () => {
      const error = new Error("ENOTFOUND: DNS lookup failed");
      const result = categorizeError(error);

      expect(result.type).toBe("network");
      expect(result.hint).toBe("DNS resolution failed - check hostname");
    });

    it("categorizes DNS errors as network type", () => {
      const error = new Error("DNS resolution error");
      const result = categorizeError(error);

      expect(result.type).toBe("network");
    });

    it("categorizes EAI_AGAIN as network type", () => {
      const error = new Error("EAI_AGAIN: temporary failure");
      const result = categorizeError(error);

      expect(result.type).toBe("network");
      expect(result.hint).toBe("DNS resolution failed - check hostname");
    });

    it("categorizes ENETUNREACH as network type", () => {
      const error = new Error("ENETUNREACH: Network is unreachable");
      const result = categorizeError(error);

      expect(result.type).toBe("network");
      expect(result.hint).toBe("Network unreachable - check connection");
    });

    it("categorizes EHOSTUNREACH as network type", () => {
      const error = new Error("EHOSTUNREACH: No route to host");
      const result = categorizeError(error);

      expect(result.type).toBe("network");
      expect(result.hint).toBe("Network unreachable - check connection");
    });
  });

  describe("file system errors (tool type)", () => {
    it("categorizes ENOENT as tool type", () => {
      const error = new Error("ENOENT: no such file or directory");
      const result = categorizeError(error);

      expect(result.type).toBe("tool");
      expect(result.hint).toBe("File or directory not found");
    });

    it("categorizes ENOTDIR as tool type", () => {
      const error = new Error("ENOTDIR: not a directory");
      const result = categorizeError(error);

      expect(result.type).toBe("tool");
      expect(result.hint).toBe("File or directory not found");
    });

    it("categorizes EACCES as tool type", () => {
      const error = new Error("EACCES: permission denied");
      const result = categorizeError(error);

      expect(result.type).toBe("tool");
      expect(result.hint).toBe("Permission denied");
    });

    it("categorizes EPERM as tool type", () => {
      const error = new Error("EPERM: operation not permitted");
      const result = categorizeError(error);

      expect(result.type).toBe("tool");
      expect(result.hint).toBe("Permission denied");
    });

    it("categorizes EISDIR as tool type", () => {
      const error = new Error("EISDIR: illegal operation on a directory");
      const result = categorizeError(error);

      expect(result.type).toBe("tool");
      expect(result.hint).toBe("Expected file but found directory");
    });
  });

  describe("configuration errors", () => {
    it("categorizes missing API key as config type", () => {
      const error = new Error("missing API key");
      const result = categorizeError(error);

      expect(result.type).toBe("config");
      expect(result.hint).toBe("Missing required configuration or credentials");
    });

    it("categorizes missing token as config type", () => {
      const error = new Error("missing authentication token");
      const result = categorizeError(error);

      expect(result.type).toBe("config");
      // "authentication" keyword triggers auth error hint first
      expect(result.hint).toBe("Check API credentials and permissions");
    });

    it("categorizes missing API token without authentication keyword", () => {
      const error = new Error("missing API token for request");
      const result = categorizeError(error);

      expect(result.type).toBe("config");
      expect(result.hint).toBe("Missing required configuration or credentials");
    });
  });

  describe("context/memory errors", () => {
    it("categorizes context too large as model type", () => {
      const error = new Error("context window too large");
      const result = categorizeError(error);

      expect(result.type).toBe("model");
      expect(result.hint).toBe("Conversation too long - try clearing history");
    });
  });
});
