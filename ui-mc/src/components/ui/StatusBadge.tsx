import type { AgentStatus } from "@/lib/agents";

const statusConfig: Record<AgentStatus, { label: string; class: string }> = {
  WORKING: {
    label: "WORKING",
    class: "bg-primary/20 text-primary border-primary/40 animate-pulse-glow",
  },
  IDLE: { label: "IDLE", class: "bg-muted text-text-2 border-text-3" },
  THINKING: {
    label: "THINKING",
    class: "bg-accent-gold/20 text-accent-gold border-accent-gold/40 animate-pulse-glow",
  },
  DONE: { label: "DONE", class: "bg-accent-green/20 text-accent-green border-accent-green/40" },
  ERROR: { label: "ERROR", class: "bg-accent-red/20 text-accent-red border-accent-red/40" },
};

export function StatusBadge({ status }: { status: AgentStatus }) {
  const config = statusConfig[status];
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[10px] font-mono font-bold uppercase tracking-wider border ${config.class}`}
    >
      <span className="w-1.5 h-1.5 rounded-full bg-current" />
      {config.label}
    </span>
  );
}
