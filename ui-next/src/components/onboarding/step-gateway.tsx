import { CheckCircle2, Loader2 } from "lucide-react";
import { useEffect } from "react";
import { useGatewayStore } from "@/store/gateway-store";

type Props = { onValidChange: (valid: boolean) => void };

export function StepGateway({ onValidChange }: Props) {
  const connectionStatus = useGatewayStore((s) => s.connectionStatus);
  const hello = useGatewayStore((s) => s.hello);
  const isConnected = connectionStatus === "connected";

  useEffect(() => {
    onValidChange(isConnected);
  }, [isConnected, onValidChange]);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Gateway Connection</h2>
        <p className="text-sm text-muted-foreground mt-1">
          The gateway is the core service that powers your agents. Let's verify it's running.
        </p>
      </div>

      <div className="rounded-lg border border-border p-6">
        {isConnected ? (
          <div className="flex items-start gap-4">
            <CheckCircle2 className="h-8 w-8 text-primary shrink-0 mt-0.5" />
            <div className="space-y-2">
              <div className="font-medium text-primary">Gateway Connected</div>
              <div className="text-sm text-muted-foreground space-y-1">
                <div>Protocol: v{hello?.protocol ?? "unknown"}</div>
                <div>Methods: {hello?.features?.methods?.length ?? 0} available</div>
                {hello?.protocol && <div>Auth: {hello.auth?.role ?? "default"}</div>}
              </div>
            </div>
          </div>
        ) : (
          <div className="flex items-start gap-4">
            <Loader2 className="h-8 w-8 text-muted-foreground shrink-0 mt-0.5 animate-spin" />
            <div className="space-y-2">
              <div className="font-medium">Connecting to Gateway...</div>
              <p className="text-sm text-muted-foreground">
                Make sure the gateway is running. You can start it with:
              </p>
              <code className="block bg-secondary/50 rounded px-3 py-2 text-sm font-mono">
                openclaw gateway run
              </code>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
