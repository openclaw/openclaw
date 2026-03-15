import { motion, AnimatePresence } from "framer-motion";
import { X, Search, ChevronDown, ChevronUp, Users } from "lucide-react";
import { useState } from "react";
import {
  AGENT_DEFINITIONS,
  DIVISIONS,
  DIVISION_COLORS,
  getAgentsByDivision,
  getAllDivisionCounts,
  type Agent,
  type AgentDivision,
} from "@/lib/agents";
import { useAgentStore } from "@/store/agentStore";

// Division emoji map
const DIVISION_EMOJI: Record<AgentDivision, string> = {
  Core: "🦾",
  Engineering: "⚙️",
  Design: "🎨",
  Marketing: "📣",
  Product: "💡",
  "Project Management": "📋",
  Testing: "🧪",
  Support: "🎧",
  "Spatial Computing": "🥽",
  Specialized: "🎯",
};

function AgentCard({ agent, onClick }: { agent: Agent; onClick: () => void }) {
  const liveStatuses = useAgentStore((s) => s.agents);
  const liveAgent = liveStatuses.find((a) => a.id === agent.id);
  const status = liveAgent?.status ?? agent.status;

  const statusColor =
    status === "WORKING"
      ? "#22C55E"
      : status === "THINKING"
        ? "#F97316"
        : status === "ERROR"
          ? "#EF4444"
          : "#4B5563";

  return (
    <motion.button
      onClick={onClick}
      whileHover={{ scale: 1.02, y: -2 }}
      whileTap={{ scale: 0.98 }}
      className="w-full text-left p-4 rounded-xl border border-white/5 bg-white/[0.03] hover:bg-white/[0.07] hover:border-white/10 transition-all duration-200 group"
    >
      <div className="flex items-start gap-3">
        {/* Avatar / Emoji */}
        <div
          className="w-10 h-10 rounded-xl flex items-center justify-center text-lg shrink-0 border"
          style={{ backgroundColor: `${agent.color}18`, borderColor: `${agent.color}30` }}
        >
          {agent.emoji}
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5">
            <span className="text-sm font-semibold text-foreground truncate">{agent.role}</span>
            {/* Live status dot */}
            <span
              className="w-1.5 h-1.5 rounded-full shrink-0"
              style={{ backgroundColor: statusColor }}
            />
          </div>
          <p className="text-xs text-text-2 line-clamp-2 leading-relaxed">
            {agent.description ?? agent.capabilities.join(" · ")}
          </p>
          {/* Capabilities pills */}
          <div className="flex flex-wrap gap-1 mt-2">
            {agent.capabilities.slice(0, 3).map((cap) => (
              <span
                key={cap}
                className="text-[10px] px-1.5 py-0.5 rounded-md font-medium"
                style={{ backgroundColor: `${agent.color}15`, color: agent.color }}
              >
                {cap}
              </span>
            ))}
          </div>
        </div>
      </div>
    </motion.button>
  );
}

