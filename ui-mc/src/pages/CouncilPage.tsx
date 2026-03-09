import { motion } from "framer-motion";
import { MessageCircle, Settings, Clock } from "lucide-react";
import { GlassCard } from "@/components/ui/GlassCard";
import { HeroSection } from "@/components/ui/HeroSection";
import { avatarMap } from "@/lib/avatars";
import { useAgentStore } from "@/store/agentStore";

export default function CouncilPage() {
  const agents = useAgentStore((s) => s.agents);

  return (
    <div className="space-y-6">
      <HeroSection title="Agent Council" subtitle="Your strategic advisory board" />

      {/* Council circle */}
      <GlassCard className="p-8" hover={false}>
        <div className="relative w-full max-w-xl mx-auto aspect-square">
          {/* Rings */}
          <div className="absolute inset-[30%] rounded-full border border-border" />
          <div className="absolute inset-[45%] rounded-full border border-primary/20" />

          {/* Connection lines */}
          <svg className="absolute inset-0 w-full h-full pointer-events-none" viewBox="0 0 100 100">
            {agents.map((_, i) => {
              const next = (i + 1) % agents.length;
              const a1 = (i / agents.length) * Math.PI * 2 - Math.PI / 2;
              const a2 = (next / agents.length) * Math.PI * 2 - Math.PI / 2;
              return (
                <motion.line
                  key={i}
                  x1={50 + 40 * Math.cos(a1)}
                  y1={50 + 40 * Math.sin(a1)}
                  x2={50 + 40 * Math.cos(a2)}
                  y2={50 + 40 * Math.sin(a2)}
                  stroke="hsl(var(--border))"
                  strokeWidth="0.3"
                  initial={{ pathLength: 0 }}
                  animate={{ pathLength: 1 }}
                  transition={{ delay: i * 0.1, duration: 0.5 }}
                />
              );
            })}
          </svg>

          {agents.map((agent, i) => {
            const angle = (i / agents.length) * Math.PI * 2 - Math.PI / 2;
            const x = 50 + 40 * Math.cos(angle);
            const y = 50 + 40 * Math.sin(angle);
            return (
              <motion.div
                key={agent.id}
                initial={{ opacity: 0, scale: 0.5 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ delay: i * 0.08 }}
                className="absolute w-16 h-16 -translate-x-1/2 -translate-y-1/2 cursor-pointer group"
                style={{ left: `${x}%`, top: `${y}%` }}
              >
                <div className="relative">
                  <motion.img
                    src={avatarMap[agent.id]}
                    alt={agent.name}
                    className="w-16 h-16 object-contain drop-shadow-lg"
                    whileHover={{ scale: 1.15, y: -4 }}
                  />
                  <div
                    className="absolute -bottom-1 left-1/2 -translate-x-1/2 text-[9px] font-bold tracking-wider whitespace-nowrap"
                    style={{ color: agent.color }}
                  >
                    {agent.name}
                  </div>
                  {(agent.status === "WORKING" || agent.status === "THINKING") && (
                    <div
                      className="absolute -inset-1 rounded-full animate-pulse-glow opacity-30"
                      style={{ boxShadow: `0 0 15px ${agent.color}` }}
                    />
                  )}
                </div>
              </motion.div>
            );
          })}

          <div className="absolute inset-0 flex items-center justify-center">
            <div className="text-center">
              <div className="text-xs text-text-2 font-mono">MAVIS</div>
              <div className="text-[10px] text-text-3 font-mono">COUNCIL</div>
            </div>
          </div>
        </div>
      </GlassCard>

      {/* Agent profiles */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {agents.map((agent, i) => (
          <motion.div
            key={agent.id}
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.05 }}
          >
            <GlassCard className="p-4">
              <div className="flex items-center gap-3 mb-3">
                <motion.img
                  src={avatarMap[agent.id]}
                  alt={agent.name}
                  className="w-12 h-12 object-contain"
                  whileHover={{ scale: 1.1 }}
                />
                <div>
                  <div className="text-sm font-bold" style={{ color: agent.color }}>
                    {agent.name}
                  </div>
                  <div className="text-[10px] text-text-2">{agent.role}</div>
                </div>
              </div>
              <p className="text-[11px] text-text-3 mb-2">{agent.currentTask}</p>
              <div className="flex flex-wrap gap-1 mb-3">
                {agent.capabilities.map((cap) => (
                  <span
                    key={cap}
                    className="text-[9px] font-mono px-1.5 py-0.5 rounded-full bg-secondary text-text-2"
                  >
                    {cap}
                  </span>
                ))}
              </div>
              <div className="flex gap-2 text-[10px] font-mono text-text-3 border-t border-border pt-2">
                <span>{agent.tasksDone} done</span>
                <span>·</span>
                <span>{agent.tasksCompleted - agent.tasksDone} queued</span>
              </div>
              <div className="flex gap-1.5 mt-3">
                <button className="flex-1 glass-pill text-center py-1.5 text-[10px] font-mono text-primary hover:bg-primary/10 transition-colors flex items-center justify-center gap-1">
                  <MessageCircle className="w-3 h-3" /> DM
                </button>
                <button className="flex-1 glass-pill text-center py-1.5 text-[10px] font-mono text-text-2 hover:text-foreground transition-colors flex items-center justify-center gap-1">
                  <Settings className="w-3 h-3" /> Config
                </button>
                <button className="flex-1 glass-pill text-center py-1.5 text-[10px] font-mono text-text-2 hover:text-foreground transition-colors flex items-center justify-center gap-1">
                  <Clock className="w-3 h-3" /> Logs
                </button>
              </div>
            </GlassCard>
          </motion.div>
        ))}
      </div>
    </div>
  );
}
