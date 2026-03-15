import { format, isPast, isToday } from "date-fns";
import { motion, AnimatePresence } from "framer-motion";
import { GripVertical, Plus, Calendar, CheckCircle2, Filter, List, LayoutGrid } from "lucide-react";
import { useState, useMemo } from "react";
import { AddTaskModal } from "@/components/office/AddTaskModal";
import { TaskDetailPanel } from "@/components/office/TaskDetailPanel";
import { GlassCard } from "@/components/ui/GlassCard";
import { HeroSection } from "@/components/ui/HeroSection";
import { TaskBoardSkeleton } from "@/components/ui/skeleton";
import { useLoadingDelay } from "@/hooks/use-loading-delay";
import { avatarMap } from "@/lib/avatars";
import { useAgentStore } from "@/store/agentStore";
import { useTaskStore, TaskStatus, Task } from "@/store/taskStore";

const COLUMNS: { id: TaskStatus; label: string; color: string; icon: string }[] = [
  { id: "todo", label: "To Do", color: "#8E8E93", icon: "○" },
  { id: "in_progress", label: "In Progress", color: "#00C8FF", icon: "◐" },
  { id: "review", label: "Review", color: "#FFD60A", icon: "◑" },
  { id: "done", label: "Done", color: "#30D158", icon: "●" },
];

const priorityColors: Record<string, string> = {
  low: "text-text-2",
  medium: "text-primary",
  high: "text-accent-gold",
  urgent: "text-accent-red",
};

const priorityBorder: Record<string, string> = {
  low: "border-l-muted",
  medium: "border-l-primary",
  high: "border-l-accent-gold",
  urgent: "border-l-accent-red",
};

type ViewMode = "board" | "list";
type FilterPriority = "all" | "low" | "medium" | "high" | "urgent";

