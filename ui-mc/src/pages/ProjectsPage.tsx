import { motion } from "framer-motion";
import { CheckCircle2, Circle, AlertTriangle, XCircle } from "lucide-react";
import { GlassCard } from "@/components/ui/GlassCard";
import { HeroSection } from "@/components/ui/HeroSection";
import { ProjectCardSkeleton } from "@/components/ui/skeleton";
import { useLoadingDelay } from "@/hooks/use-loading-delay";
import { useAgentStore } from "@/store/agentStore";
import { useProjectStore, ProjectHealth } from "@/store/projectStore";

const healthConfig: Record<
  ProjectHealth,
  { label: string; color: string; icon: typeof CheckCircle2 }
> = {
  on_track: { label: "On Track", color: "#30D158", icon: CheckCircle2 },
  at_risk: { label: "At Risk", color: "#FFD60A", icon: AlertTriangle },
  blocked: { label: "Blocked", color: "#FF2D55", icon: XCircle },
};

export default function ProjectsPage() {
  const loading = useLoadingDelay(800);
  const projects = useProjectStore((s) => s.projects);
  const toggleMilestone = useProjectStore((s) => s.toggleMilestone);
  const running = projects.filter((p) => p.health === "on_track").length;
  const blocked = projects.filter((p) => p.health === "blocked").length;

  if (loading) {
    return (
      <div className="space-y-6 animate-fade-in">
        <div className="glass-panel p-6 space-y-2">
          <div className="animate-shimmer rounded-md bg-gradient-to-r from-secondary via-muted to-secondary bg-[length:200%_100%] h-8 w-1/4" />
          <div className="animate-shimmer rounded-md bg-gradient-to-r from-secondary via-muted to-secondary bg-[length:200%_100%] h-4 w-1/2" />
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {[1, 2, 3].map((i) => (
            <ProjectCardSkeleton key={i} />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <HeroSection
        title="Active Projects"
        subtitle={`${running} running · ${projects.length - running - blocked} at risk · ${blocked} blocked`}
      />

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {projects.map((project, i) => {
          const hc = healthConfig[project.health];
          const HealthIcon = hc.icon;
          const circumference = 2 * Math.PI * 36;
          const offset = circumference - (project.progress / 100) * circumference;

          return (
            <motion.div
              key={project.id}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.05 }}
            >
              <GlassCard className="p-5">
                <div className="flex items-start gap-4">
                  {/* Progress ring */}
                  <div className="relative w-20 h-20 shrink-0">
                    <svg className="w-20 h-20 -rotate-90" viewBox="0 0 80 80">
                      <circle
                        cx="40"
                        cy="40"
                        r="36"
                        fill="none"
                        stroke="hsl(var(--secondary))"
                        strokeWidth="4"
                      />
                      <motion.circle
                        cx="40"
                        cy="40"
                        r="36"
                        fill="none"
                        stroke={project.color}
                        strokeWidth="4"
                        strokeLinecap="round"
                        strokeDasharray={circumference}
                        initial={{ strokeDashoffset: circumference }}
                        animate={{ strokeDashoffset: offset }}
                        transition={{ duration: 1, ease: "easeOut" }}
                      />
                    </svg>
                    <div className="absolute inset-0 flex items-center justify-center">
                      <span
                        className="text-sm font-bold font-mono"
                        style={{ color: project.color }}
                      >
                        {project.progress}%
                      </span>
                    </div>
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <h4 className="text-base font-bold text-foreground">{project.name}</h4>
                      <span
                        className="flex items-center gap-1 text-[10px] font-mono px-2 py-0.5 rounded-full"
                        style={{ backgroundColor: `${hc.color}20`, color: hc.color }}
                      >
                        <HealthIcon className="w-3 h-3" />
                        {hc.label}
                      </span>
                    </div>
                    <p className="text-[11px] text-text-2 mt-1 line-clamp-2">
                      {project.description}
                    </p>
                    <div className="flex gap-1 mt-2">
                      {project.agents.map((agentId) => (
                        <span
                          key={agentId}
                          className="text-[9px] font-mono font-bold px-1.5 py-0.5 rounded bg-secondary text-text-2"
                        >
                          {agentId.toUpperCase()}
                        </span>
                      ))}
                    </div>
                  </div>
                </div>

                {/* Milestones */}
                <div className="mt-4 space-y-2">
                  {project.milestones.map((ms) => (
                    <button
                      key={ms.id}
                      onClick={() => toggleMilestone(project.id, ms.id)}
                      className="flex items-center gap-2 w-full text-left group/ms"
                    >
                      {ms.done ? (
                        <CheckCircle2 className="w-4 h-4 text-accent-green shrink-0" />
                      ) : (
                        <Circle className="w-4 h-4 text-text-3 shrink-0 group-hover/ms:text-text-2 transition-colors" />
                      )}
                      <span
                        className={`text-[11px] flex-1 ${ms.done ? "text-text-3 line-through" : "text-text-2"}`}
                      >
                        {ms.title}
                      </span>
                      <span className="text-[10px] font-mono text-text-3">{ms.dueDate}</span>
                    </button>
                  ))}
                </div>
              </GlassCard>
            </motion.div>
          );
        })}
      </div>
    </div>
  );
}
