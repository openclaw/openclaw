import { motion } from "framer-motion";
import { Terminal, BookOpen, ChevronRight } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { AgentCommandPanel } from "@/components/office/AgentCommandPanel";
import { AgentDeskCard } from "@/components/office/AgentDeskCard";
import { AgentProfilePanel } from "@/components/office/AgentProfilePanel";
import { CollaborationGraph } from "@/components/office/CollaborationGraph";
import { EventFeed } from "@/components/office/EventFeed";
import { KnowledgeManager } from "@/components/office/KnowledgeManager";
import { QuickDispatch } from "@/components/office/QuickDispatch";
import { SystemHealth } from "@/components/office/SystemHealth";
import { HeroSection } from "@/components/ui/HeroSection";
import { OfficePageSkeleton } from "@/components/ui/skeleton";
import { useLoadingDelay } from "@/hooks/use-loading-delay";
import { DIVISIONS, DIVISION_COLORS, type AgentDivision } from "@/lib/agents";
import type { Agent } from "@/lib/agents";
import { useAgentStore } from "@/store/agentStore";

const ALL_DIVISIONS: Array<AgentDivision | "All"> = ["All", ...DIVISIONS];

export default function OfficePage() {
  const navigate = useNavigate();
  const agents = useAgentStore((s) => s.agents);
  const activeCount = agents.filter(
    (a) => a.status === "WORKING" || a.status === "THINKING",
  ).length;
  const [selectedAgent, setSelectedAgent] = useState<Agent | null>(null);
  const [commandOpen, setCommandOpen] = useState(false);
  const [knowledgeOpen, setKnowledgeOpen] = useState(false);
  const [divisionFilter, setDivisionFilter] = useState<AgentDivision | "All">("Core");
  const loading = useLoadingDelay(900);

  const filteredAgents =
    divisionFilter === "All" ? agents : agents.filter((a) => a.division === divisionFilter);

  if (loading) {
    return <OfficePageSkeleton />;
  }

  return (
    <div className="space-y-4 sm:space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <HeroSection
          title="Mission Control"
          subtitle={`${activeCount} agents active · ${agents.length} total agents`}
        />
        <div className="flex gap-2 w-full sm:w-auto">
          <motion.button
            onClick={() => setKnowledgeOpen(true)}
            className="flex items-center justify-center gap-1.5 px-4 py-2 rounded-xl bg-secondary text-foreground text-xs font-mono hover:bg-secondary/80 transition-colors shrink-0 flex-1 sm:flex-none"
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
          >
            <BookOpen className="w-3.5 h-3.5" /> Knowledge
          </motion.button>
          <motion.button
            onClick={() => setCommandOpen(true)}
            className="flex items-center justify-center gap-1.5 px-4 py-2 rounded-xl bg-primary text-primary-foreground text-xs font-mono hover:bg-primary/90 transition-colors shrink-0 flex-1 sm:flex-none"
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
          >
            <Terminal className="w-3.5 h-3.5" /> Command
          </motion.button>
        </div>
      </div>

      {/* Division filter bar */}
      <div className="flex items-center gap-2 overflow-x-auto scrollbar-thin pb-1">
        {ALL_DIVISIONS.map((div) => {
          const color = div === "All" ? "#6B7280" : DIVISION_COLORS[div];
          const isActive = divisionFilter === div;
          const count =
            div === "All" ? agents.length : agents.filter((a) => a.division === div).length;
          return (
            <button
              key={div}
              onClick={() => setDivisionFilter(div)}
              className="shrink-0 text-xs px-3 py-1.5 rounded-lg transition-all border"
              style={
                isActive
                  ? { backgroundColor: `${color}20`, color, borderColor: `${color}40` }
                  : {
                      backgroundColor: "transparent",
                      color: "#6B7280",
                      borderColor: "rgba(255,255,255,0.05)",
                    }
              }
            >
              {div} ({count})
            </button>
          );
        })}
        {/* Link to full Agency view */}
        <button
          onClick={() => navigate("/agency")}
          className="shrink-0 flex items-center gap-1 text-xs px-3 py-1.5 rounded-lg text-primary/70 hover:text-primary border border-transparent hover:border-primary/20 transition-all ml-auto"
        >
          Full Agency <ChevronRight className="w-3 h-3" />
        </button>
      </div>

      {/* Agent Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3 sm:gap-4">
        {filteredAgents.map((agent, i) => (
          <AgentDeskCard key={agent.id} agent={agent} index={i} onAvatarClick={setSelectedAgent} />
        ))}
      </div>

      {/* Collaboration Network */}
      <div className="hidden sm:block">
        <CollaborationGraph />
      </div>

      {/* Bottom widgets */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4">
        <EventFeed />
        <SystemHealth />
        <div className="sm:col-span-2 lg:col-span-1">
          <QuickDispatch />
        </div>
      </div>

      {selectedAgent && (
        <AgentProfilePanel
          agent={agents.find((a) => a.id === selectedAgent.id) || selectedAgent}
          onClose={() => setSelectedAgent(null)}
        />
      )}

      <AgentCommandPanel open={commandOpen} onClose={() => setCommandOpen(false)} />
      <KnowledgeManager open={knowledgeOpen} onClose={() => setKnowledgeOpen(false)} />
    </div>
  );
}
