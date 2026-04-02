import { useState, useEffect, useCallback } from "react";
import { useGateway } from "./use-gateway";

interface RPCQueryOptions {
  enabled?: boolean;
  refetchInterval?: number;
}

interface RPCQueryResult<T> {
  data: T | null;
  isLoading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
}

export function useRPCQuery<T = unknown>(
  method: string,
  params?: Record<string, unknown>,
  options: RPCQueryOptions = {},
): RPCQueryResult<T> {
  const { client, status } = useGateway();
  const { enabled = true, refetchInterval } = options;
  const [data, setData] = useState<T | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const fetch = useCallback(async () => {
    if (status !== "connected" || !enabled) return;
    try {
      setIsLoading(true);
      const result = await client.rpc(method, params);
      setData(result as T);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)));
    } finally {
      setIsLoading(false);
    }
  }, [client, method, JSON.stringify(params), status, enabled]);

  useEffect(() => {
    fetch();
  }, [fetch]);

  useEffect(() => {
    if (!refetchInterval || !enabled) return;
    const interval = setInterval(fetch, refetchInterval);
    return () => clearInterval(interval);
  }, [fetch, refetchInterval, enabled]);

  return { data, isLoading, error, refetch: fetch };
}