function AgentDetailModal({ agent, onClose }: { agent: Agent; onClose: () => void }) {
  const liveStatuses = useAgentStore((s) => s.agents);
  const liveAgent = liveStatuses.find((a) => a.id === agent.id);
  const status = liveAgent?.status ?? agent.status;

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <motion.div
        initial={{ scale: 0.9, opacity: 0, y: 20 }}
        animate={{ scale: 1, opacity: 1, y: 0 }}
        exit={{ scale: 0.9, opacity: 0, y: 20 }}
        transition={{ type: "spring", stiffness: 400, damping: 30 }}
        className="relative max-w-lg w-full rounded-2xl border border-white/10 bg-surface-0/95 backdrop-blur-xl shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header accent */}
        <div className="h-1 w-full" style={{ backgroundColor: agent.color }} />

        <div className="p-6">
          {/* Close */}
          <button
            onClick={onClose}
            className="absolute top-5 right-5 p-1.5 rounded-lg text-text-2 hover:text-foreground hover:bg-white/10 transition-all"
          >
            <X className="w-4 h-4" />
          </button>

          {/* Agent identity */}
          <div className="flex items-center gap-4 mb-5">
            <div
              className="w-14 h-14 rounded-2xl flex items-center justify-center text-2xl border-2"
              style={{ backgroundColor: `${agent.color}20`, borderColor: `${agent.color}50` }}
            >
              {agent.emoji}
            </div>
            <div>
              <h2 className="text-lg font-bold text-foreground">{agent.role}</h2>
              <div className="flex items-center gap-2 mt-0.5">
                <span
                  className="text-xs px-2 py-0.5 rounded-full font-medium"
                  style={{ backgroundColor: `${agent.color}20`, color: agent.color }}
                >
                  {agent.division}
                </span>
                <span className="text-xs text-text-2 font-mono">{agent.id}</span>
              </div>
            </div>
          </div>

          {/* Status */}
          <div className="flex items-center gap-2 mb-4 p-3 rounded-xl bg-white/5 border border-white/5">
            <span
              className={`w-2 h-2 rounded-full ${
                status === "WORKING"
                  ? "bg-green-400"
                  : status === "THINKING"
                    ? "bg-orange-400"
                    : status === "ERROR"
                      ? "bg-red-400"
                      : "bg-gray-500"
              }`}
            />
            <span className="text-xs text-text-2">{status}</span>
            {liveAgent?.currentTask && liveAgent.currentTask !== "Awaiting instructions" && (
              <span className="text-xs text-foreground ml-2 truncate">
                · {liveAgent.currentTask}
              </span>
            )}
          </div>

          {/* Description */}
          {agent.description && (
            <p className="text-sm text-text-2 leading-relaxed mb-4">{agent.description}</p>
          )}

          {/* Capabilities */}
          <div>
            <h3 className="text-xs font-semibold text-text-2 uppercase tracking-wider mb-2">
              Capabilities
            </h3>
            <div className="flex flex-wrap gap-2">
              {agent.capabilities.map((cap) => (
                <span
                  key={cap}
                  className="text-xs px-2.5 py-1 rounded-lg font-medium border"
                  style={{
                    backgroundColor: `${agent.color}15`,
                    borderColor: `${agent.color}30`,
                    color: agent.color,
                  }}
                >
                  {cap}
                </span>
              ))}
            </div>
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}

