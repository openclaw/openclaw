import { motion } from "framer-motion";
import { Send, Zap } from "lucide-react";
import { useState } from "react";
import { GlassCard } from "@/components/ui/GlassCard";
import { toast } from "@/hooks/use-toast";
import { useActivityStore } from "@/store/activityStore";
import { useAgentStore } from "@/store/agentStore";
import { useTaskStore, TaskPriority } from "@/store/taskStore";

const PRIORITIES: { id: TaskPriority; label: string; color: string }[] = [
  { id: "low", label: "Low", color: "text-text-2" },
  { id: "medium", label: "Med", color: "text-primary" },
  { id: "high", label: "High", color: "text-accent-gold" },
  { id: "urgent", label: "Urgent", color: "text-accent-red" },
];

export function QuickDispatch() {
  const agents = useAgentStore((s) => s.agents);
  const updateAgentStatus = useAgentStore((s) => s.updateAgentStatus);
  const updateAgentTask = useAgentStore((s) => s.updateAgentTask);
  const addTask = useTaskStore((s) => s.addTask);
  const addEvent = useActivityStore((s) => s.addEvent);

  const [title, setTitle] = useState("");
  const [agentId, setAgentId] = useState("aria");
  const [priority, setPriority] = useState<TaskPriority>("medium");
  const [sent, setSent] = useState(false);

  const selectedAgent = agents.find((a) => a.id === agentId);

  const dispatch = () => {
    if (!title.trim()) {
      return;
    }

    addTask({
      title,
      description: "",
      status: "in_progress",
      priority,
      assignedAgent: agentId,
      dueDate: new Date(Date.now() + 86400000).toISOString().split("T")[0],
      tags: ["dispatched"],
    });

    updateAgentStatus(agentId, "WORKING");
    updateAgentTask(agentId, title);

    addEvent({
      agentId,
      agentName: selectedAgent.name,
      agentColor: selectedAgent.color,
      action: `received task: ${title}`,
    });

    toast({
      title: "Task Dispatched",
      description: `${selectedAgent.name} is now working on "${title}"`,
    });

    setSent(true);
    setTimeout(() => {
      setSent(false);
      setTitle("");
    }, 1200);
  };

  return (
    <GlassCard className="p-4" hover={false}>
      <h3 className="text-sm font-medium text-foreground mb-3 flex items-center gap-2">
        <Zap className="w-4 h-4 text-accent-gold" />
        Quick Dispatch
      </h3>

      {sent ? (
        <motion.div
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          className="py-6 text-center"
        >
          <motion.div
            animate={{ scale: [1, 1.2, 1] }}
            transition={{ duration: 0.4 }}
            className="text-2xl mb-2"
          >
            ⚡
          </motion.div>
          <p className="text-sm text-foreground font-medium">Dispatched to {selectedAgent.name}</p>
        </motion.div>
      ) : (
        <div className="space-y-3">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && dispatch()}
            placeholder="What needs to be done?"
            className="w-full bg-secondary/50 rounded-lg px-3 py-2 text-sm text-foreground placeholder:text-text-3 border border-border focus:border-primary/40 focus:outline-none"
          />

          <div className="flex gap-2 items-center">
            {/* Agent selector */}
            <select
              value={agentId}
              onChange={(e) => setAgentId(e.target.value)}
              className="flex-1 bg-secondary/50 text-foreground text-[11px] font-mono rounded-lg px-2 py-1.5 border border-border focus:outline-none focus:border-primary/40"
            >
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} — {a.role}
                </option>
              ))}
            </select>

            {/* Priority */}
            <div className="flex gap-1">
              {PRIORITIES.map((p) => (
                <button
                  key={p.id}
                  onClick={() => setPriority(p.id)}
                  className={`text-[9px] font-mono px-2 py-1 rounded-md border transition-all ${
                    priority === p.id
                      ? `${p.color} border-current bg-current/10`
                      : "text-text-3 border-border hover:text-text-2"
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>

            {/* Send */}
            <motion.button
              whileTap={{ scale: 0.9 }}
              onClick={dispatch}
              disabled={!title.trim()}
              className="w-8 h-8 rounded-lg bg-primary/20 flex items-center justify-center text-primary hover:bg-primary/30 transition-colors disabled:opacity-30"
            >
              <Send className="w-4 h-4" />
            </motion.button>
          </div>
        </div>
      )}
    </GlassCard>
  );
}
