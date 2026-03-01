import { Wifi, WifiOff, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ConnectionStatus as ConnectionStatusType } from "@/store/gateway-store";

export type ConnectionStatusProps = {
  status: ConnectionStatusType;
  protocol?: number;
  error?: string | null;
  className?: string;
};

const statusConfig: Record<
  ConnectionStatusType,
  { icon: typeof Wifi; label: string; color: string; dot: string }
> = {
  connected: {
    icon: Wifi,
    label: "Gateway Online",
    color: "text-primary",
    dot: "bg-primary",
  },
  connecting: {
    icon: Loader2,
    label: "Connecting...",
    color: "text-muted-foreground",
    dot: "bg-warning",
  },
  disconnected: {
    icon: WifiOff,
    label: "Gateway Offline",
    color: "text-muted-foreground",
    dot: "bg-muted-foreground",
  },
  error: {
    icon: WifiOff,
    label: "Connection Error",
    color: "text-destructive",
    dot: "bg-destructive",
  },
};

export function ConnectionStatus({ status, protocol, error, className }: ConnectionStatusProps) {
  const config = statusConfig[status];
  const Icon = config.icon;

  return (
    <div
      className={cn(
        "flex items-center gap-3 rounded-lg border border-border bg-card p-4",
        className,
      )}
    >
      <Icon className={cn("h-5 w-5", config.color, status === "connecting" && "animate-spin")} />
      <div className="flex-1">
        <span className={cn("font-mono text-sm", config.color)}>{config.label}</span>
        {protocol && status === "connected" && (
          <span className="ml-3 text-xs text-muted-foreground">protocol v{protocol}</span>
        )}
        {error && status !== "connected" && (
          <p className="mt-1 text-xs text-destructive">{error}</p>
        )}
      </div>
      <div
        className={cn("h-2.5 w-2.5 rounded-full", config.dot, {
          "animate-glow-pulse": status === "connected",
        })}
      />
    </div>
  );
}

/** Compact inline dot + label for headers/sidebars */
export function ConnectionDot({
  status,
  className,
}: {
  status: ConnectionStatusType;
  className?: string;
}) {
  const config = statusConfig[status];
  return (
    <div className={cn("flex items-center gap-2", className)}>
      <div
        className={cn("h-2 w-2 rounded-full", config.dot, {
          "animate-glow-pulse": status === "connected",
        })}
      />
      <span className={cn("text-xs font-mono", config.color)}>{config.label}</span>
    </div>
  );
}
