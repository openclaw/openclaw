import { motion } from "framer-motion";
import { Users } from "lucide-react";
import { useMemo } from "react";
import { avatarMap } from "@/lib/avatars";
import { useAgentStore } from "@/store/agentStore";
import { useTaskStore } from "@/store/taskStore";

interface CollaborationIndicatorProps {
  agentId: string;
}

export function CollaborationIndicator({ agentId }: CollaborationIndicatorProps) {
  const tasks = useTaskStore((s) => s.tasks);
  const agents = useAgentStore((s) => s.agents);

  const collaborators = useMemo(() => {
    // Find projects this agent is working on
    const agentTasks = tasks.filter((t) => t.assignedAgent === agentId && t.project);
    const agentProjects = new Set(agentTasks.map((t) => t.project));

    if (agentProjects.size === 0) {
      return [];
    }

    // Find other agents sharing those projects
    const collabIds = new Set<string>();
    tasks.forEach((t) => {
      if (t.project && agentProjects.has(t.project) && t.assignedAgent !== agentId) {
        collabIds.add(t.assignedAgent);
      }
    });

    return agents.filter((a) => collabIds.has(a.id));
  }, [tasks, agents, agentId]);

  if (collaborators.length === 0) {
    return null;
  }

  return (
    <motion.div
      className="flex items-center gap-1.5"
      initial={{ opacity: 0, scale: 0.8 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ delay: 0.3 }}
    >
      <Users className="w-3 h-3 text-muted-foreground" />
      <div className="flex -space-x-2">
        {collaborators.slice(0, 4).map((collab, i) => (
          <motion.div
            key={collab.id}
            className="relative"
            initial={{ opacity: 0, x: -5 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: 0.35 + i * 0.06 }}
          >
            <img
              src={avatarMap[collab.id]}
              alt={collab.name}
              className="w-5 h-5 rounded-full border border-border object-cover bg-card"
              title={collab.name}
            />
            {(collab.status === "WORKING" || collab.status === "THINKING") && (
              <span
                className="absolute -bottom-0.5 -right-0.5 w-2 h-2 rounded-full border border-card"
                style={{ backgroundColor: collab.color }}
              />
            )}
          </motion.div>
        ))}
        {collaborators.length > 4 && (
          <div className="w-5 h-5 rounded-full border border-border bg-secondary flex items-center justify-center">
            <span className="text-[7px] font-mono text-muted-foreground">
              +{collaborators.length - 4}
            </span>
          </div>
        )}
      </div>
      <span className="text-[9px] font-mono text-muted-foreground ml-0.5">collab</span>
    </motion.div>
  );
}
