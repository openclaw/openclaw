import { motion, AnimatePresence } from "framer-motion";
import { MessageCircle, ChevronDown, Zap, CheckCircle2, Clock, Cpu, BarChart3 } from "lucide-react";
import { useState } from "react";
import { GlassCard } from "@/components/ui/GlassCard";
import { StatusBadge } from "@/components/ui/StatusBadge";
import type { Agent } from "@/lib/agents";
import { avatarMap } from "@/lib/avatars";
import { CollaborationIndicator } from "./CollaborationIndicator";

const hoverAnimations: Record<string, any> = {
  WORKING: { y: -8, scale: 1.08, transition: { type: "spring", stiffness: 300, damping: 20 } },
  THINKING: {
    rotate: [-3, 3],
    scale: 1.05,
    transition: { duration: 0.6, repeat: Infinity, repeatType: "reverse" },
  },
  DONE: { scale: 1.12, transition: { type: "spring", stiffness: 400, damping: 15 } },
  IDLE: { y: -6, opacity: 0.9, transition: { type: "spring", stiffness: 300, damping: 20 } },
  ERROR: { x: [-3, 3, -3, 3, 0], transition: { duration: 0.4 } },
};

export function AgentDeskCard({
  agent,
  index,
  onAvatarClick,
}: {
  agent: Agent;
  index: number;
  onAvatarClick?: (agent: Agent) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const hoverAnim = hoverAnimations[agent.status] || { scale: 1.05 };
  const completionRate =
    agent.tasksCompleted > 0 ? Math.round((agent.tasksDone / agent.tasksCompleted) * 100) : 0;

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.05, duration: 0.4 }}
      layout
    >
      <GlassCard className="p-0 overflow-hidden relative group" hover={!expanded}>
        {/* Background glow */}
        <div
          className="absolute inset-0 opacity-10 pointer-events-none"
          style={{
            background: `radial-gradient(ellipse at center bottom, ${agent.color}40, transparent 70%)`,
          }}
        />

        {/* Animated orb behind avatar */}
        {(agent.status === "WORKING" || agent.status === "THINKING") && (
          <motion.div
            className="absolute left-1/2 top-16 -translate-x-1/2 w-20 h-20 rounded-full pointer-events-none"
            style={{ background: `radial-gradient(circle, ${agent.color}30, transparent 70%)` }}
            animate={{ scale: [1, 1.4, 1], opacity: [0.3, 0.6, 0.3] }}
            transition={{ duration: 3, repeat: Infinity, ease: "easeInOut" }}
          />
        )}

        {/* Clickable header area */}
        <button className="w-full text-left" onClick={() => setExpanded(!expanded)}>
          {/* Agent image & name */}
          <div className="relative pt-4 px-4 flex flex-col items-center">
            <div className="relative w-28 h-28 mb-3">
              <motion.img
                src={avatarMap[agent.id] ?? agent.avatar}
                alt={agent.name}
                className="w-full h-full object-contain drop-shadow-lg will-change-transform cursor-pointer"
                whileHover={hoverAnim}
                onClick={(e) => {
                  e.stopPropagation();
                  onAvatarClick?.(agent);
                }}
              />
              {(agent.status === "WORKING" || agent.status === "THINKING") && (
                <>
                  <motion.div
                    className="absolute -inset-2 rounded-full pointer-events-none"
                    style={{ border: `2px solid ${agent.color}` }}
                    animate={{ scale: [1, 1.15, 1], opacity: [0.4, 0, 0.4] }}
                    transition={{ duration: 2, repeat: Infinity, ease: "easeOut" }}
                  />
                  <motion.div
                    className="absolute -inset-1 rounded-full pointer-events-none"
                    style={{ boxShadow: `0 0 20px ${agent.color}40` }}
                    animate={{ opacity: [0.3, 0.6, 0.3] }}
                    transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
                  />
                </>
              )}
              {agent.status === "DONE" && (
                <motion.div
                  className="absolute -inset-1 rounded-full pointer-events-none"
                  style={{ boxShadow: `0 0 25px ${agent.color}50` }}
                  animate={{ scale: [1, 1.3], opacity: [0.6, 0] }}
                  transition={{ duration: 1.2, repeat: Infinity }}
                />
              )}
            </div>

            <h3 className="text-lg font-bold tracking-wider text-foreground">{agent.name}</h3>
            <p className="text-[11px] font-mono text-text-2 mb-1">{agent.role}</p>
            <p className="text-[10px] text-text-3 mb-2 line-clamp-1">{agent.currentTask}</p>

            {/* Short code badge */}
            <div
              className="absolute top-3 right-3 w-7 h-7 rounded-md flex items-center justify-center text-xs font-bold"
              style={{ backgroundColor: `${agent.color}20`, color: agent.color }}
            >
              {agent.shortCode}
            </div>

            {/* Expand indicator */}
            <motion.div
              className="absolute top-3 left-3"
              animate={{ rotate: expanded ? 180 : 0 }}
              transition={{ duration: 0.2 }}
            >
              <ChevronDown className="w-4 h-4 text-text-3" />
            </motion.div>
          </div>
        </button>

        {/* Progress bar */}
        <div className="px-4 mt-2">
          <div className="flex items-center justify-between text-[10px] font-mono mb-1">
            <span className="text-text-2">Progress</span>
            <span style={{ color: agent.color }}>{agent.progress}%</span>
          </div>
          <div className="h-1.5 bg-secondary rounded-full overflow-hidden">
            <motion.div
              className="h-full rounded-full"
              style={{ backgroundColor: agent.color }}
              initial={{ width: 0 }}
              animate={{ width: `${agent.progress}%` }}
              transition={{ duration: 0.8, ease: "easeOut" }}
            />
          </div>
        </div>

        {/* Footer stats */}
        <div className="px-4 py-3 mt-2 flex items-center justify-between border-t border-border">
          <StatusBadge status={agent.status} />
          <div className="flex items-center gap-3">
            <CollaborationIndicator agentId={agent.id} />
            <span className="text-[10px] font-mono text-text-2">
              {agent.tasksCompleted} completed
            </span>
          </div>
        </div>

        {/* ─── EXPANDED PANEL ─── */}
        <AnimatePresence>
          {expanded && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.3, ease: "easeInOut" }}
              className="overflow-hidden border-t border-border"
            >
              <div className="p-4 space-y-3">
                {/* Mini stat screens */}
                <div className="grid grid-cols-3 gap-2">
                  <MiniStat
                    icon={<CheckCircle2 className="w-3.5 h-3.5" />}
                    label="Done"
                    value={String(agent.tasksDone)}
                    color={agent.color}
                  />
                  <MiniStat
                    icon={<BarChart3 className="w-3.5 h-3.5" />}
                    label="Rate"
                    value={`${completionRate}%`}
                    color={
                      completionRate >= 75
                        ? "#30D158"
                        : completionRate >= 50
                          ? "#FFD60A"
                          : "#FF2D55"
                    }
                  />
                  <MiniStat
                    icon={<Clock className="w-3.5 h-3.5" />}
                    label="Queue"
                    value={String(agent.tasksCompleted - agent.tasksDone)}
                    color="#8E8E93"
                  />
                </div>

                {/* Capabilities */}
                <div>
                  <div className="flex items-center gap-1.5 mb-2">
                    <Cpu className="w-3 h-3 text-text-3" />
                    <span className="text-[10px] font-mono text-text-3 uppercase tracking-wider">
                      Capabilities
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {agent.capabilities.map((cap) => (
                      <span
                        key={cap}
                        className="text-[9px] font-mono px-2 py-1 rounded-md border border-border"
                        style={{ color: agent.color, backgroundColor: `${agent.color}08` }}
                      >
                        {cap}
                      </span>
                    ))}
                  </div>
                </div>

                {/* Performance bar */}
                <div>
                  <div className="flex items-center gap-1.5 mb-2">
                    <Zap className="w-3 h-3 text-text-3" />
                    <span className="text-[10px] font-mono text-text-3 uppercase tracking-wider">
                      Efficiency
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <MiniBar
                      label="Throughput"
                      value={Math.min(100, Math.round(agent.tasksDone / 2))}
                      color={agent.color}
                    />
                    <MiniBar
                      label="Accuracy"
                      value={completionRate}
                      color={completionRate >= 75 ? "#30D158" : "#FFD60A"}
                    />
                  </div>
                </div>

                {/* Action buttons */}
                <div className="flex gap-2 pt-1">
                  <button className="flex-1 glass-pill text-center py-2 text-[10px] font-mono text-primary hover:bg-primary/10 transition-colors flex items-center justify-center gap-1.5">
                    <MessageCircle className="w-3.5 h-3.5" /> Message
                  </button>
                  <button className="flex-1 glass-pill text-center py-2 text-[10px] font-mono text-text-2 hover:text-foreground transition-colors">
                    Configure
                  </button>
                  <button className="flex-1 glass-pill text-center py-2 text-[10px] font-mono text-text-2 hover:text-foreground transition-colors">
                    History
                  </button>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </GlassCard>
    </motion.div>
  );
}

/* ── Mini stat widget ── */
function MiniStat({
  icon,
  label,
  value,
  color,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  color: string;
}) {
  return (
    <div className="glass-panel-sm p-2.5 flex flex-col items-center gap-1">
      <div style={{ color }}>{icon}</div>
      <span className="text-sm font-bold font-mono" style={{ color }}>
        {value}
      </span>
      <span className="text-[8px] font-mono text-text-3 uppercase tracking-wider">{label}</span>
    </div>
  );
}

/* ── Mini bar chart ── */
function MiniBar({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div>
      <div className="flex justify-between text-[9px] font-mono mb-1">
        <span className="text-text-3">{label}</span>
        <span style={{ color }}>{value}%</span>
      </div>
      <div className="h-1 bg-secondary rounded-full overflow-hidden">
        <motion.div
          className="h-full rounded-full"
          style={{ backgroundColor: color }}
          initial={{ width: 0 }}
          animate={{ width: `${value}%` }}
          transition={{ duration: 0.6, delay: 0.1 }}
        />
      </div>
    </div>
  );
}
