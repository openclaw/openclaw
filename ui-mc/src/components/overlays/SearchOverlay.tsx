import { motion, AnimatePresence } from "framer-motion";
import {
  Search,
  X,
  Users,
  CheckSquare,
  FolderKanban,
  Brain,
  User,
  Building2,
  FileText,
  ThumbsUp,
  Sparkles,
  Calendar,
  File,
  UsersRound,
  BarChart3,
  Settings,
  ArrowRight,
} from "lucide-react";
import { useEffect, useCallback, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAgentStore } from "@/store/agentStore";
import { useMemoryStore } from "@/store/memoryStore";
import { usePeopleStore } from "@/store/peopleStore";
import { useProjectStore } from "@/store/projectStore";
import { useTaskStore } from "@/store/taskStore";
import { useUIStore } from "@/store/uiStore";

type ResultType = "page" | "agent" | "task" | "project" | "memory" | "person";

interface SearchResult {
  type: ResultType;
  id: string;
  title: string;
  subtitle: string;
  color: string;
  route: string;
  score: number;
}

const PAGES = [
  {
    id: "office",
    title: "Office",
    subtitle: "Agent headquarters",
    icon: Building2,
    route: "/office",
    color: "#00C8FF",
  },
  {
    id: "tasks",
    title: "Tasks",
    subtitle: "Task queue & kanban",
    icon: CheckSquare,
    route: "/tasks",
    color: "#00C8FF",
  },
  {
    id: "content",
    title: "Content",
    subtitle: "Content management",
    icon: FileText,
    route: "/content",
    color: "#BF5AF2",
  },
  {
    id: "approvals",
    title: "Approvals",
    subtitle: "Pending approvals",
    icon: ThumbsUp,
    route: "/approvals",
    color: "#30D158",
  },
  {
    id: "council",
    title: "Council",
    subtitle: "AI council chamber",
    icon: Sparkles,
    route: "/council",
    color: "#FFD60A",
  },
  {
    id: "calendar",
    title: "Calendar",
    subtitle: "Schedule & events",
    icon: Calendar,
    route: "/calendar",
    color: "#FF9F0A",
  },
  {
    id: "projects",
    title: "Projects",
    subtitle: "Project management",
    icon: FolderKanban,
    route: "/projects",
    color: "#FF2D55",
  },
  {
    id: "memory",
    title: "Memory",
    subtitle: "Knowledge bank",
    icon: Brain,
    route: "/memory",
    color: "#BF5AF2",
  },
  {
    id: "docs",
    title: "Docs",
    subtitle: "Documentation",
    icon: File,
    route: "/docs",
    color: "#8E8E93",
  },
  {
    id: "people",
    title: "People",
    subtitle: "Contacts & CRM",
    icon: User,
    route: "/people",
    color: "#FF6B35",
  },
  {
    id: "team",
    title: "Team",
    subtitle: "Team management",
    icon: UsersRound,
    route: "/team",
    color: "#5E5CE6",
  },
  {
    id: "analytics",
    title: "Analytics",
    subtitle: "Performance metrics",
    icon: BarChart3,
    route: "/analytics",
    color: "#00C8FF",
  },
  {
    id: "controls",
    title: "Controls",
    subtitle: "Settings & config",
    icon: Settings,
    route: "/controls",
    color: "#8E8E93",
  },
];

// Simple fuzzy match: returns score (0 = no match, higher = better)
function fuzzyScore(query: string, target: string): number {
  const q = query.toLowerCase();
  const t = target.toLowerCase();

  // Exact includes
  if (t.includes(q)) {
    return 100 + (q.length / t.length) * 50;
  }

  // Fuzzy: all chars in order
  let qi = 0;
  let consecutive = 0;
  let maxConsecutive = 0;
  let score = 0;

  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      qi++;
      consecutive++;
      maxConsecutive = Math.max(maxConsecutive, consecutive);
      score += consecutive * 2; // reward consecutive matches
      if (ti === 0) {
        score += 10;
      } // reward start match
    } else {
      consecutive = 0;
    }
  }

  if (qi < q.length) {
    return 0;
  } // not all chars matched
  return score + maxConsecutive * 5;
}

const TYPE_ICONS: Record<ResultType, typeof Users> = {
  page: ArrowRight,
  agent: Users,
  task: CheckSquare,
  project: FolderKanban,
  memory: Brain,
  person: User,
};

const TYPE_LABELS: Record<ResultType, string> = {
  page: "Pages",
  agent: "Agents",
  task: "Tasks",
  project: "Projects",
  memory: "Memory",
  person: "People",
};

