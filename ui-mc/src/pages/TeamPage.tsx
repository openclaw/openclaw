import { motion } from "framer-motion";
import { GlassCard } from "@/components/ui/GlassCard";
import { HeroSection } from "@/components/ui/HeroSection";
import { useTeamStore, Availability } from "@/store/teamStore";

const availColors: Record<Availability, string> = {
  available: "#30D158",
  busy: "#FF2D55",
  away: "#FFD60A",
  offline: "#8E8E93",
};

export default function TeamPage() {
  const members = useTeamStore((s) => s.members);

  return (
    <div className="space-y-6">
      <HeroSection title="Your Team" subtitle={`${members.length} collaborators`} />

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {members.map((member, i) => (
          <motion.div
            key={member.id}
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.05 }}
          >
            <GlassCard className="p-5">
              <div className="flex items-center gap-3 mb-4">
                <div className="relative">
                  <div className="w-12 h-12 rounded-full bg-secondary flex items-center justify-center text-sm font-bold text-text-2">
                    {member.avatar}
                  </div>
                  <span
                    className="absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 rounded-full border-2 border-void"
                    style={{ backgroundColor: availColors[member.availability] }}
                  />
                </div>
                <div>
                  <h4 className="text-sm font-medium text-foreground">{member.name}</h4>
                  <p className="text-[11px] text-text-2">{member.role}</p>
                </div>
                <span
                  className="ml-auto text-[10px] font-mono capitalize px-2 py-0.5 rounded-full"
                  style={{
                    backgroundColor: `${availColors[member.availability]}20`,
                    color: availColors[member.availability],
                  }}
                >
                  {member.availability}
                </span>
              </div>

              {/* Workload bar */}
              <div className="mb-3">
                <div className="flex items-center justify-between text-[10px] font-mono mb-1">
                  <span className="text-text-2">Workload</span>
                  <span className={member.workload > 80 ? "text-accent-red" : "text-primary"}>
                    {member.workload}%
                  </span>
                </div>
                <div className="h-1.5 bg-secondary rounded-full overflow-hidden">
                  <motion.div
                    className="h-full rounded-full"
                    style={{ backgroundColor: member.workload > 80 ? "#FF2D55" : "#00C8FF" }}
                    initial={{ width: 0 }}
                    animate={{ width: `${member.workload}%` }}
                    transition={{ duration: 0.8 }}
                  />
                </div>
              </div>

              <div className="flex items-center justify-between text-[11px]">
                <span className="text-text-2 font-mono">{member.activeTasks} active tasks</span>
                <span className="text-text-3 text-[10px]">{member.recentActivity}</span>
              </div>
            </GlassCard>
          </motion.div>
        ))}
      </div>
    </div>
  );
}
