import { format } from "date-fns";
import { motion, AnimatePresence } from "framer-motion";
import { X, ChevronRight, ChevronLeft, Zap, Calendar, Tag, Plus } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Calendar as CalendarPicker } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { AGENT_DEFINITIONS } from "@/lib/agents";
import { cn } from "@/lib/utils";
import { useProjectStore } from "@/store/projectStore";
import { useTaskStore, TaskPriority, TaskStatus } from "@/store/taskStore";

interface AddTaskModalProps {
  open: boolean;
  onClose: () => void;
}

const STEPS = ["Details", "Assign", "Schedule"];
const PRIORITIES: TaskPriority[] = ["low", "medium", "high", "urgent"];
const PRIORITY_COLORS: Record<TaskPriority, string> = {
  low: "border-muted-foreground/30 text-muted-foreground",
  medium: "border-primary/40 text-primary",
  high: "border-accent-gold/40 text-accent-gold",
  urgent: "border-accent-red/40 text-accent-red",
};
const PRIORITY_ACTIVE: Record<TaskPriority, string> = {
  low: "bg-muted-foreground/20 border-muted-foreground text-muted-foreground",
  medium: "bg-primary/20 border-primary text-primary",
  high: "bg-accent-gold/20 border-accent-gold text-accent-gold",
  urgent: "bg-accent-red/20 border-accent-red text-accent-red",
};

const SUGGESTED_TAGS = [
  "dev",
  "marketing",
  "finance",
  "research",
  "content",
  "operations",
  "personal",
  "urgent",
];

