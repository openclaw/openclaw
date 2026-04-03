import { useCallback } from "react";
import { useGateway } from "./use-gateway";

export function useRPC() {
  const { client } = useGateway();

  const rpc = useCallback(
    async <T = unknown>(
      method: string,
      params?: Record<string, unknown>,
    ): Promise<T> => {
      return client.rpc(method, params) as Promise<T>;
    },
    [client],
  );

  return rpc;
}
