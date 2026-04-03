import { Alert, AlertDescription } from "@/components/ui/alert";
import { useGatewayStore } from "@/stores/gateway";

export function ConnectionBanner() {
  const status = useGatewayStore((s) => s.status);
  const error = useGatewayStore((s) => s.error);

  if (status === "connected" || status === "disconnected") return null;

  return (
    <Alert variant="destructive" className="rounded-none border-x-0 border-t-0">
      <AlertDescription>
        {status === "connecting" && "Connecting to gateway..."}
        {status === "authenticating" && "Authenticating..."}
        {status === "error" && (error ?? "Connection failed. Retrying...")}
      </AlertDescription>
    </Alert>
  );
}
