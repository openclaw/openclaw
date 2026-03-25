import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useGatewayStore } from "@/store/gateway-store";

/**
 * Slim banner that appears when the gateway connection drops, showing why it
 * disconnected and briefly confirming when it reconnects.
 */
export function ReconnectBanner() {
  const connectionStatus = useGatewayStore((s) => s.connectionStatus);
  const disconnectReason = useGatewayStore((s) => s.disconnectReason);

  // Track whether we should show a brief "reconnected" flash after recovery.
  const [showReconnected, setShowReconnected] = useState(false);
  const [prevStatus, setPrevStatus] = useState(connectionStatus);

  useEffect(() => {
    if (prevStatus === "disconnected" && connectionStatus === "connected") {
      setShowReconnected(true);
      const timer = window.setTimeout(() => setShowReconnected(false), 2500);
      return () => window.clearTimeout(timer);
    }
    setPrevStatus(connectionStatus);
  }, [connectionStatus, prevStatus]);

  const isDisconnected = connectionStatus === "disconnected";
  const isReconnecting = connectionStatus === "connecting" && !!disconnectReason;

  if (!isDisconnected && !isReconnecting && !showReconnected) {
    return null;
  }

  if (showReconnected) {
    return (
      <div className="flex items-center gap-2 px-3 py-1.5 text-xs font-medium bg-green-500/10 border-b border-green-500/20 text-green-600 dark:text-green-400">
        <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
        <span>Connected</span>
      </div>
    );
  }

  const reason = disconnectReason ?? "Connection lost";
  const label = isReconnecting ? `Reconnecting\u2026 \u2014 ${reason}` : `Disconnected \u2014 ${reason}`;

  return (
    <div
      className={cn(
        "flex items-center gap-2 px-3 py-1.5 text-xs font-medium border-b",
        "bg-amber-500/10 border-amber-500/20 text-amber-700 dark:text-amber-400",
      )}
    >
      {isReconnecting ? (
        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
      ) : (
        <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
      )}
      <span>{label}</span>
    </div>
  );
}
