import { formatDistanceToNow } from "date-fns";
import { motion, AnimatePresence } from "framer-motion";
import { GlassCard } from "@/components/ui/GlassCard";
import { useActivityStore } from "@/store/activityStore";

export function EventFeed() {
  const events = useActivityStore((s) => s.events);

  return (
    <GlassCard className="p-4 h-full" hover={false}>
      <h3 className="text-sm font-medium text-foreground mb-3 flex items-center gap-2">
        <span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse-glow" />
        Live Activity
      </h3>
      <div className="space-y-2 max-h-64 overflow-y-auto scrollbar-thin">
        <AnimatePresence mode="popLayout">
          {events.length === 0 ? (
            <p className="text-text-2 text-xs font-mono">Waiting for activity...</p>
          ) : (
            events.slice(0, 20).map((event) => (
              <motion.div
                key={event.id}
                initial={{ opacity: 0, x: -10 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0 }}
                className="flex items-start gap-2 text-xs"
              >
                <span
                  className="w-2 h-2 rounded-full mt-1 shrink-0"
                  style={{ backgroundColor: event.agentColor }}
                />
                <div className="flex-1 min-w-0">
                  <span className="font-bold text-foreground">{event.agentName}</span>{" "}
                  <span className="text-text-2">{event.action}</span>
                </div>
                <span className="text-text-3 font-mono text-[10px] shrink-0">
                  {formatDistanceToNow(event.timestamp, { addSuffix: true })}
                </span>
              </motion.div>
            ))
          )}
        </AnimatePresence>
      </div>
    </GlassCard>
  );
}
