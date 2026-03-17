/**
 * Supabase Client Tests
 *
 * Tests for the Supabase client library.
 * Note: These are unit tests that don't require a real Supabase instance.
 * Integration tests should be run separately with a real Supabase instance.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, it, expect, vi } from "vitest";
import {
  createSupabaseClient,
  supabaseSelect,
  supabaseInsert,
  supabaseUpdate,
  supabaseDelete,
  supabaseRpc,
  type SupabaseInstanceConfig,
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
        })),
        insert: vi.fn(() => ({
          upsert: vi.fn().mockReturnThis(),
        })),
        update: vi.fn(() => ({
          eq: vi.fn().mockReturnThis(),
        })),
        delete: vi.fn(() => ({
          eq: vi.fn().mockReturnThis(),
        })),
      })),
      rpc: vi.fn(() => ({})),
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
      const config: SupabaseInstanceConfig = {
        url: "",
        key: "test-key",
      };

      expect(() => createSupabaseClient(config)).toThrow(
        "Supabase config requires both 'url' and 'key'",
      );
    });

    it("should throw error with missing key", () => {
      const config = {
        url: "https://test.supabase.co",
        key: "",
      };

      expect(() => createSupabaseClient(config as SupabaseInstanceConfig)).toThrow(
        "Supabase config requires both 'url' and 'key'",
      );
    });

    it("should throw error with invalid URL format", () => {
      const config: SupabaseInstanceConfig = {
        url: "not-a-valid-url",
        key: "test-key",
      };

      expect(() => createSupabaseClient(config)).toThrow("Invalid Supabase URL format");
    });
  });

  describe("supabaseSelect", () => {
    it("should execute select with valid params", async () => {
      const mockClient = {} as SupabaseClient;
      const params = {
        table: "users",
        columns: "id,name,email",
        filters: { status: { eq: "active" } },
        limit: 100,
      };

      const result = await supabaseSelect(mockClient, params);

      expect(result.success).toBe(true);
      expect(result.timestamp).toBeDefined();
    });

    it("should handle missing table name", async () => {
      const mockClient = {} as SupabaseClient;
      const params = {
        table: "",
      };

      const result = await supabaseSelect(mockClient, params as never);

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe("supabaseInsert", () => {
    it("should execute insert with valid params", async () => {
      const mockClient = {} as SupabaseClient;
      const params = {
        table: "users",
        data: { name: "Test User", email: "test@example.com" },
      };

      const result = await supabaseInsert(mockClient, params);

      expect(result).toBeDefined();
    });

    it("should reject empty data", async () => {
      const mockClient = {} as SupabaseClient;
      const params = {
        table: "users",
        data: {},
      };

      const result = await supabaseInsert(mockClient, params);

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe("supabaseUpdate", () => {
    it("should execute update with valid params", async () => {
      const mockClient = {} as SupabaseClient;
      const params = {
        table: "users",
        data: { status: "active" },
        filters: { id: { eq: 1 } },
      };

      const result = await supabaseUpdate(mockClient, params);

      expect(result).toBeDefined();
    });

    it("should reject missing filters", async () => {
      const mockClient = {} as SupabaseClient;
      const params = {
        table: "users",
        data: { status: "active" },
        filters: {},
      };

      const result = await supabaseUpdate(mockClient, params as never);

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe("supabaseDelete", () => {
    it("should execute delete with valid params", async () => {
      const mockClient = {} as SupabaseClient;
      const params = {
        table: "users",
        filters: { id: { eq: 1 } },
      };

      const result = await supabaseDelete(mockClient, params);

      expect(result).toBeDefined();
    });

    it("should reject missing filters", async () => {
      const mockClient = {} as SupabaseClient;
      const params = {
        table: "users",
        filters: {},
      };

      const result = await supabaseDelete(mockClient, params as never);

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe("supabaseRpc", () => {
    it("should execute RPC with valid params", async () => {
      const mockClient = {} as SupabaseClient;
      const params = {
        function: "get_user_stats",
        params: { user_id: 123 },
      };

      const result = await supabaseRpc(mockClient, params);

      expect(result).toBeDefined();
    });

    it("should reject missing function name", async () => {
      const mockClient = {} as SupabaseClient;
      const params = {
        function: "",
      };

      const result = await supabaseRpc(mockClient, params as never);

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });
});