export default function TasksPage() {
  const loading = useLoadingDelay(700);
  const tasks = useTaskStore((s) => s.tasks);
  const agents = useAgentStore((s) => s.agents);
  const updateTaskStatus = useTaskStore((s) => s.updateTaskStatus);
  const [draggedTask, setDraggedTask] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<TaskStatus | null>(null);
  const [showAddModal, setShowAddModal] = useState(false);
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("board");
  const [filterPriority, setFilterPriority] = useState<FilterPriority>("all");
  const [filterProject, setFilterProject] = useState<string | null>(null);

  const allProjects = useMemo(() => {
    const projects = new Set<string>();
    tasks.forEach((t) => {
      if (t.project) {
        projects.add(t.project);
      }
    });
    return Array.from(projects).toSorted();
  }, [tasks]);

  const filteredTasks = useMemo(() => {
    return tasks.filter((t) => {
      if (filterPriority !== "all" && t.priority !== filterPriority) {
        return false;
      }
      if (filterProject && t.project !== filterProject) {
        return false;
      }
      return true;
    });
  }, [tasks, filterPriority, filterProject]);

  const handleDragStart = (e: React.DragEvent, taskId: string) => {
    setDraggedTask(taskId);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", taskId);
    if (e.currentTarget instanceof HTMLElement) {
      e.currentTarget.style.opacity = "0.5";
    }
  };

  const handleDragEnd = (e: React.DragEvent) => {
    if (e.currentTarget instanceof HTMLElement) {
      e.currentTarget.style.opacity = "1";
    }
    setDraggedTask(null);
    setDropTarget(null);
  };

  const handleDragOver = (e: React.DragEvent, columnId: TaskStatus) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDropTarget(columnId);
  };

  const handleDragLeave = () => {
    setDropTarget(null);
  };

  const handleDrop = (e: React.DragEvent, columnId: TaskStatus) => {
    e.preventDefault();
    const taskId = e.dataTransfer.getData("text/plain");
    if (taskId) {
      updateTaskStatus(taskId, columnId);
    }
    setDraggedTask(null);
    setDropTarget(null);
  };

  const getAgent = (id: string) => agents.find((a) => a.id === id);

  const getDueDateColor = (dueDate: string) => {
    const date = new Date(dueDate);
    if (isPast(date) && !isToday(date)) {
      return "text-accent-red";
    }
    if (isToday(date)) {
      return "text-accent-gold";
    }
    return "text-text-3";
  };

  const renderTaskCard = (task: Task) => {
    const agent = getAgent(task.assignedAgent);
    const subtasksDone = task.subtasks.filter((s) => s.done).length;
    const subtasksTotal = task.subtasks.length;

    return (
      <motion.div
        key={task.id}
        layout
        initial={{ opacity: 0, y: 10 }}
        animate={{
          opacity: draggedTask === task.id ? 0.4 : 1,
          y: 0,
          scale: draggedTask === task.id ? 0.95 : 1,
        }}
        exit={{ opacity: 0, scale: 0.9, transition: { duration: 0.2 } }}
        transition={{ type: "spring", stiffness: 400, damping: 30 }}
        draggable
        onDragStart={(e) => handleDragStart(e as any, task.id)}
        onDragEnd={(e) => handleDragEnd(e as any)}
        className="cursor-grab active:cursor-grabbing"
        onClick={() => setSelectedTask(task)}
      >
        <GlassCard
          className={`p-0 overflow-hidden border-l-2 ${priorityBorder[task.priority] || "border-l-transparent"}`}
          hover={false}
        >
          <div className="p-3">
            <div className="flex items-start gap-2">
              <GripVertical className="w-3.5 h-3.5 text-text-3 mt-0.5 shrink-0 opacity-30 hover:opacity-100 transition-opacity" />
              <div className="flex-1 min-w-0">
                <div className="flex items-start justify-between gap-2 mb-1">
                  <h4 className="text-sm font-medium text-foreground leading-tight">
                    {task.title}
                  </h4>
                  {agent && (
                    <img
                      src={avatarMap[agent.id]}
                      alt={agent.name}
                      className="w-5 h-5 rounded-full object-cover shrink-0 ring-1 ring-border"
                      title={agent.name}
                    />
                  )}
                </div>

                {task.description && (
                  <p className="text-[11px] text-text-2 mb-2 line-clamp-2">{task.description}</p>
                )}

                {/* Subtask progress */}
                {subtasksTotal > 0 && (
                  <div className="flex items-center gap-2 mb-2">
                    <div className="flex-1 h-1 bg-secondary rounded-full overflow-hidden">
                      <motion.div
                        className="h-full rounded-full bg-accent-green"
                        initial={{ width: 0 }}
                        animate={{ width: `${(subtasksDone / subtasksTotal) * 100}%` }}
                        transition={{ duration: 0.5 }}
                      />
                    </div>
                    <span className="text-[9px] font-mono text-text-3 flex items-center gap-0.5">
                      <CheckCircle2 className="w-2.5 h-2.5" />
                      {subtasksDone}/{subtasksTotal}
                    </span>
                  </div>
                )}

                {/* Meta row */}
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span
                      className={`text-[10px] font-mono font-bold uppercase ${priorityColors[task.priority]}`}
                    >
                      {task.priority}
                    </span>
                    {task.project && (
                      <span className="text-[9px] font-mono px-1.5 py-0.5 rounded-md bg-secondary text-text-2">
                        {task.project}
                      </span>
                    )}
                  </div>
                  <div
                    className={`flex items-center gap-1 text-[10px] font-mono ${getDueDateColor(task.dueDate)}`}
                  >
                    <Calendar className="w-2.5 h-2.5" />
                    {format(new Date(task.dueDate), "MMM d")}
                  </div>
                </div>

                {/* Tags */}
                {task.tags.length > 0 && (
                  <div className="flex gap-1 mt-2 flex-wrap">
                    {task.tags.slice(0, 3).map((tag) => (
                      <span
                        key={tag}
                        className="text-[9px] font-mono px-1.5 py-0.5 rounded-full bg-secondary text-text-2"
                      >
                        {tag}
                      </span>
                    ))}
                    {task.tags.length > 3 && (
                      <span className="text-[9px] font-mono text-text-3">
                        +{task.tags.length - 3}
                      </span>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        </GlassCard>
      </motion.div>
    );
  };

  if (loading) {
    return (
      <div className="space-y-6 animate-fade-in">
        <div className="glass-panel p-6 space-y-2">
          <div className="animate-shimmer rounded-md bg-gradient-to-r from-secondary via-muted to-secondary bg-[length:200%_100%] h-8 w-1/4" />
          <div className="animate-shimmer rounded-md bg-gradient-to-r from-secondary via-muted to-secondary bg-[length:200%_100%] h-4 w-1/2" />
        </div>
        <TaskBoardSkeleton />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <HeroSection
          title="Task Queue"
          subtitle={`${filteredTasks.filter((t) => t.status === "todo").length} todo · ${filteredTasks.filter((t) => t.status === "in_progress").length} in progress · ${filteredTasks.filter((t) => t.status === "done").length} done`}
        />
        <div className="flex items-center gap-2">
          {/* View toggle */}
          <div className="flex gap-1 glass-pill p-0.5">
            <button
              onClick={() => setViewMode("board")}
              className={`p-1.5 rounded-full transition-colors ${viewMode === "board" ? "bg-primary/15 text-primary" : "text-muted-foreground hover:text-foreground"}`}
              title="Board view"
            >
              <LayoutGrid className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => setViewMode("list")}
              className={`p-1.5 rounded-full transition-colors ${viewMode === "list" ? "bg-primary/15 text-primary" : "text-muted-foreground hover:text-foreground"}`}
              title="List view"
            >
              <List className="w-3.5 h-3.5" />
            </button>
          </div>

          {/* Priority filter */}
          <select
            value={filterPriority}
            onChange={(e) => setFilterPriority(e.target.value as FilterPriority)}
            className="bg-secondary/50 text-foreground text-[11px] font-mono rounded-lg px-2 py-1.5 border border-border focus:outline-none focus:border-primary/40"
          >
            <option value="all">All Priority</option>
            <option value="urgent">Urgent</option>
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
          </select>

          {/* Project filter */}
          <select
            value={filterProject || ""}
            onChange={(e) => setFilterProject(e.target.value || null)}
            className="bg-secondary/50 text-foreground text-[11px] font-mono rounded-lg px-2 py-1.5 border border-border focus:outline-none focus:border-primary/40"
          >
            <option value="">All Projects</option>
            {allProjects.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>

          <motion.button
            onClick={() => setShowAddModal(true)}
            className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-primary text-primary-foreground text-xs font-mono hover:bg-primary/90 transition-colors"
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
          >
            <Plus className="w-3.5 h-3.5" /> Add Task
          </motion.button>
        </div>
      </div>

      <AddTaskModal open={showAddModal} onClose={() => setShowAddModal(false)} />

      {viewMode === "board" ? (
        /* ─── BOARD VIEW ─── */
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
          {COLUMNS.map((col) => {
            const columnTasks = filteredTasks.filter((t) => t.status === col.id);
            const isOver = dropTarget === col.id;

            return (
              <div
                key={col.id}
                onDragOver={(e) => handleDragOver(e, col.id)}
                onDragLeave={handleDragLeave}
                onDrop={(e) => handleDrop(e, col.id)}
                className="min-h-[200px]"
              >
                {/* Column header */}
                <div className="flex items-center gap-2 mb-3 sticky top-0 z-10 py-1">
                  <span className="w-2 h-2 rounded-full" style={{ backgroundColor: col.color }} />
                  <span className="text-sm font-medium text-foreground">{col.label}</span>
                  <span
                    className="text-[10px] font-mono px-1.5 py-0.5 rounded-full ml-auto"
                    style={{ backgroundColor: `${col.color}15`, color: col.color }}
                  >
                    {columnTasks.length}
                  </span>
                </div>

                {/* Drop zone */}
                <motion.div
                  className={`space-y-3 rounded-xl p-2 -m-2 min-h-[160px] transition-colors duration-200 ${
                    isOver ? "bg-primary/5 ring-2 ring-primary/20 ring-dashed" : ""
                  }`}
                  animate={isOver ? { scale: 1.01 } : { scale: 1 }}
                  transition={{ type: "spring", stiffness: 400, damping: 25 }}
                >
                  <AnimatePresence mode="popLayout">
                    {columnTasks.map((task) => renderTaskCard(task))}
                  </AnimatePresence>

                  {/* Empty state / drop hint */}
                  {columnTasks.length === 0 && (
                    <motion.div
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      className={`rounded-xl border border-dashed py-8 text-center text-[11px] font-mono transition-colors ${
                        isOver
                          ? "border-primary/40 text-primary bg-primary/5"
                          : "border-border text-text-3"
                      }`}
                    >
                      {isOver ? "↓ Drop here" : "No tasks"}
                    </motion.div>
                  )}
                </motion.div>
              </div>
            );
          })}
        </div>
      ) : (
        /* ─── LIST VIEW ─── */
        <GlassCard className="p-0 overflow-hidden" hover={false}>
          {/* List header */}
          <div className="grid grid-cols-[1fr_100px_100px_80px_80px] gap-2 px-4 py-2 border-b border-border text-[10px] font-mono text-muted-foreground uppercase tracking-wider">
            <span>Task</span>
            <span>Status</span>
            <span>Agent</span>
            <span>Priority</span>
            <span>Due</span>
          </div>
          <div className="divide-y divide-border">
            {COLUMNS.map((col) => {
              const columnTasks = filteredTasks.filter((t) => t.status === col.id);
              if (columnTasks.length === 0) {
                return null;
              }

              return columnTasks.map((task) => {
                const agent = getAgent(task.assignedAgent);
                return (
                  <motion.button
                    key={task.id}
                    onClick={() => setSelectedTask(task)}
                    className="w-full grid grid-cols-[1fr_100px_100px_80px_80px] gap-2 px-4 py-3 text-left hover:bg-secondary/30 transition-colors items-center"
                    draggable
                    onDragStart={(e) => handleDragStart(e as any, task.id)}
                    onDragEnd={(e) => handleDragEnd(e as any)}
                    whileHover={{ x: 2 }}
                  >
                    <div className="min-w-0">
                      <div className="text-sm text-foreground truncate">{task.title}</div>
                      {task.project && (
                        <span className="text-[9px] font-mono text-text-3">{task.project}</span>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5">
                      <span
                        className="w-1.5 h-1.5 rounded-full"
                        style={{ backgroundColor: col.color }}
                      />
                      <span className="text-[10px] font-mono text-text-2">{col.label}</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      {agent && (
                        <img
                          src={avatarMap[agent.id]}
                          alt={agent.name}
                          className="w-4 h-4 rounded-full object-cover"
                        />
                      )}
                      <span className="text-[10px] font-mono text-text-2 truncate">
                        {agent?.name || task.assignedAgent}
                      </span>
                    </div>
                    <span
                      className={`text-[10px] font-mono font-bold uppercase ${priorityColors[task.priority]}`}
                    >
                      {task.priority}
                    </span>
                    <span className={`text-[10px] font-mono ${getDueDateColor(task.dueDate)}`}>
                      {format(new Date(task.dueDate), "MMM d")}
                    </span>
                  </motion.button>
                );
              });
            })}
          </div>
        </GlassCard>
      )}

      {selectedTask && (
        <TaskDetailPanel
          task={tasks.find((t) => t.id === selectedTask.id) || selectedTask}
          onClose={() => setSelectedTask(null)}
        />
      )}
    </div>
  );
}