export function SearchOverlay() {
  const { searchOpen, setSearchOpen } = useUIStore();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const [activeFilter, setActiveFilter] = useState<ResultType | null>(null);

  const agents = useAgentStore((s) => s.agents);
  const tasks = useTaskStore((s) => s.tasks);
  const projects = useProjectStore((s) => s.projects);
  const memories = useMemoryStore((s) => s.memories);
  const people = usePeopleStore((s) => s.people);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setSearchOpen(!searchOpen);
      }
      if (e.key === "Escape") {
        setSearchOpen(false);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [searchOpen, setSearchOpen]);

  useEffect(() => {
    if (searchOpen) {
      setQuery("");
      setSelectedIndex(0);
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [searchOpen]);

  const doSearch = useCallback(
    (q: string) => {
      if (!q.trim()) {
        // Show pages as default
        setResults(
          PAGES.map((p) => ({
            type: "page" as ResultType,
            id: p.id,
            title: p.title,
            subtitle: p.subtitle,
            color: p.color,
            route: p.route,
            score: 0,
          })),
        );
        return;
      }

      const r: SearchResult[] = [];

      // Pages
      PAGES.forEach((p) => {
        const s = Math.max(fuzzyScore(q, p.title), fuzzyScore(q, p.subtitle));
        if (s > 0) {
          r.push({
            type: "page",
            id: p.id,
            title: p.title,
            subtitle: p.subtitle,
            color: p.color,
            route: p.route,
            score: s + 200,
          });
        }
      });

      // Agents
      agents.forEach((a) => {
        const s = Math.max(fuzzyScore(q, a.name), fuzzyScore(q, a.role));
        if (s > 0) {
          r.push({
            type: "agent",
            id: a.id,
            title: a.name,
            subtitle: `${a.role} · ${a.status}`,
            color: a.color,
            route: "/office",
            score: s + 100,
          });
        }
      });

      // Tasks
      tasks.forEach((t) => {
        const s = Math.max(
          fuzzyScore(q, t.title),
          fuzzyScore(q, t.description),
          ...t.tags.map((tag) => fuzzyScore(q, tag)),
        );
        if (s > 0) {
          r.push({
            type: "task",
            id: t.id,
            title: t.title,
            subtitle: `${t.status.replace("_", " ")} · ${t.priority}`,
            color: "#00C8FF",
            route: "/tasks",
            score: s,
          });
        }
      });

      // Projects
      projects.forEach((p) => {
        const s = Math.max(fuzzyScore(q, p.name), fuzzyScore(q, p.description));
        if (s > 0) {
          r.push({
            type: "project",
            id: p.id,
            title: p.name,
            subtitle: p.description.slice(0, 50),
            color: p.color,
            route: "/projects",
            score: s,
          });
        }
      });

      // Memories
      memories.forEach((m) => {
        const s = fuzzyScore(q, m.content);
        if (s > 0) {
          r.push({
            type: "memory",
            id: m.id,
            title: m.content.slice(0, 60),
            subtitle: m.category,
            color: "#BF5AF2",
            route: "/memory",
            score: s - 50,
          });
        }
      });

      // People
      people.forEach((p) => {
        const s = Math.max(fuzzyScore(q, p.name), fuzzyScore(q, p.company));
        if (s > 0) {
          r.push({
            type: "person",
            id: p.id,
            title: p.name,
            subtitle: p.company,
            color: "#FF6B35",
            route: "/people",
            score: s,
          });
        }
      });

      r.sort((a, b) => b.score - a.score);
      const filtered = activeFilter ? r.filter((item) => item.type === activeFilter) : r;
      setResults(filtered.slice(0, 20));
      setSelectedIndex(0);
    },
    [agents, tasks, projects, memories, people, activeFilter],
  );

  useEffect(() => {
    doSearch(query);
  }, [query, doSearch]);

  const handleSelect = (result: SearchResult) => {
    navigate(result.route);
    setSearchOpen(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, results.length - 1));
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
    }
    if (e.key === "Enter" && results[selectedIndex]) {
      handleSelect(results[selectedIndex]);
    }
  };

  // Group results by type
  const grouped = results.reduce<Record<ResultType, SearchResult[]>>(
    (acc, r) => {
      (acc[r.type] = acc[r.type] || []).push(r);
      return acc;
    },
    {} as Record<ResultType, SearchResult[]>,
  );

  // Flatten for keyboard nav index
  const flatResults = results;
  let flatIndex = 0;

  if (!searchOpen) {
    return null;
  }

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-[100] bg-void/80 backdrop-blur-xl flex items-start justify-center pt-[12vh]"
        onClick={() => setSearchOpen(false)}
      >
        <motion.div
          initial={{ opacity: 0, scale: 0.95, y: -20 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95 }}
          transition={{ type: "spring", stiffness: 400, damping: 30 }}
          className="glass-panel w-full max-w-xl p-0 overflow-hidden"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Search input */}
          <div className="flex items-center gap-3 px-4 py-3 border-b border-border">
            <Search className="w-5 h-5 text-muted-foreground" />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Search pages, agents, tasks, projects..."
              className="flex-1 bg-transparent text-foreground text-sm placeholder:text-muted-foreground focus:outline-none"
            />
            <kbd className="text-[10px] font-mono text-muted-foreground bg-secondary px-1.5 py-0.5 rounded">
              ESC
            </kbd>
            <button onClick={() => setSearchOpen(false)}>
              <X className="w-4 h-4 text-muted-foreground" />
            </button>
          </div>

          {/* Type filters */}
          <div className="flex gap-1 px-4 py-2 border-b border-border overflow-x-auto scrollbar-thin">
            <button
              onClick={() => {
                setActiveFilter(null);
                doSearch(query);
              }}
              className={`px-2 py-1 rounded-md text-[10px] font-mono whitespace-nowrap transition-colors ${
                !activeFilter
                  ? "bg-primary/15 text-primary"
                  : "text-muted-foreground hover:text-foreground hover:bg-secondary"
              }`}
            >
              All
            </button>
            {(["page", "agent", "task", "project", "memory", "person"] as ResultType[]).map(
              (type) => (
                <button
                  key={type}
                  onClick={() => {
                    setActiveFilter(type);
                    doSearch(query);
                  }}
                  className={`px-2 py-1 rounded-md text-[10px] font-mono whitespace-nowrap transition-colors ${
                    activeFilter === type
                      ? "bg-primary/15 text-primary"
                      : "text-muted-foreground hover:text-foreground hover:bg-secondary"
                  }`}
                >
                  {TYPE_LABELS[type]}
                </button>
              ),
            )}
          </div>

          {/* Results */}
          <div className="max-h-[400px] overflow-y-auto scrollbar-thin">
            {results.length === 0 && query && (
              <div className="p-8 text-center text-muted-foreground text-sm font-mono">
                No results for "{query}"
              </div>
            )}

            {(Object.keys(grouped) as ResultType[]).map((type) => {
              const items = grouped[type];
              if (!items?.length) {
                return null;
              }

              return (
                <div key={type}>
                  <div className="px-4 py-1.5 text-[10px] font-mono text-muted-foreground uppercase tracking-wider bg-secondary/30 sticky top-0">
                    {TYPE_LABELS[type]}
                  </div>
                  {items.map((result) => {
                    const Icon = TYPE_ICONS[result.type];
                    const currentFlatIndex = flatIndex++;
                    const isSelected = currentFlatIndex === selectedIndex;

                    return (
                      <motion.button
                        key={`${result.type}-${result.id}`}
                        onClick={() => handleSelect(result)}
                        initial={false}
                        animate={
                          isSelected
                            ? { backgroundColor: "rgba(0, 200, 255, 0.08)" }
                            : { backgroundColor: "transparent" }
                        }
                        className="w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-secondary/50"
                      >
                        <div
                          className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0"
                          style={{ backgroundColor: `${result.color}15` }}
                        >
                          <Icon className="w-3.5 h-3.5" style={{ color: result.color }} />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="text-sm text-foreground truncate">{result.title}</div>
                          <div className="text-[10px] text-muted-foreground font-mono truncate">
                            {result.subtitle}
                          </div>
                        </div>
                        {isSelected && (
                          <motion.div
                            initial={{ opacity: 0, x: -5 }}
                            animate={{ opacity: 1, x: 0 }}
                            className="text-[10px] font-mono text-primary flex items-center gap-1"
                          >
                            Open <ArrowRight className="w-3 h-3" />
                          </motion.div>
                        )}
                      </motion.button>
                    );
                  })}
                </div>
              );
            })}
          </div>

          {/* Footer */}
          <div className="px-4 py-2 border-t border-border flex gap-4 text-[10px] font-mono text-muted-foreground">
            <span>↑↓ Navigate</span>
            <span>↵ Open</span>
            <span>⌘K Toggle</span>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
