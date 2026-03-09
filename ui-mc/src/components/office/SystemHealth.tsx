import { motion } from "framer-motion";
import { GlassCard } from "@/components/ui/GlassCard";
import { useAgentStore } from "@/store/agentStore";

export function SystemHealth() {
  const agents = useAgentStore((s) => s.agents);
  const totalCompleted = agents.reduce((a, b) => a + b.tasksCompleted, 0);
  const activeCount = agents.filter(
    (a) => a.status === "WORKING" || a.status === "THINKING",
  ).length;

  const metrics = [
    { label: "Tasks Done", value: totalCompleted, color: "#30D158" },
    { label: "Active Agents", value: activeCount, color: "#00C8FF" },
    { label: "Tokens Used", value: "1.2M", color: "#FFD60A" },
    { label: "Uptime", value: "99.9%", color: "#BF5AF2" },
  ];

  return (
    <GlassCard className="p-4" hover={false}>
      <h3 className="text-sm font-medium text-foreground mb-4">System Health</h3>
      <div className="grid grid-cols-2 gap-4">
        {metrics.map((m, i) => (
          <div key={m.label} className="text-center">
            <motion.div
              className="text-2xl font-bold font-mono"
              style={{ color: m.color }}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: i * 0.1 }}
            >
              {m.value}
            </motion.div>
            <div className="text-[10px] text-text-2 font-mono mt-1">{m.label}</div>
          </div>
        ))}
      </div>
    </GlassCard>
  );
}
