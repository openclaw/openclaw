/**
 * Supabase Client Library for OpenClaw Workflow System
 * Simplified version with basic CRUD operations.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { logInfo, logWarn, logError } from "../../logger.js";

export interface SupabaseInstanceConfig {
  url: string;
  key: string;
  schema?: string;
}

export interface SupabaseResult<T = any> {
  success: boolean;
  data?: T;
  count?: number;
  error?: string;
  errorDetails?: any;
  timestamp: number;
}

export function createSupabaseClient(config: SupabaseInstanceConfig): any {
  return createClient(config.url, config.key);
}

export async function supabaseSelect(
  client: SupabaseClient,
  params: {
    table: string;
    columns?: string;
    filters?: Record<string, any>;
    limit?: number;
    orderBy?: { column: string; ascending?: boolean };
    schema?: string;
  },
): Promise<SupabaseResult<any[]>> {
  const startTime = Date.now();
  
  try {
    let query = client.from(params.table).select(params.columns ?? "*");
    
    if (params.schema) {
      query = (query as any).schema(params.schema);
    }
    
    // Apply filters
    if (params.filters) {
      for (const [field, condition] of Object.entries(params.filters)) {
        if (condition && typeof condition === "object") {
          if (condition.eq !== undefined) {query = query.eq(field, condition.eq);}
          if (condition.neq !== undefined) {query = query.neq(field, condition.neq);}
          if (condition.gt !== undefined) {query = query.gt(field, condition.gt);}
          if (condition.gte !== undefined) {query = query.gte(field, condition.gte);}
          if (condition.lt !== undefined) {query = query.lt(field, condition.lt);}
          if (condition.lte !== undefined) {query = query.lte(field, condition.lte);}
          if (condition.like !== undefined) {query = query.like(field, condition.like);}
          if (condition.ilike !== undefined) {query = query.ilike(field, condition.ilike);}
          if (condition.in !== undefined) {query = query.in(field, condition.in);}
        }
      }
    }
    
    // Apply ordering
    if (params.orderBy) {
      query = query.order(params.orderBy.column, { ascending: params.orderBy.ascending ?? true });
    }
    
    // Apply limit
    if (params.limit) {
      query = query.limit(params.limit);
    }
    
    const { data, error, count } = await query;
    
    if (error) {
      logWarn(`[supabase] SELECT error: ${error.message}`);
      return {
        success: false,
        error: error.message,
        errorDetails: error,
        timestamp: startTime,
      };
    }
    
    logInfo(`[supabase] SELECT ${params.table}: ${(data ?? []).length} row(s)`);
    return {
      success: true,
      data: data ?? [],
      count: count ?? (data ?? []).length,
      timestamp: startTime,
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logError(`[supabase] SELECT failed: ${errorMessage}`);
    return {
      success: false,
      error: errorMessage,
      timestamp: startTime,
    };
  }
}

export async function supabaseInsert(
  client: SupabaseClient,
  params: {
    table: string;
    data: Record<string, any> | Record<string, any>[];
    schema?: string;
  },
): Promise<SupabaseResult> {
  const startTime = Date.now();
  
  try {
    if (!params.data || (Array.isArray(params.data) && params.data.length === 0)) {
      throw new Error("Insert data cannot be empty");
    }
    
    let query = client.from(params.table).insert(params.data);
    
    if (params.schema) {
      query = (query as any).schema(params.schema);
    }
    
    const { data, error } = await query.select();
    
    if (error) {
      logWarn(`[supabase] INSERT error: ${error.message}`);
      return {
        success: false,
        error: error.message,
        errorDetails: error,
        timestamp: startTime,
      };
    }
    
    const result = Array.isArray(data) ? data[0] : data;
    logInfo(`[supabase] INSERT ${params.table}: 1 row(s)`);
    return {
      success: true,
      data: result,
      count: 1,
      timestamp: startTime,
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logError(`[supabase] INSERT failed: ${errorMessage}`);
    return {
      success: false,
      error: errorMessage,
      timestamp: startTime,
    };
  }
}

export async function supabaseUpdate(
  client: SupabaseClient,
  params: {
    table: string;
    data: Record<string, any>;
    filters: Record<string, any>;
    schema?: string;
  },
): Promise<SupabaseResult<any[]>> {
  const startTime = Date.now();
  
  try {
    if (!params.data || Object.keys(params.data).length === 0) {
      throw new Error("Update data cannot be empty");
    }
    
    if (!params.filters || Object.keys(params.filters).length === 0) {
      throw new Error("Update filters cannot be empty");
    }
    
    let query = client.from(params.table).update(params.data);
    
    if (params.schema) {
      query = (query as any).schema(params.schema);
    }
    
    // Apply filters
    for (const [field, condition] of Object.entries(params.filters)) {
      if (condition && typeof condition === "object") {
        if (condition.eq !== undefined) {query = query.eq(field, condition.eq);}
        if (condition.neq !== undefined) {query = query.neq(field, condition.neq);}
        if (condition.gt !== undefined) {query = query.gt(field, condition.gt);}
        if (condition.gte !== undefined) {query = query.gte(field, condition.gte);}
        if (condition.lt !== undefined) {query = query.lt(field, condition.lt);}
        if (condition.lte !== undefined) {query = query.lte(field, condition.lte);}
      } else {
        query = query.eq(field, condition);
      }
    }
    
    const { data, error, count } = await query.select();
    
    if (error) {
      logWarn(`[supabase] UPDATE error: ${error.message}`);
      return {
        success: false,
        error: error.message,
        errorDetails: error,
        timestamp: startTime,
      };
    }
    
    logInfo(`[supabase] UPDATE ${params.table}: ${count ?? 0} row(s)`);
    return {
      success: true,
      data: data ?? [],
      count: count ?? 0,
      timestamp: startTime,
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logError(`[supabase] UPDATE failed: ${errorMessage}`);
    return {
      success: false,
      error: errorMessage,
      timestamp: startTime,
    };
  }
}

export async function supabaseDelete(
  client: SupabaseClient,
  params: {
    table: string;
    filters: Record<string, any>;
    schema?: string;
  },
): Promise<SupabaseResult<any[]>> {
  const startTime = Date.now();
  
  try {
    if (!params.filters || Object.keys(params.filters).length === 0) {
      throw new Error("Delete filters cannot be empty");
    }
    
    let query = client.from(params.table).delete();
    
    if (params.schema) {
      query = (query as any).schema(params.schema);
    }
    
    // Apply filters
    for (const [field, condition] of Object.entries(params.filters)) {
      if (condition && typeof condition === "object") {
        if (condition.eq !== undefined) {query = query.eq(field, condition.eq);}
        if (condition.neq !== undefined) {query = query.neq(field, condition.neq);}
        if (condition.gt !== undefined) {query = query.gt(field, condition.gt);}
        if (condition.gte !== undefined) {query = query.gte(field, condition.gte);}
        if (condition.lt !== undefined) {query = query.lt(field, condition.lt);}
        if (condition.lte !== undefined) {query = query.lte(field, condition.lte);}
      } else {
        query = query.eq(field, condition);
      }
    }
    
    const { data, error, count } = await query.select();
    
    if (error) {
      logWarn(`[supabase] DELETE error: ${error.message}`);
      return {
        success: false,
        error: error.message,
        errorDetails: error,
        timestamp: startTime,
      };
    }
    
    logInfo(`[supabase] DELETE from ${params.table}: ${count ?? 0} row(s)`);
    return {
      success: true,
      data: data ?? [],
      count: count ?? 0,
      timestamp: startTime,
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logError(`[supabase] DELETE failed: ${errorMessage}`);
    return {
      success: false,
      error: errorMessage,
      timestamp: startTime,
    };
  }
}

export async function supabaseRpc(
  client: SupabaseClient,
  params: {
    function: string;
    params?: Record<string, any>;
  },
): Promise<SupabaseResult> {
  const startTime = Date.now();
  
  try {
    const { data, error } = await client.rpc(params.function, params.params ?? {});
    
    if (error) {
      logWarn(`[supabase] RPC error: ${error.message}`);
      return {
        success: false,
        error: error.message,
        errorDetails: error,
        timestamp: startTime,
      };
    }
    
    logInfo(`[supabase] RPC ${params.function}: success`);
    return {
      success: true,
      data: data,
      timestamp: startTime,
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logError(`[supabase] RPC failed: ${errorMessage}`);
    return {
      success: false,
      error: errorMessage,
      timestamp: startTime,
    };
  }
}