export function AddTaskModal({ open, onClose }: AddTaskModalProps) {
  const addTask = useTaskStore((s) => s.addTask);
  const projects = useProjectStore((s) => s.projects);

  const [step, setStep] = useState(0);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<TaskPriority>("medium");
  const [agent, setAgent] = useState("");
  const [project, setProject] = useState("");
  const [dueDate, setDueDate] = useState<Date | undefined>();
  const [tags, setTags] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState("");

  const reset = () => {
    setStep(0);
    setTitle("");
    setDescription("");
    setPriority("medium");
    setAgent("");
    setProject("");
    setDueDate(undefined);
    setTags([]);
    setTagInput("");
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  const toggleTag = (tag: string) => {
    setTags((prev) => (prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]));
  };

  const addCustomTag = () => {
    const t = tagInput.trim().toLowerCase();
    if (t && !tags.includes(t)) {
      setTags((prev) => [...prev, t]);
    }
    setTagInput("");
  };

  const canNext = step === 0 ? title.trim().length > 0 : step === 1 ? agent !== "" : true;

  const handleSubmit = () => {
    addTask({
      title: title.trim(),
      description: description.trim(),
      status: "todo" as TaskStatus,
      priority,
      assignedAgent: agent,
      dueDate: dueDate ? format(dueDate, "yyyy-MM-dd") : "",
      tags,
      project: project || undefined,
    });
    toast.success("Task created", {
      description: `"${title}" assigned to ${AGENT_DEFINITIONS.find((a) => a.id === agent)?.name}`,
    });
    handleClose();
  };

  const slideVariants = {
    enter: (dir: number) => ({ x: dir > 0 ? 80 : -80, opacity: 0 }),
    center: { x: 0, opacity: 1 },
    exit: (dir: number) => ({ x: dir > 0 ? -80 : 80, opacity: 0 }),
  };

  const [direction, setDirection] = useState(1);

  const goNext = () => {
    setDirection(1);
    setStep((s) => Math.min(s + 1, 2));
  };
  const goPrev = () => {
    setDirection(-1);
    setStep((s) => Math.max(s - 1, 0));
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
        >
          {/* Backdrop */}
          <motion.div
            className="absolute inset-0 bg-background/80 backdrop-blur-sm"
            onClick={handleClose}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          />

          {/* Modal */}
          <motion.div
            className="relative glass-panel w-full max-w-lg overflow-hidden"
            initial={{ scale: 0.9, opacity: 0, y: 30 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{ scale: 0.9, opacity: 0, y: 30 }}
            transition={{ type: "spring", stiffness: 400, damping: 30 }}
          >
            {/* Header */}
            <div className="flex items-center justify-between p-5 pb-3">
              <div className="flex items-center gap-2">
                <Zap className="w-4 h-4 text-primary" />
                <h2 className="text-sm font-semibold text-foreground">New Task</h2>
              </div>
              <button
                onClick={handleClose}
                className="p-1 rounded-lg hover:bg-secondary transition-colors"
              >
                <X className="w-4 h-4 text-muted-foreground" />
              </button>
            </div>

            {/* Step indicators */}
            <div className="flex items-center gap-1 px-5 pb-4">
              {STEPS.map((s, i) => (
                <div key={s} className="flex items-center gap-1">
                  <div
                    className={cn(
                      "h-1.5 rounded-full transition-all duration-300",
                      i <= step ? "bg-primary w-8" : "bg-secondary w-4",
                    )}
                  />
                </div>
              ))}
              <span className="text-[10px] font-mono text-muted-foreground ml-2">
                {STEPS[step]}
              </span>
            </div>

            {/* Step content */}
            <div className="px-5 min-h-[260px] overflow-hidden">
              <AnimatePresence mode="wait" custom={direction}>
                {step === 0 && (
                  <motion.div
                    key="step0"
                    custom={direction}
                    variants={slideVariants}
                    initial="enter"
                    animate="center"
                    exit="exit"
                    transition={{ duration: 0.25, ease: "easeInOut" }}
                    className="space-y-4"
                  >
                    <div>
                      <label className="text-[11px] font-mono text-muted-foreground uppercase tracking-wider mb-1.5 block">
                        Title
                      </label>
                      <input
                        value={title}
                        onChange={(e) => setTitle(e.target.value)}
                        placeholder="What needs to be done?"
                        className="w-full bg-secondary/50 border border-border rounded-lg px-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/50 transition-all"
                        autoFocus
                      />
                    </div>
                    <div>
                      <label className="text-[11px] font-mono text-muted-foreground uppercase tracking-wider mb-1.5 block">
                        Description
                      </label>
                      <textarea
                        value={description}
                        onChange={(e) => setDescription(e.target.value)}
                        placeholder="Add details..."
                        rows={3}
                        className="w-full bg-secondary/50 border border-border rounded-lg px-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/50 transition-all resize-none"
                      />
                    </div>
                    <div>
                      <label className="text-[11px] font-mono text-muted-foreground uppercase tracking-wider mb-1.5 block">
                        Priority
                      </label>
                      <div className="flex gap-2">
                        {PRIORITIES.map((p) => (
                          <button
                            key={p}
                            onClick={() => setPriority(p)}
                            className={cn(
                              "flex-1 py-1.5 text-[11px] font-mono uppercase rounded-lg border transition-all",
                              priority === p ? PRIORITY_ACTIVE[p] : PRIORITY_COLORS[p],
                            )}
                          >
                            {p}
                          </button>
                        ))}
                      </div>
                    </div>
                  </motion.div>
                )}

                {step === 1 && (
                  <motion.div
                    key="step1"
                    custom={direction}
                    variants={slideVariants}
                    initial="enter"
                    animate="center"
                    exit="exit"
                    transition={{ duration: 0.25, ease: "easeInOut" }}
                    className="space-y-4"
                  >
                    <div>
                      <label className="text-[11px] font-mono text-muted-foreground uppercase tracking-wider mb-2 block">
                        Assign Agent
                      </label>
                      <div className="grid grid-cols-4 gap-2">
                        {AGENT_DEFINITIONS.map((a) => (
                          <button
                            key={a.id}
                            onClick={() => setAgent(a.id)}
                            className={cn(
                              "flex flex-col items-center gap-1.5 p-2.5 rounded-xl border transition-all",
                              agent === a.id
                                ? "border-primary bg-primary/10 ring-1 ring-primary/30"
                                : "border-border hover:border-primary/30 hover:bg-secondary/50",
                            )}
                          >
                            <div
                              className="w-8 h-8 rounded-full flex items-center justify-center text-[11px] font-bold"
                              style={{ backgroundColor: `${a.color}20`, color: a.color }}
                            >
                              {a.shortCode}
                            </div>
                            <span className="text-[10px] font-mono text-foreground">{a.name}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                    <div>
                      <label className="text-[11px] font-mono text-muted-foreground uppercase tracking-wider mb-1.5 block">
                        Project (optional)
                      </label>
                      <div className="flex gap-2 flex-wrap">
                        {projects.map((p) => (
                          <button
                            key={p.id}
                            onClick={() => setProject(project === p.name ? "" : p.name)}
                            className={cn(
                              "px-3 py-1.5 text-[11px] font-mono rounded-lg border transition-all",
                              project === p.name
                                ? "border-primary bg-primary/10 text-primary"
                                : "border-border text-muted-foreground hover:border-primary/30",
                            )}
                          >
                            {p.name}
                          </button>
                        ))}
                      </div>
                    </div>
                  </motion.div>
                )}

                {step === 2 && (
                  <motion.div
                    key="step2"
                    custom={direction}
                    variants={slideVariants}
                    initial="enter"
                    animate="center"
                    exit="exit"
                    transition={{ duration: 0.25, ease: "easeInOut" }}
                    className="space-y-4"
                  >
                    <div>
                      <label className="text-[11px] font-mono text-muted-foreground uppercase tracking-wider mb-1.5 block">
                        Due Date
                      </label>
                      <Popover>
                        <PopoverTrigger asChild>
                          <button
                            className={cn(
                              "w-full flex items-center gap-2 bg-secondary/50 border border-border rounded-lg px-3 py-2.5 text-sm transition-all hover:border-primary/30",
                              dueDate ? "text-foreground" : "text-muted-foreground",
                            )}
                          >
                            <Calendar className="w-4 h-4" />
                            {dueDate ? format(dueDate, "PPP") : "Pick a date"}
                          </button>
                        </PopoverTrigger>
                        <PopoverContent
                          className="w-auto p-0 glass-panel border-border"
                          align="start"
                        >
                          <CalendarPicker
                            mode="single"
                            selected={dueDate}
                            onSelect={setDueDate}
                            initialFocus
                            className={cn("p-3 pointer-events-auto")}
                          />
                        </PopoverContent>
                      </Popover>
                    </div>
                    <div>
                      <label className="text-[11px] font-mono text-muted-foreground uppercase tracking-wider mb-1.5 block">
                        Tags
                      </label>
                      <div className="flex gap-1.5 flex-wrap mb-2">
                        {SUGGESTED_TAGS.map((t) => (
                          <button
                            key={t}
                            onClick={() => toggleTag(t)}
                            className={cn(
                              "px-2 py-1 text-[10px] font-mono rounded-full border transition-all",
                              tags.includes(t)
                                ? "border-primary bg-primary/15 text-primary"
                                : "border-border text-muted-foreground hover:border-primary/30",
                            )}
                          >
                            {t}
                          </button>
                        ))}
                      </div>
                      <div className="flex gap-2">
                        <input
                          value={tagInput}
                          onChange={(e) => setTagInput(e.target.value)}
                          onKeyDown={(e) => e.key === "Enter" && addCustomTag()}
                          placeholder="Custom tag..."
                          className="flex-1 bg-secondary/50 border border-border rounded-lg px-3 py-1.5 text-[11px] text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/50"
                        />
                        <button
                          onClick={addCustomTag}
                          className="p-1.5 rounded-lg border border-border hover:border-primary/30 transition-colors"
                        >
                          <Plus className="w-3.5 h-3.5 text-muted-foreground" />
                        </button>
                      </div>
                      {tags.length > 0 && (
                        <div className="flex gap-1 mt-2 flex-wrap">
                          {tags
                            .filter((t) => !SUGGESTED_TAGS.includes(t))
                            .map((t) => (
                              <span
                                key={t}
                                className="px-2 py-0.5 text-[10px] font-mono rounded-full bg-primary/15 text-primary border border-primary/30"
                              >
                                {t}
                                <button
                                  onClick={() => toggleTag(t)}
                                  className="ml-1 text-primary/60 hover:text-primary"
                                >
                                  ×
                                </button>
                              </span>
                            ))}
                        </div>
                      )}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            {/* Footer */}
            <div className="flex items-center justify-between p-5 pt-4">
              <button
                onClick={goPrev}
                disabled={step === 0}
                className={cn(
                  "flex items-center gap-1 text-[11px] font-mono px-3 py-1.5 rounded-lg transition-all",
                  step === 0
                    ? "text-muted-foreground/30 cursor-not-allowed"
                    : "text-muted-foreground hover:bg-secondary",
                )}
              >
                <ChevronLeft className="w-3 h-3" /> Back
              </button>

              {step < 2 ? (
                <button
                  onClick={goNext}
                  disabled={!canNext}
                  className={cn(
                    "flex items-center gap-1 text-[11px] font-mono px-4 py-1.5 rounded-lg transition-all",
                    canNext
                      ? "bg-primary text-primary-foreground hover:bg-primary/90"
                      : "bg-secondary text-muted-foreground/40 cursor-not-allowed",
                  )}
                >
                  Next <ChevronRight className="w-3 h-3" />
                </button>
              ) : (
                <motion.button
                  onClick={handleSubmit}
                  disabled={!canNext}
                  className="flex items-center gap-1.5 text-[11px] font-mono px-4 py-1.5 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-all"
                  whileHover={{ scale: 1.03 }}
                  whileTap={{ scale: 0.97 }}
                >
                  <Zap className="w-3 h-3" /> Create Task
                </motion.button>
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
