import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { ResolvedCortexConfig, ResolvedMemoryBackendConfig } from "./backend-config.js";
import { CortexMemoryManager } from "./cortex-manager.js";

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe("CortexMemoryManager", () => {
  const mockConfig: OpenClawConfig = {};

  const mockCortexConfig: ResolvedCortexConfig = {
    serviceUrl: "http://localhost:8085",
    tenant: "test-tenant",
    timeoutMs: 30000,
    maxResults: 10,
    minScore: 0.4,
    scope: "session",
    autoCreateSession: true,
    autoExtract: true,
  };

  const mockResolvedConfig: ResolvedMemoryBackendConfig = {
    backend: "cortex",
    citations: "auto",
    cortex: mockCortexConfig,
  };

  beforeEach(() => {
    mockFetch.mockReset();
    // Mock health check
    mockFetch.mockImplementation(async (url: string) => {
      if (url.endsWith("/health")) {
        return {
          ok: true,
          json: async () => ({ status: "ok" }),
        };
      }
      return {
        ok: true,
        json: async () => ({}),
      };
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("create", () => {
    it("should create a manager with valid config", async () => {
      const manager = await CortexMemoryManager.create({
        cfg: mockConfig,
        agentId: "test-agent",
        resolved: mockResolvedConfig,
      });

      expect(manager).not.toBeNull();
      expect(manager?.status().backend).toBe("cortex");
      expect(manager?.status().provider).toBe("cortex-mem-service");
    });

    it("should return null when cortex config is missing", async () => {
      const manager = await CortexMemoryManager.create({
        cfg: mockConfig,
        agentId: "test-agent",
        resolved: { backend: "cortex", citations: "auto" },
      });

      expect(manager).toBeNull();
    });
  });

  describe("search", () => {
    it("should perform semantic search", async () => {
      const mockResults = [
        {
          uri: "cortex://session/test-thread/timeline/2024/01/15/test.md",
          score: 0.95,
          snippet: "This is a test memory snippet",
        },
      ];

      mockFetch.mockImplementation(async (url: string, options: any) => {
        if (url.endsWith("/api/v2/search")) {
          return {
            ok: true,
            json: async () => ({ results: mockResults, total: 1 }),
          };
        }
        if (url.endsWith("/health")) {
          return {
            ok: true,
            json: async () => ({ status: "ok" }),
          };
        }
        return { ok: true, json: async () => ({}) };
      });

      const manager = await CortexMemoryManager.create({
        cfg: mockConfig,
        agentId: "test-agent",
        resolved: mockResolvedConfig,
      });

      const results = await manager!.search("test query");

      expect(results).toHaveLength(1);
      expect(results[0].score).toBe(0.95);
      expect(results[0].snippet).toBe("This is a test memory snippet");
    });

    it("should use custom maxResults and minScore", async () => {
      mockFetch.mockImplementation(async (url: string, options: any) => {
        if (url.endsWith("/api/v2/search")) {
          const body = JSON.parse(options.body);
          expect(body.limit).toBe(5);
          expect(body.min_score).toBe(0.7);
          return {
            ok: true,
            json: async () => ({ results: [], total: 0 }),
          };
        }
        if (url.endsWith("/health")) {
          return {
            ok: true,
            json: async () => ({ status: "ok" }),
          };
        }
        return { ok: true, json: async () => ({}) };
      });

      const manager = await CortexMemoryManager.create({
        cfg: mockConfig,
        agentId: "test-agent",
        resolved: mockResolvedConfig,
      });

      await manager!.search("test query", { maxResults: 5, minScore: 0.7 });
    });
  });

  describe("readFile", () => {
    it("should read file content by URI", async () => {
      const mockContent = "# Test Memory\n\nThis is the content of the memory file.";

      mockFetch.mockImplementation(async (url: string) => {
        if (url.includes("/api/v2/filesystem/read/")) {
          return {
            ok: true,
            json: async () => ({
              content: mockContent,
              uri: "cortex://session/test/timeline/test.md",
            }),
          };
        }
        if (url.endsWith("/health")) {
          return {
            ok: true,
            json: async () => ({ status: "ok" }),
          };
        }
        return { ok: true, json: async () => ({}) };
      });

      const manager = await CortexMemoryManager.create({
        cfg: mockConfig,
        agentId: "test-agent",
        resolved: mockResolvedConfig,
      });

      const result = await manager!.readFile({
        relPath: "cortex://session/test/timeline/test.md",
      });

      expect(result.text).toBe(mockContent);
      expect(result.path).toBe("cortex://session/test/timeline/test.md");
    });
  });

  describe("status", () => {
    it("should return correct status", async () => {
      const manager = await CortexMemoryManager.create({
        cfg: mockConfig,
        agentId: "test-agent",
        resolved: mockResolvedConfig,
      });

      const status = manager!.status();

      expect(status.backend).toBe("cortex");
      expect(status.provider).toBe("cortex-mem-service");
      expect(status.custom?.tenant).toBe("test-tenant");
      expect(status.custom?.scope).toBe("session");
      expect(status.vector?.enabled).toBe(true);
    });
  });

  describe("probeEmbeddingAvailability", () => {
    it("should return ok when healthy", async () => {
      const manager = await CortexMemoryManager.create({
        cfg: mockConfig,
        agentId: "test-agent",
        resolved: mockResolvedConfig,
      });

      const result = await manager!.probeEmbeddingAvailability();

      expect(result.ok).toBe(true);
    });

    it("should return error when unhealthy", async () => {
      mockFetch.mockImplementation(async () => ({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
        text: async () => "Server error",
      }));

      const manager = await CortexMemoryManager.create({
        cfg: mockConfig,
        agentId: "test-agent",
        resolved: mockResolvedConfig,
      });

      const result = await manager!.probeEmbeddingAvailability();

      expect(result.ok).toBe(false);
      expect(result.error).toContain("not available");
    });
  });

  describe("session management", () => {
    it("should create a session", async () => {
      mockFetch.mockImplementation(async (url: string, options: any) => {
        if (url.endsWith("/api/v2/sessions")) {
          return { ok: true, json: async () => ({}) };
        }
        if (url.endsWith("/health")) {
          return {
            ok: true,
            json: async () => ({ status: "ok" }),
          };
        }
        return { ok: true, json: async () => ({}) };
      });

      const manager = await CortexMemoryManager.create({
        cfg: mockConfig,
        agentId: "test-agent",
        resolved: mockResolvedConfig,
      });

      await manager!.createSession("test-thread", "Test Session");

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:8085/api/v2/sessions",
        expect.objectContaining({
          method: "POST",
        }),
      );
    });

    it("should add a message to a session", async () => {
      mockFetch.mockImplementation(async (url: string, options: any) => {
        if (url.includes("/messages")) {
          return {
            ok: true,
            json: async () => ({ uri: "cortex://session/test/test.md" }),
          };
        }
        if (url.endsWith("/api/v2/sessions") && options?.method === "POST") {
          return { ok: true, json: async () => ({}) };
        }
        if (url.endsWith("/health")) {
          return {
            ok: true,
            json: async () => ({ status: "ok" }),
          };
        }
        return { ok: true, json: async () => ({}) };
      });

      const manager = await CortexMemoryManager.create({
        cfg: mockConfig,
        agentId: "test-agent",
        resolved: mockResolvedConfig,
      });

      const uri = await manager!.addMessage("test-thread", "user", "Hello world");

      expect(uri).toBe("cortex://session/test/test.md");
    });

    it("should close a session", async () => {
      mockFetch.mockImplementation(async (url: string) => {
        if (url.includes("/close")) {
          return { ok: true, json: async () => ({}) };
        }
        if (url.endsWith("/health")) {
          return {
            ok: true,
            json: async () => ({ status: "ok" }),
          };
        }
        return { ok: true, json: async () => ({}) };
      });

      const manager = await CortexMemoryManager.create({
        cfg: mockConfig,
        agentId: "test-agent",
        resolved: mockResolvedConfig,
      });

      await manager!.closeSession("test-thread");

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/close"),
        expect.objectContaining({
          method: "POST",
        }),
      );
    });
  });
});
