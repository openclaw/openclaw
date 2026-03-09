import { motion } from "framer-motion";
import {
  Building2,
  CheckSquare,
  FileText,
  ThumbsUp,
  Sparkles,
  Calendar,
  FolderKanban,
  Brain,
  File,
  Users,
  UsersRound,
  Settings,
  BarChart3,
  BriefcaseBusiness,
  BookOpen,
} from "lucide-react";
import { useNavigate, useLocation } from "react-router-dom";

import { Cpu } from "lucide-react";

const NAV_ITEMS = [
  { icon: Cpu, label: "Mission Control", path: "/oko" },
  { icon: Building2, label: "Office", path: "/office" },
  { icon: BriefcaseBusiness, label: "Agency", path: "/agency" },
  { icon: BookOpen, label: "Playbooks", path: "/playbooks" },
  { icon: CheckSquare, label: "Tasks", path: "/tasks" },
  { icon: FileText, label: "Content", path: "/content" },
  { icon: ThumbsUp, label: "Approvals", path: "/approvals" },
  { icon: Sparkles, label: "Council", path: "/council" },
  { icon: Calendar, label: "Calendar", path: "/calendar" },
  { icon: FolderKanban, label: "Projects", path: "/projects" },
  { icon: Brain, label: "Memory", path: "/memory" },
  { icon: File, label: "Docs", path: "/docs" },
  { icon: Users, label: "People", path: "/people" },
  { icon: UsersRound, label: "Team", path: "/team" },
  { icon: BarChart3, label: "Analytics", path: "/analytics" },
];

export function Sidebar() {
  const navigate = useNavigate();
  const location = useLocation();

  return (
    <aside className="fixed left-0 top-14 bottom-16 w-16 hover:w-48 transition-all duration-300 z-40 bg-surface-0/80 backdrop-blur-xl border-r border-border overflow-hidden group max-md:hidden">
      <nav className="flex flex-col gap-1 p-2 h-full">
        <div className="flex-1 flex flex-col gap-1">
          {NAV_ITEMS.map((item) => {
            const isActive = location.pathname === item.path;
            return (
              <button
                key={item.path}
                onClick={() => navigate(item.path)}
                className={`flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all duration-200 relative ${
                  isActive
                    ? "text-primary bg-primary/10"
                    : "text-text-2 hover:text-foreground hover:bg-secondary"
                }`}
              >
                {isActive && (
                  <motion.div
                    layoutId="sidebar-active"
                    className="absolute left-0 top-0 bottom-0 w-0.5 bg-primary rounded-r"
                    transition={{ type: "spring", stiffness: 500, damping: 30 }}
                  />
                )}
                <item.icon className="w-5 h-5 shrink-0" />
                <span className="text-sm font-medium whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity duration-200">
                  {item.label}
                </span>
              </button>
            );
          })}
        </div>
        <button
          onClick={() => navigate("/controls")}
          className={`flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all duration-200 ${
            location.pathname === "/controls"
              ? "text-primary bg-primary/10"
              : "text-text-2 hover:text-foreground hover:bg-secondary"
          }`}
        >
          <Settings className="w-5 h-5 shrink-0" />
          <span className="text-sm font-medium whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity duration-200">
            Controls
          </span>
        </button>
      </nav>
    </aside>
  );
}
