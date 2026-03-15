import { formatDistanceToNow } from "date-fns";
import { motion, AnimatePresence } from "framer-motion";
import { X, Bell, CheckCheck, Trash2 } from "lucide-react";
import { useNotificationStore } from "@/store/notificationStore";

interface NotificationDrawerProps {
  open: boolean;
  onClose: () => void;
}

export function NotificationDrawer({ open, onClose }: NotificationDrawerProps) {
  const notifications = useNotificationStore((s) => s.notifications);
  const markAllRead = useNotificationStore((s) => s.markAllRead);
  const markRead = useNotificationStore((s) => s.markRead);
  const clearAll = useNotificationStore((s) => s.clearAll);
  const unreadCount = useNotificationStore((s) => s.unreadCount);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-50 flex justify-end"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
        >
          <motion.div
            className="absolute inset-0 bg-background/60 backdrop-blur-sm"
            onClick={onClose}
          />

          <motion.div
            className="relative w-full max-w-sm h-full glass-panel rounded-none rounded-l-2xl border-l border-border overflow-hidden flex flex-col"
            initial={{ x: "100%" }}
            animate={{ x: 0 }}
            exit={{ x: "100%" }}
            transition={{ type: "spring", stiffness: 350, damping: 35 }}
          >
            {/* Header */}
            <div className="flex items-center justify-between p-4 border-b border-border">
              <div className="flex items-center gap-2">
                <Bell className="w-4 h-4 text-primary" />
                <h2 className="text-sm font-semibold text-foreground">Notifications</h2>
                {unreadCount() > 0 && (
                  <span className="text-[10px] font-mono bg-primary text-primary-foreground px-1.5 py-0.5 rounded-full">
                    {unreadCount()}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-1">
                <button
                  onClick={markAllRead}
                  className="p-1.5 rounded-lg hover:bg-secondary transition-colors"
                  title="Mark all read"
                >
                  <CheckCheck className="w-3.5 h-3.5 text-muted-foreground" />
                </button>
                <button
                  onClick={clearAll}
                  className="p-1.5 rounded-lg hover:bg-secondary transition-colors"
                  title="Clear all"
                >
                  <Trash2 className="w-3.5 h-3.5 text-muted-foreground" />
                </button>
                <button
                  onClick={onClose}
                  className="p-1.5 rounded-lg hover:bg-secondary transition-colors"
                >
                  <X className="w-4 h-4 text-muted-foreground" />
                </button>
              </div>
            </div>

            {/* Notification list */}
            <div className="flex-1 overflow-y-auto scrollbar-thin">
              <AnimatePresence>
                {notifications.map((n, i) => (
                  <motion.div
                    key={n.id}
                    initial={{ opacity: 0, x: 20 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: -20 }}
                    transition={{ delay: i * 0.02 }}
                    onClick={() => markRead(n.id)}
                    className={`flex items-start gap-3 px-4 py-3 border-b border-border/50 cursor-pointer transition-colors hover:bg-secondary/30 ${
                      !n.read ? "bg-primary/5" : ""
                    }`}
                  >
                    <div className="relative shrink-0 mt-0.5">
                      <div
                        className="w-7 h-7 rounded-full flex items-center justify-center text-[10px] font-bold"
                        style={{ backgroundColor: `${n.agentColor}20`, color: n.agentColor }}
                      >
                        {n.agentName.charAt(0)}
                      </div>
                      {!n.read && (
                        <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-primary" />
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs text-foreground">
                        <span className="font-semibold">{n.agentName}</span>{" "}
                        <span className="text-muted-foreground">{n.message}</span>
                      </p>
                      <p className="text-[10px] font-mono text-muted-foreground mt-0.5">
                        {formatDistanceToNow(new Date(n.timestamp), { addSuffix: true })}
                      </p>
                    </div>
                  </motion.div>
                ))}
              </AnimatePresence>

              {notifications.length === 0 && (
                <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
                  <Bell className="w-8 h-8 mb-2 opacity-30" />
                  <p className="text-xs font-mono">No notifications yet</p>
                </div>
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