function DivisionSection({
  division,
  agents,
  defaultExpanded,
  onSelectAgent,
}: {
  division: AgentDivision;
  agents: Agent[];
  defaultExpanded: boolean;
  onSelectAgent: (a: Agent) => void;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const color = DIVISION_COLORS[division];
  const emoji = DIVISION_EMOJI[division];

  return (
    <div className="rounded-2xl border border-white/5 bg-white/[0.02] overflow-hidden">
      {/* Division header */}
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-3 px-5 py-4 hover:bg-white/5 transition-colors"
      >
        <div
          className="w-8 h-8 rounded-lg flex items-center justify-center text-base shrink-0"
          style={{ backgroundColor: `${color}20` }}
        >
          {emoji}
        </div>
        <div className="flex-1 text-left">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-foreground">{division}</span>
            <span
              className="text-xs px-1.5 py-0.5 rounded-md"
              style={{ backgroundColor: `${color}20`, color }}
            >
              {agents.length}
            </span>
          </div>
        </div>
        {expanded ? (
          <ChevronUp className="w-4 h-4 text-text-2" />
        ) : (
          <ChevronDown className="w-4 h-4 text-text-2" />
        )}
      </button>

      {/* Agent grid */}
      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
          >
            <div className="px-4 pb-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
              {agents.map((agent) => (
                <AgentCard key={agent.id} agent={agent} onClick={() => onSelectAgent(agent)} />
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export default function AgencyPage() {
  const [search, setSearch] = useState("");
  const [selectedDivision, setSelectedDivision] = useState<AgentDivision | "All">("All");
  const [selectedAgent, setSelectedAgent] = useState<Agent | null>(null);
  const counts = getAllDivisionCounts();

  const filtered = AGENT_DEFINITIONS.filter((a) => {
    const matchDiv = selectedDivision === "All" || a.division === selectedDivision;
    const q = search.toLowerCase();
    const matchSearch =
      !q ||
      a.role.toLowerCase().includes(q) ||
      a.name.toLowerCase().includes(q) ||
      a.description?.toLowerCase().includes(q) ||
      a.capabilities.some((c) => c.toLowerCase().includes(q));
    return matchDiv && matchSearch;
  });

  // Group by division for display
  const divisionGroups = DIVISIONS.map((div) => ({
    division: div,
    agents: filtered.filter((a) => a.division === div),
  })).filter((g) => g.agents.length > 0);

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Header */}
      <div className="glass-panel p-6">
        <div className="flex items-center gap-3 mb-1">
          <Users className="w-6 h-6 text-primary" />
          <h1 className="text-2xl font-bold text-foreground">The Agency</h1>
          <span className="text-sm text-text-2 ml-auto">
            {AGENT_DEFINITIONS.length} agents across {DIVISIONS.length} divisions
          </span>
        </div>
        <p className="text-text-2 text-sm">
          AI specialists ready to transform your workflow. Click any agent to view their profile.
        </p>
      </div>

      {/* Search + Division filter */}
      <div className="flex flex-col sm:flex-row gap-3">
        {/* Search */}
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-2 pointer-events-none" />
          <input
            type="text"
            placeholder="Search agents by name, role, or capability..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-9 pr-4 py-2.5 rounded-xl bg-white/5 border border-white/10 text-sm text-foreground placeholder-text-2 focus:outline-none focus:border-primary/50 transition-colors"
          />
        </div>

        {/* Division filter pills */}
        <div className="flex flex-wrap gap-1.5">
          <button
            onClick={() => setSelectedDivision("All")}
            className={`text-xs px-3 py-1.5 rounded-lg transition-all ${
              selectedDivision === "All"
                ? "bg-primary/20 text-primary border border-primary/30"
                : "bg-white/5 text-text-2 hover:text-foreground border border-white/5 hover:border-white/10"
            }`}
          >
            All ({AGENT_DEFINITIONS.length})
          </button>
          {DIVISIONS.map((div) => (
            <button
              key={div}
              onClick={() => setSelectedDivision(div === selectedDivision ? "All" : div)}
              className={`text-xs px-3 py-1.5 rounded-lg transition-all ${
                selectedDivision === div
                  ? "border"
                  : "bg-white/5 text-text-2 hover:text-foreground border border-white/5 hover:border-white/10"
              }`}
              style={
                selectedDivision === div
                  ? {
                      backgroundColor: `${DIVISION_COLORS[div]}20`,
                      color: DIVISION_COLORS[div],
                      borderColor: `${DIVISION_COLORS[div]}40`,
                    }
                  : {}
              }
            >
              {DIVISION_EMOJI[div]} {div} ({counts[div]})
            </button>
          ))}
        </div>
      </div>

      {/* Results count when searching */}
      {search && (
        <p className="text-sm text-text-2">
          {filtered.length} agent{filtered.length !== 1 ? "s" : ""} matching "{search}"
        </p>
      )}

      {/* Division sections */}
      <div className="space-y-3">
        {divisionGroups.map((g, i) => (
          <DivisionSection
            key={g.division}
            division={g.division}
            agents={g.agents}
            defaultExpanded={i === 0 || selectedDivision !== "All" || !!search}
            onSelectAgent={setSelectedAgent}
          />
        ))}
        {divisionGroups.length === 0 && (
          <div className="text-center py-16 text-text-2">
            <p className="text-lg mb-1">No agents found</p>
            <p className="text-sm">Try a different search term or division</p>
          </div>
        )}
      </div>

      {/* Agent detail modal */}
      <AnimatePresence>
        {selectedAgent && (
          <AgentDetailModal agent={selectedAgent} onClose={() => setSelectedAgent(null)} />
        )}
      </AnimatePresence>
    </div>
  );
}
