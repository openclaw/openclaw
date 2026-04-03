import { createContext, useContext } from "react";
import { GatewayClient } from "@/gateway/client";
import { useGatewayStore } from "@/stores/gateway";

const GatewayContext = createContext<GatewayClient | null>(null);

export { GatewayContext };

export function useGateway() {
  const client = useContext(GatewayContext);
  if (!client)
    throw new Error("useGateway must be used within GatewayProvider");
  const status = useGatewayStore((s) => s.status);
  const health = useGatewayStore((s) => s.health);
  const error = useGatewayStore((s) => s.error);
  return { client, status, health, error };
}
