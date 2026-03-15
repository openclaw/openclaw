import { motion } from "framer-motion";
import { MessageCircle, Flame, Users, Mic, Droplets } from "lucide-react";
import { useAgentStore } from "@/store/agentStore";
import { useUIStore, WorkMode } from "@/store/uiStore";

const MODES: { id: WorkMode; icon: typeof Flame; label: string }[] = [
  { id: "working", icon: Flame, label: "Working" },
  { id: "gather", icon: Users, label: "Gather" },
  { id: "meeting", icon: Mic, label: "Run Meeting" },
  { id: "cooler", icon: Droplets, label: "Water Cooler" },
];

export function BottomDock() {
  const { workMode, setWorkMode, setChatOpen, chatOpen } = useUIStore();
  const agents = useAgentStore((s) => s.agents);
  const workingAgents = agents.filter((a) => a.status === "WORKING" || a.status === "THINKING");

  return (
    <footer className="fixed bottom-0 left-0 right-0 h-16 z-50 bg-void/80 backdrop-blur-xl border-t border-border flex items-center px-4 gap-4">
      {/* Start Chat */}
      <button
        onClick={() => setChatOpen(!chatOpen)}
        className={`glass-pill flex items-center gap-2 px-4 py-2 text-sm font-medium transition-all ${chatOpen ? "text-primary glow-accent" : "text-primary hover:glow-accent"}`}
      >
        <MessageCircle className="w-4 h-4" />
        Start Chat
      </button>

      {/* Mode Strip */}
      <div className="flex-1 flex justify-center">
        <div className="flex gap-2">
          {MODES.map((mode) => (
            <button
              key={mode.id}
              onClick={() => setWorkMode(mode.id)}
              className={`relative flex items-center gap-2 px-4 py-2 rounded-full text-xs font-medium transition-all ${
                workMode === mode.id ? "text-primary" : "text-text-2 hover:text-foreground"
              }`}
            >
              {workMode === mode.id && (
                <motion.div
                  layoutId="dock-mode"
                  className="absolute inset-0 glass-pill border-primary/30"
                  transition={{ type: "spring", stiffness: 500, damping: 30 }}
                />
              )}
              <mode.icon className="w-3.5 h-3.5 relative z-10" />
              <span className="relative z-10">{mode.label}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Active Agents */}
      <div className="flex items-center gap-2">
        <div className="flex -space-x-2">
          {workingAgents.slice(0, 4).map((agent) => (
            <div
              key={agent.id}
              className="w-7 h-7 rounded-full border-2 border-void bg-secondary flex items-center justify-center text-[10px] font-bold"
              style={{ color: agent.color }}
              title={agent.name}
            >
              {agent.shortCode}
            </div>
          ))}
        </div>
        <span className="text-[10px] text-text-2 font-mono">{workingAgents.length} working</span>
      </div>
    </footer>
  );
}
