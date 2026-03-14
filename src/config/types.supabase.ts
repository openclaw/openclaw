/**
 * Supabase configuration types for OpenClaw.
 */

import type { SecretInput } from "./types.secrets.js";

/**
 * Supabase instance configuration.
 */
export interface SupabaseInstanceConfig {
  /** Supabase project URL */
  url: string;
  /** Supabase API key (service role for backend) */
  key: SecretInput;
  /** Optional schema name (default: "public") */
  schema?: string;
}

/**
 * Supabase configuration container.
 */
export interface SupabaseConfig {
  /** Named Supabase instances */
  instances: Record<string, SupabaseInstanceConfig>;
  /** Default instance name to use when not specified */
  defaultInstance?: string;
}

/**
 * Supabase workflow step configuration.
 */
export interface SupabaseWorkflowStep {
  /** Action type */
  actionType: 'supabase-select' | 'supabase-insert' | 'supabase-update' | 'supabase-delete' | 'supabase-rpc';
  /** Instance name (uses default if not specified) */
  instance?: string;
  /** Table name (for CRUD operations) */
  table?: string;
  /** Columns to select (default: "*") */
  columns?: string;
  /** Filter conditions */
  filters?: Record<string, unknown>;
  /** Order by configuration */
  orderBy?: {
    column: string;
    ascending?: boolean;
  };
  /** Limit results */
  limit?: number;
  /** Offset for pagination */
  offset?: number;
  /** Data to insert/update */
  data?: Record<string, unknown> | Record<string, unknown>[];
  /** Return mode */
  returning?: 'representation' | 'minimal';
  /** Upsert on conflict */
  upsert?: boolean;
  /** Conflict column for upsert */
  onConflict?: string;
  /** Function name (for RPC) */
  functionName?: string;
  /** Function arguments (for RPC) */
  args?: Record<string, unknown>;
}
