import type { ConnectionStatus } from "../lib/gateway";

interface Props {
  status: ConnectionStatus;
  agentCount: number;
  onlineCount: number;
  gwHost: string;
  onRefresh?: () => void;
}

const statusLabel: Record<ConnectionStatus, string> = {
  disconnected: "Disconnected",
  connecting: "Connecting…",
  connected: "Connected",
  error: "Error",
};

const statusColor: Record<ConnectionStatus, string> = {
  disconnected: "bg-slate-500",
  connecting: "bg-amber-400 animate-pulse",
  connected: "bg-emerald-400 status-dot-online",
  error: "bg-red-500",
};

export function StatusHeader({ status, agentCount, onlineCount, gwHost, onRefresh }: Props) {
  return (
    <header className="border-b border-border bg-card/50 backdrop-blur-sm sticky top-0 z-10">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-3 flex items-center justify-between gap-4">
        {/* Left: brand */}
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <span className="text-xl">🦾</span>
            <span className="font-bold text-lg tracking-tight text-foreground">
              Mavis <span className="text-primary">MC</span>
            </span>
          </div>
          <span className="hidden sm:block text-xs text-muted-foreground border border-border rounded px-1.5 py-0.5 font-mono">
            {gwHost}
          </span>
        </div>

        {/* Right: status + stats */}
        <div className="flex items-center gap-4">
          {/* Agent stats */}
          <div className="hidden sm:flex items-center gap-3 text-sm">
            <span className="text-muted-foreground">
              <span className="text-foreground font-medium">{onlineCount}</span>/{agentCount} online
            </span>
          </div>

          {/* Connection status */}
          <div className="flex items-center gap-2">
            <span className={`w-2.5 h-2.5 rounded-full ${statusColor[status]}`} />
            <span className="text-sm text-muted-foreground hidden sm:block">
              {statusLabel[status]}
            </span>
          </div>

          {/* Refresh button */}
          {onRefresh && (
            <button
              onClick={onRefresh}
              className="
                text-muted-foreground hover:text-foreground transition-colors
                p-1.5 rounded-md hover:bg-secondary
              "
              title="Reconnect"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
                <path d="M21 3v5h-5" />
                <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
                <path d="M8 16H3v5" />
              </svg>
            </button>
          )}
        </div>
      </div>
    </header>
  );
}
