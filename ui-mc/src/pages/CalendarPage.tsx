import { format, parseISO, isToday, isFuture, differenceInHours } from "date-fns";
import { motion } from "framer-motion";
import { Calendar as CalIcon, Clock, Users, Zap, User } from "lucide-react";
import { GlassCard } from "@/components/ui/GlassCard";
import { HeroSection } from "@/components/ui/HeroSection";
import { CalendarSkeleton } from "@/components/ui/skeleton";
import { useLoadingDelay } from "@/hooks/use-loading-delay";
import { useCalendarStore, EventType } from "@/store/calendarStore";

const typeConfig: Record<EventType, { icon: typeof CalIcon; color: string }> = {
  meeting: { icon: Users, color: "#00C8FF" },
  deadline: { icon: Clock, color: "#FF2D55" },
  personal: { icon: User, color: "#30D158" },
  workflow: { icon: Zap, color: "#FFD60A" },
};

export default function CalendarPage() {
  const loading = useLoadingDelay(750);
  const events = useCalendarStore((s) => s.events);
  const todayEvents = events
    .filter((e) => isToday(parseISO(e.date)))
    .toSorted((a, b) => a.time.localeCompare(b.time));
  const upcoming = events
    .filter((e) => isFuture(parseISO(e.date)) && !isToday(parseISO(e.date)))
    .toSorted((a, b) => a.date.localeCompare(b.date))
    .slice(0, 5);

  const nextEvent = [...todayEvents, ...upcoming][0];
  const nextCountdown = nextEvent
    ? `Next: ${nextEvent.title} in ${differenceInHours(parseISO(nextEvent.date + "T" + nextEvent.time), new Date())}h`
    : "No upcoming events";

  if (loading) {
    return (
      <div className="space-y-6 animate-fade-in">
        <div className="glass-panel p-6 space-y-2">
          <div className="animate-shimmer rounded-md bg-gradient-to-r from-secondary via-muted to-secondary bg-[length:200%_100%] h-8 w-1/3" />
          <div className="animate-shimmer rounded-md bg-gradient-to-r from-secondary via-muted to-secondary bg-[length:200%_100%] h-4 w-1/2" />
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <CalendarSkeleton />
          <CalendarSkeleton />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <HeroSection title={format(new Date(), "EEEE, MMMM d")} subtitle={nextCountdown} />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Today's Schedule */}
        <GlassCard className="p-5" hover={false}>
          <h3 className="text-sm font-medium text-foreground mb-4 flex items-center gap-2">
            <CalIcon className="w-4 h-4 text-primary" />
            Today's Schedule
          </h3>
          {todayEvents.length === 0 ? (
            <p className="text-sm text-text-2 font-mono">Nothing scheduled for today.</p>
          ) : (
            <div className="space-y-3">
              {todayEvents.map((event, i) => {
                const cfg = typeConfig[event.type];
                const Icon = cfg.icon;
                return (
                  <motion.div
                    key={event.id}
                    initial={{ opacity: 0, x: -10 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: i * 0.05 }}
                    className="flex items-start gap-3 p-3 rounded-lg bg-secondary/30"
                  >
                    <div className="text-[10px] font-mono text-text-2 w-12 shrink-0 pt-0.5">
                      {event.time}
                    </div>
                    <div
                      className="w-1 self-stretch rounded-full"
                      style={{ backgroundColor: cfg.color }}
                    />
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <Icon className="w-3.5 h-3.5" style={{ color: cfg.color }} />
                        <span className="text-sm font-medium text-foreground">{event.title}</span>
                      </div>
                      {event.description && (
                        <p className="text-[11px] text-text-2 mt-0.5">{event.description}</p>
                      )}
                      <div className="text-[10px] font-mono text-text-3 mt-1">
                        {event.agents.map((a) => a.toUpperCase()).join(", ")}
                      </div>
                    </div>
                  </motion.div>
                );
              })}
            </div>
          )}
        </GlassCard>

        {/* Upcoming */}
        <GlassCard className="p-5" hover={false}>
          <h3 className="text-sm font-medium text-foreground mb-4 flex items-center gap-2">
            <Clock className="w-4 h-4 text-accent-gold" />
            Upcoming Events
          </h3>
          <div className="space-y-3">
            {upcoming.map((event, i) => {
              const cfg = typeConfig[event.type];
              const Icon = cfg.icon;
              return (
                <motion.div
                  key={event.id}
                  initial={{ opacity: 0, x: -10 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: i * 0.05 }}
                  className="flex items-center gap-3 p-3 rounded-lg bg-secondary/30"
                >
                  <Icon className="w-4 h-4 shrink-0" style={{ color: cfg.color }} />
                  <div className="flex-1 min-w-0">
                    <span className="text-sm text-foreground">{event.title}</span>
                    <div className="text-[10px] font-mono text-text-3">
                      {format(parseISO(event.date), "MMM d")} at {event.time}
                    </div>
                  </div>
                  <span className="text-[10px] font-mono capitalize px-2 py-0.5 rounded-full bg-secondary text-text-2">
                    {event.type}
                  </span>
                </motion.div>
              );
            })}
          </div>
        </GlassCard>
      </div>
    </div>
  );
}
