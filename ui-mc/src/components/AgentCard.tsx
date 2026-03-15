import type { AgentInfo } from "../lib/gateway";

interface Props {
  agent: AgentInfo;
  onClick?: () => void;
}

const statusConfig = {
  online: {
    label: "Online",
    dot: "bg-emerald-400",
    badge: "text-emerald-400 bg-emerald-400/10 border-emerald-400/20",
    pulse: true,
  },
  busy: {
    label: "Busy",
    dot: "bg-amber-400",
    badge: "text-amber-400   bg-amber-400/10   border-amber-400/20",
    pulse: true,
  },
  offline: {
    label: "Offline",
    dot: "bg-slate-500",
    badge: "text-slate-400   bg-slate-400/10   border-slate-400/20",
    pulse: false,
  },
  unknown: {
    label: "Unknown",
    dot: "bg-slate-600",
    badge: "text-slate-500   bg-slate-500/10   border-slate-500/20",
    pulse: false,
  },
} as const;

export function AgentCard({ agent, onClick }: Props) {
  const cfg = statusConfig[agent.status] ?? statusConfig.unknown;

  return (
    <button
      onClick={onClick}
      className="
        group relative flex flex-col gap-3 p-5 rounded-xl text-left w-full
        bg-card border border-border
        hover:border-primary/40 hover:bg-card/80
        transition-all duration-200 cursor-pointer
        focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1 focus:ring-offset-background
      "
    >
      {/* Top row: emoji + status dot */}
      <div className="flex items-start justify-between">
        <span className="text-3xl select-none leading-none">{agent.emoji}</span>
        <div className="flex items-center gap-1.5 mt-1">
          <span
            className={`w-2 h-2 rounded-full ${cfg.dot} ${cfg.pulse ? "status-dot-online" : ""}`}
          />
        </div>
      </div>

      {/* Name */}
      <div>
        <p className="font-semibold text-foreground text-sm leading-tight truncate">{agent.name}</p>
        {agent.role && (
          <p className="text-xs text-muted-foreground mt-0.5 truncate">{agent.role}</p>
        )}
      </div>

      {/* Status badge */}
      <div className="flex items-center gap-2">
        <span
          className={`
            inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border
            ${cfg.badge}
          `}
        >
          {cfg.label}
        </span>
      </div>

      {/* Model tag (if available) */}
      {agent.model && (
        <p className="text-xs text-muted-foreground/60 truncate font-mono">{agent.model}</p>
      )}

      {/* Hover glow */}
      <div
        className="
        absolute inset-0 rounded-xl opacity-0 group-hover:opacity-100 transition-opacity duration-200
        pointer-events-none
        bg-gradient-to-br from-primary/5 to-transparent
      "
      />
    </button>
  );
}
