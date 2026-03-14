/**
 * Supabase Client Tests
 * 
 * Tests for the Supabase client library.
 * Note: These are unit tests that don't require a real Supabase instance.
 * Integration tests should be run separately with a real Supabase instance.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  createSupabaseClient,
  supabaseSelect,
  supabaseInsert,
  supabaseUpdate,
  supabaseDelete,
  supabaseRpc,
  validateTableName,
  validateFunctionName,
} from "./client.js";

// Mock the Supabase client
vi.mock("@supabase/supabase-js", () => {
  return {
    createClient: vi.fn(() => ({
      from: vi.fn(() => ({
        select: vi.fn(() => ({
          order: vi.fn().mockReturnThis(),
          limit: vi.fn().mockReturnThis(),
          range: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          neq: vi.fn().mockReturnThis(),
          gt: vi.fn().mockReturnThis(),
          gte: vi.fn().mockReturnThis(),
          lt: vi.fn().mockReturnThis(),
          lte: vi.fn().mockReturnThis(),
          like: vi.fn().mockReturnThis(),
          ilike: vi.fn().mockReturnThis(),
          in: vi.fn().mockReturnThis(),
          is: vi.fn().mockReturnThis(),
          contains: vi.fn().mockReturnThis(),
          containedBy: vi.fn().mockReturnThis(),
          then: vi.fn(),
        })),
        insert: vi.fn(() => ({
          upsert: vi.fn().mockReturnThis(),
          then: vi.fn(),
        })),
        update: vi.fn(() => ({
          eq: vi.fn().mockReturnThis(),
          then: vi.fn(),
        })),
        delete: vi.fn(() => ({
          eq: vi.fn().mockReturnThis(),
          then: vi.fn(),
        })),
      })),
      rpc: vi.fn(() => ({
        then: vi.fn(),
      })),
    })),
  };
});

describe("Supabase Client", () => {
  describe("createSupabaseClient", () => {
    it("should create a client with valid config", () => {
      const config = {
        url: "https://test.supabase.co",
        key: "test-key",
        schema: "public",
      };

      expect(() => createSupabaseClient(config)).not.toThrow();
    });

    it("should throw error with missing URL", () => {
      const config = {
        url: "",
        key: "test-key",
      };

      expect(() => createSupabaseClient(config as any)).toThrow("Supabase config requires both 'url' and 'key'");
    });

    it("should throw error with missing key", () => {
      const config = {
        url: "https://test.supabase.co",
        key: "",
      };

      expect(() => createSupabaseClient(config as any)).toThrow("Supabase config requires both 'url' and 'key'");
    });

    it("should throw error with invalid URL format", () => {
      const config = {
        url: "not-a-valid-url",
        key: "test-key",
      };

      expect(() => createSupabaseClient(config)).toThrow("Invalid Supabase URL format");
    });
  });

  describe("validateTableName", () => {
    it("should accept valid table names", () => {
      expect(() => validateTableName("users")).not.toThrow();
      expect(() => validateTableName("user_profiles")).not.toThrow();
      expect(() => validateTableName("test123")).not.toThrow();
      expect(() => validateTableName("_private")).not.toThrow();
    });

    it("should reject invalid table names", () => {
      expect(() => validateTableName("")).toThrow();
      expect(() => validateTableName("123invalid")).toThrow();
      expect(() => validateTableName("users; DROP TABLE")).toThrow();
      expect(() => validateTableName("users--comment")).toThrow();
      expect(() => validateTableName("table name")).toThrow();
    });
  });

  describe("validateFunctionName", () => {
    it("should accept valid function names", () => {
      expect(() => validateFunctionName("get_users")).not.toThrow();
      expect(() => validateFunctionName("calculateStats")).not.toThrow();
      expect(() => validateFunctionName("_private_func")).not.toThrow();
    });

    it("should reject invalid function names", () => {
      expect(() => validateFunctionName("")).toThrow();
      expect(() => validateFunctionName("123invalid")).toThrow();
      expect(() => validateFunctionName("func(); DROP")).toThrow();
    });
  });

  describe("supabaseSelect", () => {
    it("should execute select with valid params", async () => {
      const mockClient = {};
      const params = {
        table: "users",
        columns: "id,name,email",
        filters: { status: { eq: "active" } },
        limit: 100,
      };

      const result = await supabaseSelect(mockClient as any, params);
      
      expect(result.success).toBe(true);
      expect(result.timestamp).toBeDefined();
    });

    it("should handle missing table name", async () => {
      const mockClient = {};
      const params = {
        table: "",
      };

      const result = await supabaseSelect(mockClient as any, params as any);
      
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe("supabaseInsert", () => {
    it("should execute insert with valid params", async () => {
      const mockClient = {};
      const params = {
        table: "users",
        data: { name: "Test User", email: "test@example.com" },
      };

      const result = await supabaseInsert(mockClient as any, params);
      
      expect(result).toBeDefined();
    });

    it("should reject empty data", async () => {
      const mockClient = {};
      const params = {
        table: "users",
        data: {},
      };

      const result = await supabaseInsert(mockClient as any, params);
      
      expect(result.success).toBe(false);
      expect(result.error).toContain("empty");
    });
  });

  describe("supabaseUpdate", () => {
    it("should execute update with valid params", async () => {
      const mockClient = {};
      const params = {
        table: "users",
        data: { status: "active" },
        filters: { id: { eq: 1 } },
      };

      const result = await supabaseUpdate(mockClient as any, params);
      
      expect(result).toBeDefined();
    });

    it("should reject missing filters", async () => {
      const mockClient = {};
      const params = {
        table: "users",
        data: { status: "active" },
        filters: {},
      };

      const result = await supabaseUpdate(mockClient as any, params as any);
      
      expect(result.success).toBe(false);
      expect(result.error).toContain("filters");
    });
  });

  describe("supabaseDelete", () => {
    it("should execute delete with valid params", async () => {
      const mockClient = {};
      const params = {
        table: "users",
        filters: { id: { eq: 1 } },
      };

      const result = await supabaseDelete(mockClient as any, params);
      
      expect(result).toBeDefined();
    });

    it("should reject missing filters", async () => {
      const mockClient = {};
      const params = {
        table: "users",
        filters: {},
      };

      const result = await supabaseDelete(mockClient as any, params as any);
      
      expect(result.success).toBe(false);
      expect(result.error).toContain("filters");
    });
  });

  describe("supabaseRpc", () => {
    it("should execute RPC with valid params", async () => {
      const mockClient = {};
      const params = {
        functionName: "get_user_stats",
        args: { user_id: 123 },
      };

      const result = await supabaseRpc(mockClient as any, params);
      
      expect(result).toBeDefined();
    });

    it("should reject missing function name", async () => {
      const mockClient = {};
      const params = {
        functionName: "",
      };

      const result = await supabaseRpc(mockClient as any, params as any);
      
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });
});
