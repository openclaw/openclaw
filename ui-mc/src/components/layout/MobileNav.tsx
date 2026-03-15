import { motion, AnimatePresence } from "framer-motion";
import {
  Cpu,
  Building2,
  CheckSquare,
  Calendar,
  FolderKanban,
  BarChart3,
  MoreHorizontal,
  FileText,
  ThumbsUp,
  Sparkles,
  Brain,
  File,
  Users,
  UsersRound,
  Settings,
  X,
} from "lucide-react";
import { useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";

const MOBILE_NAV = [
  { icon: Cpu, label: "Control", path: "/oko" },
  { icon: Building2, label: "Office", path: "/office" },
  { icon: CheckSquare, label: "Tasks", path: "/tasks" },
  { icon: Calendar, label: "Calendar", path: "/calendar" },
  { icon: FolderKanban, label: "Projects", path: "/projects" },
];

const MORE_NAV = [
  { icon: BarChart3, label: "Analytics", path: "/analytics" },
  { icon: FileText, label: "Content", path: "/content" },
  { icon: ThumbsUp, label: "Approvals", path: "/approvals" },
  { icon: Sparkles, label: "Council", path: "/council" },
  { icon: Brain, label: "Memory", path: "/memory" },
  { icon: File, label: "Docs", path: "/docs" },
  { icon: Users, label: "People", path: "/people" },
  { icon: UsersRound, label: "Team", path: "/team" },
  { icon: Settings, label: "Controls", path: "/controls" },
];

export function MobileNav() {
  const navigate = useNavigate();
  const location = useLocation();
  const [moreOpen, setMoreOpen] = useState(false);
  const isMoreActive = MORE_NAV.some((item) => location.pathname === item.path);

  return (
    <>
      <nav className="fixed bottom-0 left-0 right-0 h-14 z-50 bg-void/90 backdrop-blur-xl border-t border-border md:hidden flex items-center justify-around px-1 safe-area-bottom">
        {MOBILE_NAV.map((item) => {
          const isActive = location.pathname === item.path;
          return (
            <motion.button
              key={item.path}
              onClick={() => navigate(item.path)}
              whileTap={{ scale: 0.85 }}
              transition={{ type: "spring", stiffness: 500, damping: 20 }}
              className={`flex flex-col items-center gap-0.5 py-1 px-3 rounded-lg transition-colors relative ${
                isActive ? "text-primary" : "text-muted-foreground"
              }`}
            >
              {isActive && (
                <motion.div
                  layoutId="mobile-nav-active"
                  className="absolute -top-0.5 w-4 h-0.5 bg-primary rounded-full"
                  transition={{ type: "spring", stiffness: 500, damping: 30 }}
                />
              )}
              <item.icon className="w-5 h-5" />
              <span className="text-[9px] font-mono">{item.label}</span>
            </motion.button>
          );
        })}
        {/* More button */}
        <motion.button
          onClick={() => setMoreOpen(true)}
          whileTap={{ scale: 0.85 }}
          transition={{ type: "spring", stiffness: 500, damping: 20 }}
          className={`flex flex-col items-center gap-0.5 py-1 px-3 rounded-lg transition-colors relative ${
            isMoreActive ? "text-primary" : "text-muted-foreground"
          }`}
        >
          {isMoreActive && (
            <motion.div
              layoutId="mobile-nav-active"
              className="absolute -top-0.5 w-4 h-0.5 bg-primary rounded-full"
              transition={{ type: "spring", stiffness: 500, damping: 30 }}
            />
          )}
          <MoreHorizontal className="w-5 h-5" />
          <span className="text-[9px] font-mono">More</span>
        </motion.button>
      </nav>

      {/* More drawer */}
      <AnimatePresence>
        {moreOpen && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 z-[60] bg-void/60 backdrop-blur-sm md:hidden"
              onClick={() => setMoreOpen(false)}
            />
            <motion.div
              initial={{ y: "100%" }}
              animate={{ y: 0 }}
              exit={{ y: "100%" }}
              transition={{ type: "spring", stiffness: 400, damping: 35 }}
              drag="y"
              dragConstraints={{ top: 0, bottom: 0 }}
              dragElastic={{ top: 0, bottom: 0.6 }}
              onDragEnd={(_, info) => {
                if (info.offset.y > 80 || info.velocity.y > 300) {
                  setMoreOpen(false);
                }
              }}
              className="fixed bottom-0 left-0 right-0 z-[61] glass-panel rounded-t-2xl p-4 pb-8 md:hidden max-h-[70vh] overflow-y-auto touch-none"
            >
              {/* Drag handle */}
              <div className="flex justify-center mb-3">
                <div className="w-10 h-1 rounded-full bg-muted-foreground/30" />
              </div>
              <div className="flex items-center justify-between mb-4">
                <span className="text-sm font-medium text-foreground">More</span>
                <button
                  onClick={() => setMoreOpen(false)}
                  className="p-1 rounded-lg hover:bg-secondary transition-colors"
                >
                  <X className="w-4 h-4 text-muted-foreground" />
                </button>
              </div>
              <div className="grid grid-cols-3 gap-2">
                {MORE_NAV.map((item) => {
                  const isActive = location.pathname === item.path;
                  return (
                    <motion.button
                      key={item.path}
                      onClick={() => {
                        navigate(item.path);
                        setMoreOpen(false);
                      }}
                      whileTap={{ scale: 0.9 }}
                      transition={{ type: "spring", stiffness: 500, damping: 20 }}
                      className={`flex flex-col items-center gap-1.5 p-3 rounded-xl transition-colors ${
                        isActive
                          ? "bg-primary/10 text-primary"
                          : "text-muted-foreground hover:bg-secondary hover:text-foreground"
                      }`}
                    >
                      <item.icon className="w-5 h-5" />
                      <span className="text-[10px] font-mono">{item.label}</span>
                    </motion.button>
                  );
                })}
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </>
  );
}
