import { format, formatDistanceToNow } from "date-fns";
import { motion, AnimatePresence } from "framer-motion";
import { X, Check, Plus, Trash2, Clock, Edit3, Save, ChevronDown } from "lucide-react";
import { useState } from "react";
import { AGENT_DEFINITIONS } from "@/lib/agents";
import { cn } from "@/lib/utils";
import { Task, TaskPriority, TaskStatus, useTaskStore } from "@/store/taskStore";

interface TaskDetailPanelProps {
  task: Task;
  onClose: () => void;
}

const STATUS_OPTIONS: { id: TaskStatus; label: string; color: string }[] = [
  { id: "todo", label: "To Do", color: "#8E8E93" },
  { id: "in_progress", label: "In Progress", color: "#00C8FF" },
  { id: "review", label: "Review", color: "#FFD60A" },
  { id: "done", label: "Done", color: "#30D158" },
];

const PRIORITIES: TaskPriority[] = ["low", "medium", "high", "urgent"];
const PRIORITY_ACTIVE: Record<TaskPriority, string> = {
  low: "bg-muted-foreground/20 border-muted-foreground text-muted-foreground",
  medium: "bg-primary/20 border-primary text-primary",
  high: "bg-accent-gold/20 border-accent-gold text-accent-gold",
  urgent: "bg-accent-red/20 border-accent-red text-accent-red",
};
const PRIORITY_INACTIVE: Record<TaskPriority, string> = {
  low: "border-border text-muted-foreground",
  medium: "border-border text-muted-foreground",
  high: "border-border text-muted-foreground",
  urgent: "border-border text-muted-foreground",
};

