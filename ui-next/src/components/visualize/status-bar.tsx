"use client";

import { Activity, Coins, Radio, ZoomIn } from "lucide-react";
import { cn } from "@/lib/utils";
import { useGatewayStore } from "@/store/gateway-store";

export interface StatusBarProps {
  activeCount: number;
  totalTokens: number;
  zoom: number;
}

function formatTokens(tokens: number): string {
  if (tokens < 1000) {
    return `${tokens}`;
  }
  if (tokens < 1_000_000) {
    return `${(tokens / 1000).toFixed(1)}k`;
  }
  return `${(tokens / 1_000_000).toFixed(2)}M`;
}

export function StatusBar({ activeCount, totalTokens, zoom }: StatusBarProps) {
  const connectionStatus = useGatewayStore((s) => s.connectionStatus);

  const isConnected = connectionStatus === "connected";

  return (
    <div
      role="status"
      aria-label="Visualization status"
      className="flex items-center gap-4 border-t bg-muted/50 px-4 py-1.5"
    >
      {/* Active agents */}
      <StatusItem icon={Activity} label="Agents" value={String(activeCount)} />

      {/* Total tokens */}
      <StatusItem icon={Coins} label="Tokens" value={formatTokens(totalTokens)} />

      {/* Connection */}
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Radio className="h-3 w-3" />
        <span
          className={cn(
            "capitalize",
            isConnected && "text-green-600 dark:text-green-400",
            connectionStatus === "error" && "text-destructive",
          )}
        >
          {connectionStatus}
        </span>
      </div>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Zoom level */}
      <StatusItem icon={ZoomIn} label="Zoom" value={`${Math.round(zoom * 100)}%`} />
    </div>
  );
}

function StatusItem({
  icon: Icon,
  label,
  value,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <Icon className="h-3 w-3" />
      <span>{label}:</span>
      <span className="font-mono tabular-nums text-foreground">{value}</span>
    </div>
  );
}
