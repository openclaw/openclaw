import { useEffect } from "react";
import { useGateway } from "./use-gateway";

export function useEvent(
  eventName: string,
  handler: (payload: unknown) => void,
): void {
  const { client } = useGateway();

  useEffect(() => {
    const unsubscribe = client.on(eventName, handler);
    return unsubscribe;
  }, [client, eventName, handler]);
}
