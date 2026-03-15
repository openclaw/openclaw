import { formatDistanceToNow } from "date-fns";
import { motion, AnimatePresence } from "framer-motion";
import { Search, Radio, User, Bell, Sun, Moon } from "lucide-react";
import { useState } from "react";
import { NotificationDrawer } from "@/components/overlays/NotificationDrawer";
import { PingModal } from "@/components/overlays/PingModal";
import { useActivityStore } from "@/store/activityStore";
import { useAgentStore } from "@/store/agentStore";
import { useNotificationStore } from "@/store/notificationStore";
import { useUIStore } from "@/store/uiStore";

export function Topbar() {
  const agents = useAgentStore((s) => s.agents);
  const activeCount = agents.filter(
    (a) => a.status === "WORKING" || a.status === "THINKING",
  ).length;
  const { setSearchOpen, theme, toggleTheme } = useUIStore();
  const events = useActivityStore((s) => s.events);
  const unreadCount = useNotificationStore((s) => s.unreadCount);
  const [pingOpen, setPingOpen] = useState(false);
  const [activityOpen, setActivityOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);

  return (
    <>
      <header className="fixed top-0 left-0 right-0 h-14 z-50 bg-void/80 backdrop-blur-xl border-b border-border flex items-center px-3 sm:px-4 gap-2 sm:gap-4">
        {/* Logo */}
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-base sm:text-lg font-extralight tracking-[0.3em] text-foreground">
            MAVIS
          </span>
        </div>

        {/* Search — compact on mobile */}
        <div className="flex-1 flex justify-center min-w-0">
          <button
            onClick={() => setSearchOpen(true)}
            className="glass-pill flex items-center gap-2 px-3 sm:px-4 py-1.5 text-text-2 text-sm hover:border-border-glow transition-colors max-w-md w-full"
          >
            <Search className="w-4 h-4 shrink-0" />
            <span className="hidden sm:inline">Search anything...</span>
            <span className="sm:hidden">Search...</span>
            <kbd className="ml-auto text-[10px] font-mono bg-secondary px-1.5 py-0.5 rounded hidden sm:inline">
              ⌘K
            </kbd>
          </button>
        </div>

        {/* Right side */}
        <div className="flex items-center gap-1.5 sm:gap-3 shrink-0">
          {/* Ping — hide label on mobile */}
          <button
            onClick={() => setPingOpen(true)}
            className="glass-pill px-2 sm:px-3 py-1.5 text-xs font-mono text-primary hover:glow-accent transition-all flex items-center gap-1.5"
          >
            <Radio className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">PING</span>
          </button>

          {/* Live Activity — hide on mobile */}
          <div className="relative hidden sm:block">
            <button
              onClick={() => setActivityOpen(!activityOpen)}
              className="flex items-center gap-2 text-sm"
            >
              <span className="relative flex h-2 w-2">
                <span className="animate-ping-ring absolute inline-flex h-full w-full rounded-full bg-accent-green opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-accent-green" />
              </span>
              <span className="text-text-2 font-mono text-xs">{activeCount} active</span>
            </button>

            {/* Activity Dropdown */}
            <AnimatePresence>
              {activityOpen && (
                <motion.div
                  initial={{ opacity: 0, y: -10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -10 }}
                  className="absolute right-0 top-8 w-80 glass-panel p-3 max-h-64 overflow-y-auto scrollbar-thin"
                >
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-mono text-text-2">Live Activity</span>
                    <button
                      onClick={() => setActivityOpen(false)}
                      className="text-[10px] text-text-3 hover:text-foreground"
                    >
                      Close
                    </button>
                  </div>
                  {events.slice(0, 15).map((event) => (
                    <div key={event.id} className="flex items-start gap-2 py-1.5 text-xs">
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
                    </div>
                  ))}
                  {events.length === 0 && (
                    <p className="text-text-3 text-xs font-mono py-4 text-center">
                      No activity yet
                    </p>
                  )}
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {/* Notifications */}
          <button
            onClick={() => setNotifOpen(true)}
            className="relative p-1.5 rounded-lg hover:bg-secondary transition-colors"
          >
            <Bell className="w-4 h-4 text-muted-foreground" />
            {unreadCount() > 0 && (
              <motion.span
                initial={{ scale: 0 }}
                animate={{ scale: 1 }}
                className="absolute -top-0.5 -right-0.5 w-4 h-4 rounded-full bg-primary text-primary-foreground text-[9px] font-mono flex items-center justify-center"
              >
                {unreadCount() > 9 ? "9+" : unreadCount()}
              </motion.span>
            )}
          </button>

          {/* Theme Toggle */}
          <button
            onClick={toggleTheme}
            className="relative p-1.5 rounded-lg hover:bg-secondary transition-colors overflow-hidden"
          >
            <AnimatePresence mode="wait">
              {theme === "dark" ? (
                <motion.div
                  key="sun"
                  initial={{ rotate: -90, opacity: 0 }}
                  animate={{ rotate: 0, opacity: 1 }}
                  exit={{ rotate: 90, opacity: 0 }}
                  transition={{ duration: 0.2 }}
                >
                  <Sun className="w-4 h-4 text-accent-gold" />
                </motion.div>
              ) : (
                <motion.div
                  key="moon"
                  initial={{ rotate: 90, opacity: 0 }}
                  animate={{ rotate: 0, opacity: 1 }}
                  exit={{ rotate: -90, opacity: 0 }}
                  transition={{ duration: 0.2 }}
                >
                  <Moon className="w-4 h-4 text-primary" />
                </motion.div>
              )}
            </AnimatePresence>
          </button>

          <button className="w-8 h-8 rounded-full bg-secondary flex items-center justify-center">
            <User className="w-4 h-4 text-text-2" />
          </button>
        </div>
      </header>

      <PingModal open={pingOpen} onClose={() => setPingOpen(false)} />
      <NotificationDrawer open={notifOpen} onClose={() => setNotifOpen(false)} />
    </>
  );
}
