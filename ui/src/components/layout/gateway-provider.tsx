import { useEffect, useRef, type ReactNode } from "react";
import { GatewayClient } from "@/gateway/client";
import { getOrCreateDeviceIdentity } from "@/gateway/device-identity";
import { GatewayContext } from "@/hooks/use-gateway";
import { useGatewayStore } from "@/stores/gateway";
import { useSessionsStore, type Session } from "@/stores/sessions";

interface GatewayProviderProps {
  children: ReactNode;
}

export function GatewayProvider({ children }: GatewayProviderProps) {
  const clientRef = useRef<GatewayClient | null>(null);
  const { setStatus, setConfig, hydrateSnapshot } = useGatewayStore();
  const { setSessions } = useSessionsStore();

  if (!clientRef.current) {
    clientRef.current = new GatewayClient();
  }

  const client = clientRef.current;

  useEffect(() => {
    client.onStatusChange = setStatus;
    client.onSnapshot = (snapshot: unknown) => {
      const s = snapshot as Record<string, unknown>;
      hydrateSnapshot(s);
      if (s.sessions) {
        setSessions(s.sessions as Session[]);
      }
    };

    async function init() {
      const baseUrl = window.location.origin;
      try {
        const config = await client.fetchConfig(baseUrl);
        setConfig(config);
      } catch {
        // Config endpoint may not be available in dev mode
      }

      const deviceIdentity = await getOrCreateDeviceIdentity();
      const gatewayUrl = import.meta.env.DEV
        ? "ws://localhost:18789"
        : window.location.origin;

      const token =
        sessionStorage.getItem(`openclaw-token-${gatewayUrl}`) ?? undefined;

      client.connect({
        gatewayUrl,
        token,
        deviceIdentity,
      });
    }

    init();

    return () => {
      client.disconnect();
    };
  }, [client, setStatus, setConfig, hydrateSnapshot, setSessions]);

  return (
    <GatewayContext.Provider value={client}>{children}</GatewayContext.Provider>
  );
}
