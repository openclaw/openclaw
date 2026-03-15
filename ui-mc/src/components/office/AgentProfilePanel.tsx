import { formatDistanceToNow } from "date-fns";
import { motion, AnimatePresence } from "framer-motion";
import {
  X,
  Zap,
  CheckCircle2,
  Clock,
  Cpu,
  BarChart3,
  TrendingUp,
  Target,
  MessageCircle,
} from "lucide-react";
import { StatusBadge } from "@/components/ui/StatusBadge";
import type { Agent } from "@/lib/agents";
import { avatarMap } from "@/lib/avatars";
import { cn } from "@/lib/utils";
import { useActivityStore } from "@/store/activityStore";
import { useTaskStore } from "@/store/taskStore";

interface AgentProfilePanelProps {
  agent: Agent;
  onClose: () => void;
}

export function AgentProfilePanel({ agent, onClose }: AgentProfilePanelProps) {
  const tasks = useTaskStore((s) => s.tasks);
  const events = useActivityStore((s) => s.events);

  const agentTasks = tasks.filter((t) => t.assignedAgent === agent.id);
  const doneTasks = agentTasks.filter((t) => t.status === "done");
  const inProgressTasks = agentTasks.filter((t) => t.status === "in_progress");
  const todoTasks = agentTasks.filter((t) => t.status === "todo");
  const reviewTasks = agentTasks.filter((t) => t.status === "review");
  const agentEvents = events.filter((e) => e.agentId === agent.id).slice(0, 10);

  const completionRate =
    agent.tasksCompleted > 0 ? Math.round((agent.tasksDone / agent.tasksCompleted) * 100) : 0;
  const throughput = Math.min(100, Math.round(agent.tasksDone / 2));
  const urgentTasks = agentTasks.filter(
    (t) => t.priority === "urgent" || t.priority === "high",
  ).length;

  const stats = [
    {
      icon: CheckCircle2,
      label: "Completed",
      value: agent.tasksDone,
      color: "hsl(var(--accent-green))",
    },
    { icon: Target, label: "Assigned", value: agentTasks.length, color: agent.color },
    {
      icon: TrendingUp,
      label: "Rate",
      value: `${completionRate}%`,
      color: completionRate >= 75 ? "hsl(var(--accent-green))" : "hsl(var(--accent-gold))",
    },
    {
      icon: Clock,
      label: "In Queue",
      value: agent.tasksCompleted - agent.tasksDone,
      color: "hsl(var(--muted-foreground))",
    },
  ];

  const STATUS_COLORS: Record<string, string> = {
    todo: "#8E8E93",
    in_progress: "#00C8FF",
    review: "#FFD60A",
    done: "#30D158",
  };

  return (
    <AnimatePresence>
      <motion.div
        className="fixed inset-0 z-50 flex justify-end"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
      >
        <motion.div
          className="absolute inset-0 bg-background/70 backdrop-blur-sm"
          onClick={onClose}
        />

        <motion.div
          className="relative w-full max-w-md h-full glass-panel rounded-none rounded-l-2xl border-l border-border overflow-y-auto scrollbar-thin"
          initial={{ x: "100%" }}
          animate={{ x: 0 }}
          exit={{ x: "100%" }}
          transition={{ type: "spring" as const, stiffness: 350, damping: 35 }}
        >
          {/* Header with avatar */}
          <div className="relative overflow-hidden">
            {/* Background glow */}
            <div
              className="absolute inset-0 opacity-20 pointer-events-none"
              style={{
                background: `radial-gradient(ellipse at center, ${agent.color}40, transparent 70%)`,
              }}
            />

            <div className="relative flex items-start justify-between p-5">
              <button
                onClick={onClose}
                className="p-1.5 rounded-lg hover:bg-secondary transition-colors z-10"
              >
                <X className="w-4 h-4 text-muted-foreground" />
              </button>
              <div className="absolute top-3 right-3 z-10">
                <StatusBadge status={agent.status} />
              </div>
            </div>

            <div className="flex flex-col items-center pb-5 relative">
              <div className="relative w-24 h-24 mb-3">
                <motion.img
                  src={avatarMap[agent.id]}
                  alt={agent.name}
                  className="w-full h-full object-contain drop-shadow-lg"
                  initial={{ scale: 0.8, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  transition={{ type: "spring" as const, stiffness: 300, damping: 20, delay: 0.1 }}
                />
                {(agent.status === "WORKING" || agent.status === "THINKING") && (
                  <motion.div
                    className="absolute -inset-2 rounded-full pointer-events-none"
                    style={{ border: `2px solid ${agent.color}` }}
                    animate={{ scale: [1, 1.2, 1], opacity: [0.4, 0, 0.4] }}
                    transition={{ duration: 2, repeat: Infinity }}
                  />
                )}
              </div>

              <h2 className="text-xl font-bold tracking-wider text-foreground">{agent.name}</h2>
              <p className="text-xs font-mono text-muted-foreground">{agent.role}</p>
              <p className="text-[11px] text-muted-foreground mt-1">{agent.currentTask}</p>

              {/* Progress */}
              <div className="w-48 mt-3">
                <div className="flex items-center justify-between text-[10px] font-mono mb-1">
                  <span className="text-muted-foreground">Progress</span>
                  <span style={{ color: agent.color }}>{agent.progress}%</span>
                </div>
                <div className="h-1.5 bg-secondary rounded-full overflow-hidden">
                  <motion.div
                    className="h-full rounded-full"
                    style={{ backgroundColor: agent.color }}
                    initial={{ width: 0 }}
                    animate={{ width: `${agent.progress}%` }}
                    transition={{ duration: 0.8, delay: 0.2 }}
                  />
                </div>
              </div>
            </div>
          </div>

          <div className="p-5 space-y-6">
            {/* Stats grid */}
            <div className="grid grid-cols-4 gap-2">
              {stats.map((s, i) => (
                <motion.div
                  key={s.label}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.15 + i * 0.05 }}
                  className="glass-panel-sm p-2.5 flex flex-col items-center gap-1 text-center"
                >
                  <s.icon className="w-3.5 h-3.5" style={{ color: s.color }} />
                  <span className="text-sm font-bold font-mono" style={{ color: s.color }}>
                    {s.value}
                  </span>
                  <span className="text-[8px] font-mono text-muted-foreground uppercase tracking-wider">
                    {s.label}
                  </span>
                </motion.div>
              ))}
            </div>

            {/* Performance bars */}
            <div>
              <h3 className="text-[10px] font-mono text-muted-foreground uppercase tracking-wider mb-3 flex items-center gap-1.5">
                <BarChart3 className="w-3 h-3" /> Performance
              </h3>
              <div className="space-y-2.5">
                <PerfBar label="Throughput" value={throughput} color={agent.color} />
                <PerfBar
                  label="Completion Rate"
                  value={completionRate}
                  color={completionRate >= 75 ? "#30D158" : "#FFD60A"}
                />
                <PerfBar
                  label="Urgency Load"
                  value={
                    agentTasks.length > 0 ? Math.round((urgentTasks / agentTasks.length) * 100) : 0
                  }
                  color="#FF2D55"
                />
              </div>
            </div>

            {/* Capabilities */}
            <div>
              <h3 className="text-[10px] font-mono text-muted-foreground uppercase tracking-wider mb-3 flex items-center gap-1.5">
                <Cpu className="w-3 h-3" /> Capabilities
              </h3>
              <div className="flex flex-wrap gap-1.5">
                {agent.capabilities.map((cap, i) => (
                  <motion.span
                    key={cap}
                    initial={{ opacity: 0, scale: 0.8 }}
                    animate={{ opacity: 1, scale: 1 }}
                    transition={{ delay: 0.3 + i * 0.04 }}
                    className="text-[10px] font-mono px-2.5 py-1 rounded-lg border border-border"
                    style={{ color: agent.color, backgroundColor: `${agent.color}10` }}
                  >
                    {cap}
                  </motion.span>
                ))}
              </div>
            </div>

            {/* Assigned Tasks */}
            <div>
              <h3 className="text-[10px] font-mono text-muted-foreground uppercase tracking-wider mb-3 flex items-center gap-1.5">
                <Zap className="w-3 h-3" /> Assigned Tasks ({agentTasks.length})
              </h3>
              {agentTasks.length === 0 ? (
                <p className="text-xs text-muted-foreground font-mono py-3 text-center">
                  No tasks assigned
                </p>
              ) : (
                <div className="space-y-1.5">
                  {agentTasks.slice(0, 8).map((task, i) => (
                    <motion.div
                      key={task.id}
                      initial={{ opacity: 0, x: -10 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: 0.35 + i * 0.04 }}
                      className="flex items-center gap-2.5 py-1.5 px-2 rounded-lg hover:bg-secondary/30 transition-colors"
                    >
                      <span
                        className="w-1.5 h-1.5 rounded-full shrink-0"
                        style={{ backgroundColor: STATUS_COLORS[task.status] }}
                      />
                      <div className="flex-1 min-w-0">
                        <p
                          className={cn(
                            "text-xs truncate",
                            task.status === "done"
                              ? "text-muted-foreground line-through"
                              : "text-foreground",
                          )}
                        >
                          {task.title}
                        </p>
                      </div>
                      <span
                        className={cn(
                          "text-[9px] font-mono font-bold uppercase",
                          task.priority === "urgent"
                            ? "text-accent-red"
                            : task.priority === "high"
                              ? "text-accent-gold"
                              : "text-muted-foreground",
                        )}
                      >
                        {task.priority}
                      </span>
                    </motion.div>
                  ))}
                </div>
              )}
            </div>

            {/* Recent Activity */}
            <div>
              <h3 className="text-[10px] font-mono text-muted-foreground uppercase tracking-wider mb-3 flex items-center gap-1.5">
                <Clock className="w-3 h-3" /> Recent Activity
              </h3>
              {agentEvents.length === 0 ? (
                <p className="text-xs text-muted-foreground font-mono py-3 text-center">
                  No activity yet
                </p>
              ) : (
                <div className="space-y-0 relative">
                  <div className="absolute left-[5px] top-2 bottom-2 w-px bg-border" />
                  {agentEvents.map((event, i) => (
                    <motion.div
                      key={event.id}
                      initial={{ opacity: 0, y: 5 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: 0.4 + i * 0.03 }}
                      className="flex items-start gap-3 py-1.5 relative"
                    >
                      <div
                        className="w-[11px] h-[11px] rounded-full shrink-0 mt-0.5 z-10 border-2"
                        style={{ backgroundColor: `${agent.color}30`, borderColor: agent.color }}
                      />
                      <div className="flex-1 min-w-0">
                        <p className="text-xs text-foreground">{event.action}</p>
                        <p className="text-[10px] font-mono text-muted-foreground">
                          {formatDistanceToNow(event.timestamp, { addSuffix: true })}
                        </p>
                      </div>
                    </motion.div>
                  ))}
                </div>
              )}
            </div>

            {/* Action buttons */}
            <div className="flex gap-2 pt-1">
              <button className="flex-1 glass-pill text-center py-2.5 text-[11px] font-mono text-primary hover:bg-primary/10 transition-colors flex items-center justify-center gap-1.5">
                <MessageCircle className="w-3.5 h-3.5" /> Message
              </button>
              <button className="flex-1 glass-pill text-center py-2.5 text-[11px] font-mono text-muted-foreground hover:text-foreground transition-colors">
                Configure
              </button>
            </div>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}

function PerfBar({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div>
      <div className="flex justify-between text-[10px] font-mono mb-1">
        <span className="text-muted-foreground">{label}</span>
        <span style={{ color }}>{value}%</span>
      </div>
      <div className="h-1.5 bg-secondary rounded-full overflow-hidden">
        <motion.div
          className="h-full rounded-full"
          style={{ backgroundColor: color }}
          initial={{ width: 0 }}
          animate={{ width: `${value}%` }}
          transition={{ duration: 0.6, delay: 0.2 }}
        />
      </div>
    </div>
  );
}
