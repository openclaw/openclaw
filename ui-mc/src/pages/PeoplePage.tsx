import { differenceInDays, parseISO } from "date-fns";
import { motion } from "framer-motion";
import { MessageCircle, StickyNote, Heart, AlertCircle } from "lucide-react";
import { GlassCard } from "@/components/ui/GlassCard";
import { HeroSection } from "@/components/ui/HeroSection";
import { usePeopleStore, RelationshipType } from "@/store/peopleStore";

const relColors: Record<RelationshipType, string> = {
  client: "#00C8FF",
  partner: "#30D158",
  investor: "#FFD60A",
  colleague: "#BF5AF2",
  friend: "#FF6B35",
  family: "#FF2D55",
};

export default function PeoplePage() {
  const people = usePeopleStore((s) => s.people);
  const stale = people.filter(
    (p) => differenceInDays(new Date(), parseISO(p.lastInteraction)) > 30,
  );

  return (
    <div className="space-y-6">
      <HeroSection
        title="Your Network"
        subtitle={`${people.length} contacts · ${stale.length} need attention`}
      />

      {/* Stale Warning */}
      {stale.length > 0 && (
        <GlassCard className="p-4 border-accent-red/30" hover={false}>
          <div className="flex items-center gap-2 mb-2">
            <AlertCircle className="w-4 h-4 text-accent-red" />
            <h3 className="text-sm font-medium text-accent-red">Needs Reconnection</h3>
          </div>
          <div className="flex gap-2 flex-wrap">
            {stale.map((p) => (
              <span
                key={p.id}
                className="text-[11px] font-mono px-2 py-1 rounded-lg bg-accent-red/10 text-accent-red"
              >
                {p.name} — {differenceInDays(new Date(), parseISO(p.lastInteraction))}d ago
              </span>
            ))}
          </div>
        </GlassCard>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {people.map((person, i) => {
          const daysSince = differenceInDays(new Date(), parseISO(person.lastInteraction));
          const color = relColors[person.relationship];
          return (
            <motion.div
              key={person.id}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.05 }}
            >
              <GlassCard className="p-4">
                <div className="flex items-start gap-3">
                  <div
                    className="w-12 h-12 rounded-full flex items-center justify-center text-lg font-bold shrink-0"
                    style={{ backgroundColor: `${color}20`, color }}
                  >
                    {person.name.charAt(0)}
                  </div>
                  <div className="flex-1 min-w-0">
                    <h4 className="text-sm font-medium text-foreground">{person.name}</h4>
                    <p className="text-[11px] text-text-2">
                      {person.role} · {person.company}
                    </p>
                    <p className="text-[11px] text-text-3 mt-1">{person.notes}</p>
                    <div className="flex items-center gap-2 mt-2">
                      <span
                        className="text-[9px] font-mono px-1.5 py-0.5 rounded-full capitalize"
                        style={{ backgroundColor: `${color}20`, color }}
                      >
                        {person.relationship}
                      </span>
                      <span className="text-[10px] font-mono text-text-3">
                        {daysSince === 0 ? "Today" : `${daysSince}d ago`}
                      </span>
                      <div className="flex gap-0.5 ml-auto">
                        {Array.from({ length: 5 }).map((_, idx) => (
                          <Heart
                            key={idx}
                            className={`w-3 h-3 ${idx < person.health ? "text-accent-red fill-accent-red" : "text-text-3"}`}
                          />
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
                <div className="flex gap-2 mt-3">
                  <button className="flex-1 glass-pill text-center py-1.5 text-[10px] font-mono text-primary hover:bg-primary/10 transition-colors flex items-center justify-center gap-1">
                    <MessageCircle className="w-3 h-3" /> Message
                  </button>
                  <button className="flex-1 glass-pill text-center py-1.5 text-[10px] font-mono text-text-2 hover:text-foreground transition-colors flex items-center justify-center gap-1">
                    <StickyNote className="w-3 h-3" /> Add Note
                  </button>
                </div>
              </GlassCard>
            </motion.div>
          );
        })}
      </div>
    </div>
  );
}