export function TaskDetailPanel({ task, onClose }: TaskDetailPanelProps) {
  const { updateTask, updateTaskStatus, addSubtask, toggleSubtask, deleteSubtask, deleteTask } =
    useTaskStore();

  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description);
  const [priority, setPriority] = useState(task.priority);
  const [newSubtask, setNewSubtask] = useState("");
  const [showStatusMenu, setShowStatusMenu] = useState(false);

  const agent = AGENT_DEFINITIONS.find((a) => a.id === task.assignedAgent);
  const doneCount = task.subtasks.filter((s) => s.done).length;
  const subtaskProgress = task.subtasks.length > 0 ? (doneCount / task.subtasks.length) * 100 : 0;

  const handleSave = () => {
    updateTask(task.id, { title, description, priority });
    setEditing(false);
  };

  const handleAddSubtask = () => {
    const t = newSubtask.trim();
    if (t) {
      addSubtask(task.id, t);
      setNewSubtask("");
    }
  };

  const handleStatusChange = (status: TaskStatus) => {
    updateTaskStatus(task.id, status);
    setShowStatusMenu(false);
  };

  const handleDelete = () => {
    deleteTask(task.id);
    onClose();
  };

  const currentStatus = STATUS_OPTIONS.find((s) => s.id === task.status);

  return (
    <AnimatePresence>
      <motion.div
        className="fixed inset-0 z-50 flex justify-end"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
      >
        <motion.div
          className="absolute inset-0 bg-background/70 backdrop-blur-sm"
          onClick={onClose}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
        />

        <motion.div
          className="relative w-full max-w-xl h-full glass-panel rounded-none rounded-l-2xl border-l border-border overflow-y-auto"
          initial={{ x: "100%" }}
          animate={{ x: 0 }}
          exit={{ x: "100%" }}
          transition={{ type: "spring", stiffness: 350, damping: 35 }}
        >
          {/* Header */}
          <div className="sticky top-0 z-10 flex items-center justify-between p-5 pb-3 bg-card/80 backdrop-blur-md border-b border-border">
            <div className="flex items-center gap-3">
              {agent && (
                <div
                  className="w-8 h-8 rounded-full flex items-center justify-center text-[11px] font-bold shrink-0"
                  style={{ backgroundColor: `${agent.color}20`, color: agent.color }}
                >
                  {agent.shortCode}
                </div>
              )}
              <div>
                <span className="text-[10px] font-mono text-muted-foreground uppercase">
                  {agent?.name || task.assignedAgent}
                </span>
                {task.project && (
                  <span className="text-[10px] font-mono text-primary ml-2">• {task.project}</span>
                )}
              </div>
            </div>
            <div className="flex items-center gap-1">
              <button
                onClick={() => (editing ? handleSave() : setEditing(true))}
                className="p-1.5 rounded-lg hover:bg-secondary transition-colors"
              >
                {editing ? (
                  <Save className="w-4 h-4 text-primary" />
                ) : (
                  <Edit3 className="w-4 h-4 text-muted-foreground" />
                )}
              </button>
              <button
                onClick={onClose}
                className="p-1.5 rounded-lg hover:bg-secondary transition-colors"
              >
                <X className="w-4 h-4 text-muted-foreground" />
              </button>
            </div>
          </div>

          <div className="p-5 space-y-6">
            {/* Title & Description */}
            <motion.div layout className="space-y-2">
              {editing ? (
                <input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  className="w-full bg-secondary/50 border border-border rounded-lg px-3 py-2 text-base font-semibold text-foreground focus:outline-none focus:ring-1 focus:ring-primary/50"
                  autoFocus
                />
              ) : (
                <h2 className="text-lg font-semibold text-foreground">{task.title}</h2>
              )}
              {editing ? (
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={3}
                  className="w-full bg-secondary/50 border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary/50 resize-none"
                />
              ) : (
                <p className="text-sm text-muted-foreground">
                  {task.description || "No description"}
                </p>
              )}
            </motion.div>

            {/* Status & Priority row */}
            <div className="flex items-center gap-3">
              {/* Status dropdown */}
              <div className="relative">
                <button
                  onClick={() => setShowStatusMenu(!showStatusMenu)}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border text-[11px] font-mono hover:bg-secondary/50 transition-colors"
                >
                  <span
                    className="w-2 h-2 rounded-full"
                    style={{ backgroundColor: currentStatus.color }}
                  />
                  {currentStatus.label}
                  <ChevronDown className="w-3 h-3 text-muted-foreground" />
                </button>
                <AnimatePresence>
                  {showStatusMenu && (
                    <motion.div
                      className="absolute top-full left-0 mt-1 glass-panel border border-border rounded-xl overflow-hidden z-20 min-w-[140px]"
                      initial={{ opacity: 0, y: -5, scale: 0.95 }}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      exit={{ opacity: 0, y: -5, scale: 0.95 }}
                      transition={{ duration: 0.15 }}
                    >
                      {STATUS_OPTIONS.map((s) => (
                        <button
                          key={s.id}
                          onClick={() => handleStatusChange(s.id)}
                          className={cn(
                            "w-full flex items-center gap-2 px-3 py-2 text-[11px] font-mono hover:bg-secondary/50 transition-colors",
                            task.status === s.id ? "text-foreground" : "text-muted-foreground",
                          )}
                        >
                          <span
                            className="w-2 h-2 rounded-full"
                            style={{ backgroundColor: s.color }}
                          />
                          {s.label}
                        </button>
                      ))}
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>

              {/* Priority pills */}
              <div className="flex gap-1">
                {PRIORITIES.map((p) => (
                  <button
                    key={p}
                    onClick={() => {
                      setPriority(p);
                      updateTask(task.id, { priority: p });
                    }}
                    className={cn(
                      "px-2 py-1 text-[10px] font-mono uppercase rounded-md border transition-all",
                      task.priority === p ? PRIORITY_ACTIVE[p] : PRIORITY_INACTIVE[p],
                    )}
                  >
                    {p}
                  </button>
                ))}
              </div>
            </div>

            {/* Meta info */}
            <div className="flex items-center gap-4 text-[11px] font-mono text-muted-foreground">
              {task.dueDate && (
                <span className="flex items-center gap-1">
                  <Clock className="w-3 h-3" />
                  Due {format(new Date(task.dueDate), "MMM d")}
                </span>
              )}
              <span>Created {format(new Date(task.createdAt), "MMM d")}</span>
            </div>

            {/* Tags */}
            {task.tags.length > 0 && (
              <div className="flex gap-1.5 flex-wrap">
                {task.tags.map((tag) => (
                  <span
                    key={tag}
                    className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-secondary text-muted-foreground border border-border"
                  >
                    {tag}
                  </span>
                ))}
              </div>
            )}

            {/* Subtasks */}
            <div>
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-[11px] font-mono text-muted-foreground uppercase tracking-wider">
                  Subtasks {task.subtasks.length > 0 && `(${doneCount}/${task.subtasks.length})`}
                </h3>
              </div>

              {task.subtasks.length > 0 && (
                <div className="h-1 rounded-full bg-secondary mb-3 overflow-hidden">
                  <motion.div
                    className="h-full rounded-full bg-primary"
                    initial={{ width: 0 }}
                    animate={{ width: `${subtaskProgress}%` }}
                    transition={{ type: "spring", stiffness: 300, damping: 30 }}
                  />
                </div>
              )}

              <div className="space-y-1.5">
                <AnimatePresence>
                  {task.subtasks.map((sub) => (
                    <motion.div
                      key={sub.id}
                      layout
                      initial={{ opacity: 0, x: -10 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0, x: 10 }}
                      className="flex items-center gap-2 group"
                    >
                      <button
                        onClick={() => toggleSubtask(task.id, sub.id)}
                        className={cn(
                          "w-4 h-4 rounded border flex items-center justify-center shrink-0 transition-all",
                          sub.done
                            ? "bg-primary border-primary"
                            : "border-border hover:border-primary/50",
                        )}
                      >
                        {sub.done && <Check className="w-2.5 h-2.5 text-primary-foreground" />}
                      </button>
                      <span
                        className={cn(
                          "text-sm flex-1 transition-all",
                          sub.done ? "text-muted-foreground line-through" : "text-foreground",
                        )}
                      >
                        {sub.title}
                      </span>
                      <button
                        onClick={() => deleteSubtask(task.id, sub.id)}
                        className="opacity-0 group-hover:opacity-100 p-0.5 hover:bg-secondary rounded transition-all"
                      >
                        <Trash2 className="w-3 h-3 text-muted-foreground" />
                      </button>
                    </motion.div>
                  ))}
                </AnimatePresence>
              </div>

              <div className="flex gap-2 mt-3">
                <input
                  value={newSubtask}
                  onChange={(e) => setNewSubtask(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleAddSubtask()}
                  placeholder="Add subtask..."
                  className="flex-1 bg-secondary/50 border border-border rounded-lg px-3 py-1.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/50"
                />
                <button
                  onClick={handleAddSubtask}
                  className="p-1.5 rounded-lg border border-border hover:border-primary/30 hover:bg-secondary/50 transition-colors"
                >
                  <Plus className="w-3.5 h-3.5 text-muted-foreground" />
                </button>
              </div>
            </div>

            {/* Activity Log */}
            <div>
              <h3 className="text-[11px] font-mono text-muted-foreground uppercase tracking-wider mb-3">
                Activity
              </h3>
              <div className="space-y-0 relative">
                <div className="absolute left-[5px] top-2 bottom-2 w-px bg-border" />
                {[...task.activity].toReversed().map((entry, i) => (
                  <motion.div
                    key={entry.id}
                    initial={{ opacity: 0, y: 5 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: i * 0.03 }}
                    className="flex items-start gap-3 py-2 relative"
                  >
                    <div className="w-[11px] h-[11px] rounded-full bg-secondary border-2 border-border shrink-0 mt-0.5 z-10" />
                    <div className="flex-1 min-w-0">
                      <p className="text-xs text-foreground">{entry.text}</p>
                      <p className="text-[10px] font-mono text-muted-foreground">
                        {formatDistanceToNow(new Date(entry.timestamp), { addSuffix: true })}
                      </p>
                    </div>
                  </motion.div>
                ))}
              </div>
            </div>

            {/* Delete */}
            <button
              onClick={handleDelete}
              className="flex items-center gap-1.5 text-[11px] font-mono text-destructive/60 hover:text-destructive transition-colors py-2"
            >
              <Trash2 className="w-3 h-3" /> Delete task
            </button>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
