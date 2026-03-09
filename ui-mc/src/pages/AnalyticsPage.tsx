import { motion } from "framer-motion";
import { useMemo } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  RadarChart,
  Radar,
  PolarGrid,
  PolarAngleAxis,
  PolarRadiusAxis,
  AreaChart,
  Area,
} from "recharts";
import { GlassCard } from "@/components/ui/GlassCard";
import { HeroSection } from "@/components/ui/HeroSection";
import { AnalyticsPageSkeleton } from "@/components/ui/skeleton";
import { useLoadingDelay } from "@/hooks/use-loading-delay";
import { useAgentStore } from "@/store/agentStore";
import { useProjectStore } from "@/store/projectStore";
import { useTaskStore } from "@/store/taskStore";

const CHART_COLORS = [
  "hsl(193, 100%, 50%)", // primary cyan
  "hsl(48, 100%, 52%)", // gold
  "hsl(142, 69%, 50%)", // green
  "hsl(345, 100%, 57%)", // red
  "hsl(270, 80%, 65%)", // purple
  "hsl(24, 100%, 60%)", // orange
  "hsl(193, 60%, 70%)", // light cyan
  "hsl(210, 50%, 55%)", // blue
];

const CustomTooltip = ({ active, payload, label }: any) => {
  if (!active || !payload?.length) {
    return null;
  }
  return (
    <div className="glass-panel px-3 py-2 text-xs border border-border">
      <p className="font-mono text-foreground mb-1">{label}</p>
      {payload.map((p: any, i: number) => (
        <p key={i} className="font-mono" style={{ color: p.color || p.fill }}>
          {p.name}: {p.value}
        </p>
      ))}
    </div>
  );
};

export default function AnalyticsPage() {
  const loading = useLoadingDelay(1000);
  const tasks = useTaskStore((s) => s.tasks);
  const agents = useAgentStore((s) => s.agents);
  const projects = useProjectStore((s) => s.projects);

  // --- Task completion by status ---
  const tasksByStatus = useMemo(() => {
    const counts = { todo: 0, in_progress: 0, review: 0, done: 0 };
    tasks.forEach((t) => {
      counts[t.status]++;
    });
    return [
      { name: "To Do", value: counts.todo },
      { name: "In Progress", value: counts.in_progress },
      { name: "Review", value: counts.review },
      { name: "Done", value: counts.done },
    ];
  }, [tasks]);

  // --- Task priority distribution ---
  const tasksByPriority = useMemo(() => {
    const counts = { low: 0, medium: 0, high: 0, urgent: 0 };
    tasks.forEach((t) => {
      counts[t.priority]++;
    });
    return [
      { name: "Low", value: counts.low },
      { name: "Medium", value: counts.medium },
      { name: "High", value: counts.high },
      { name: "Urgent", value: counts.urgent },
    ];
  }, [tasks]);

  // --- Agent productivity ---
  const agentProductivity = useMemo(
    () =>
      agents.map((a) => ({
        name: a.name,
        completed: a.tasksCompleted,
        done: a.tasksDone,
        color: a.color,
      })),
    [agents],
  );

  // --- Agent workload radar ---
  const agentRadar = useMemo(
    () =>
      agents.map((a) => ({
        agent: a.name,
        tasks: tasks.filter((t) => t.assignedAgent === a.id).length,
        completed: a.tasksCompleted,
        progress: a.progress,
      })),
    [agents, tasks],
  );

  // --- Project health ---
  const projectHealth = useMemo(
    () =>
      projects.map((p) => ({
        name: p.name,
        progress: p.progress,
        color: p.color,
        health: p.health,
      })),
    [projects],
  );

  // --- Simulated weekly trend data ---
  const weeklyTrend = useMemo(() => {
    const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    return days.map((day, i) => ({
      day,
      completed: Math.floor(Math.random() * 8) + 2 + i,
      created: Math.floor(Math.random() * 6) + 3,
    }));
  }, []);

  // --- KPI stats ---
  const totalTasks = tasks.length;
  const completionRate =
    totalTasks > 0
      ? Math.round((tasks.filter((t) => t.status === "done").length / totalTasks) * 100)
      : 0;
  const activeAgents = agents.filter((a) => a.status === "WORKING").length;
  const avgProgress =
    projects.length > 0
      ? Math.round(projects.reduce((sum, p) => sum + p.progress, 0) / projects.length)
      : 0;

  const kpis = [
    { label: "Total Tasks", value: totalTasks, color: "text-primary" },
    { label: "Completion Rate", value: `${completionRate}%`, color: "text-accent-green" },
    {
      label: "Active Agents",
      value: `${activeAgents}/${agents.length}`,
      color: "text-accent-gold",
    },
    { label: "Avg Project Progress", value: `${avgProgress}%`, color: "text-primary" },
  ];

  const cardVariants = {
    hidden: { opacity: 0, y: 20 },
    visible: (i: number) => ({
      opacity: 1,
      y: 0,
      transition: { delay: i * 0.08, type: "spring" as const, stiffness: 300, damping: 30 },
    }),
  };

  if (loading) {
    return <AnalyticsPageSkeleton />;
  }

  return (
    <div className="space-y-6">
      <HeroSection
        title="Analytics"
        subtitle="Performance metrics across tasks, agents, and projects"
      />

      {/* KPI Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {kpis.map((kpi, i) => (
          <motion.div
            key={kpi.label}
            custom={i}
            variants={cardVariants}
            initial="hidden"
            animate="visible"
          >
            <GlassCard className="p-4 text-center">
              <p className="text-[10px] font-mono text-muted-foreground uppercase tracking-wider mb-1">
                {kpi.label}
              </p>
              <p className={`text-2xl font-bold font-mono ${kpi.color}`}>{kpi.value}</p>
            </GlassCard>
          </motion.div>
        ))}
      </div>

      {/* Row 1: Task Status Pie + Priority Distribution */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <motion.div custom={4} variants={cardVariants} initial="hidden" animate="visible">
          <GlassCard className="p-5">
            <h3 className="text-xs font-mono text-muted-foreground uppercase tracking-wider mb-4">
              Task Status Distribution
            </h3>
            <ResponsiveContainer width="100%" height={220}>
              <PieChart>
                <Pie
                  data={tasksByStatus}
                  cx="50%"
                  cy="50%"
                  innerRadius={55}
                  outerRadius={85}
                  paddingAngle={3}
                  dataKey="value"
                  stroke="none"
                >
                  {tasksByStatus.map((_, i) => (
                    <Cell key={i} fill={CHART_COLORS[i]} />
                  ))}
                </Pie>
                <Tooltip content={<CustomTooltip />} />
              </PieChart>
            </ResponsiveContainer>
            <div className="flex justify-center gap-4 mt-2">
              {tasksByStatus.map((entry, i) => (
                <div key={entry.name} className="flex items-center gap-1.5">
                  <span
                    className="w-2 h-2 rounded-full"
                    style={{ backgroundColor: CHART_COLORS[i] }}
                  />
                  <span className="text-[10px] font-mono text-muted-foreground">
                    {entry.name} ({entry.value})
                  </span>
                </div>
              ))}
            </div>
          </GlassCard>
        </motion.div>

        <motion.div custom={5} variants={cardVariants} initial="hidden" animate="visible">
          <GlassCard className="p-5">
            <h3 className="text-xs font-mono text-muted-foreground uppercase tracking-wider mb-4">
              Priority Breakdown
            </h3>
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={tasksByPriority} barCategoryGap="20%">
                <XAxis
                  dataKey="name"
                  tick={{ fill: "hsl(240, 5%, 55%)", fontSize: 10, fontFamily: "monospace" }}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis
                  tick={{ fill: "hsl(240, 5%, 55%)", fontSize: 10, fontFamily: "monospace" }}
                  axisLine={false}
                  tickLine={false}
                  allowDecimals={false}
                />
                <Tooltip content={<CustomTooltip />} />
                <Bar dataKey="value" radius={[6, 6, 0, 0]}>
                  {tasksByPriority.map((_, i) => (
                    <Cell
                      key={i}
                      fill={[CHART_COLORS[0], CHART_COLORS[4], CHART_COLORS[1], CHART_COLORS[3]][i]}
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </GlassCard>
        </motion.div>
      </div>

      {/* Row 2: Agent Productivity Bar + Weekly Trend Area */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <motion.div custom={6} variants={cardVariants} initial="hidden" animate="visible">
          <GlassCard className="p-5">
            <h3 className="text-xs font-mono text-muted-foreground uppercase tracking-wider mb-4">
              Agent Productivity
            </h3>
            <ResponsiveContainer width="100%" height={250}>
              <BarChart data={agentProductivity} layout="vertical" barCategoryGap="15%">
                <XAxis
                  type="number"
                  tick={{ fill: "hsl(240, 5%, 55%)", fontSize: 10, fontFamily: "monospace" }}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis
                  type="category"
                  dataKey="name"
                  tick={{ fill: "hsl(240, 5%, 55%)", fontSize: 10, fontFamily: "monospace" }}
                  axisLine={false}
                  tickLine={false}
                  width={50}
                />
                <Tooltip content={<CustomTooltip />} />
                <Bar dataKey="completed" name="Completed" radius={[0, 6, 6, 0]}>
                  {agentProductivity.map((a, i) => (
                    <Cell key={i} fill={a.color} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </GlassCard>
        </motion.div>

        <motion.div custom={7} variants={cardVariants} initial="hidden" animate="visible">
          <GlassCard className="p-5">
            <h3 className="text-xs font-mono text-muted-foreground uppercase tracking-wider mb-4">
              Weekly Task Trend
            </h3>
            <ResponsiveContainer width="100%" height={250}>
              <AreaChart data={weeklyTrend}>
                <defs>
                  <linearGradient id="gradCompleted" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="hsl(193, 100%, 50%)" stopOpacity={0.3} />
                    <stop offset="100%" stopColor="hsl(193, 100%, 50%)" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="gradCreated" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="hsl(270, 80%, 65%)" stopOpacity={0.3} />
                    <stop offset="100%" stopColor="hsl(270, 80%, 65%)" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <XAxis
                  dataKey="day"
                  tick={{ fill: "hsl(240, 5%, 55%)", fontSize: 10, fontFamily: "monospace" }}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis
                  tick={{ fill: "hsl(240, 5%, 55%)", fontSize: 10, fontFamily: "monospace" }}
                  axisLine={false}
                  tickLine={false}
                  allowDecimals={false}
                />
                <Tooltip content={<CustomTooltip />} />
                <Area
                  type="monotone"
                  dataKey="completed"
                  name="Completed"
                  stroke="hsl(193, 100%, 50%)"
                  fill="url(#gradCompleted)"
                  strokeWidth={2}
                />
                <Area
                  type="monotone"
                  dataKey="created"
                  name="Created"
                  stroke="hsl(270, 80%, 65%)"
                  fill="url(#gradCreated)"
                  strokeWidth={2}
                />
              </AreaChart>
            </ResponsiveContainer>
            <div className="flex justify-center gap-4 mt-2">
              <div className="flex items-center gap-1.5">
                <span
                  className="w-2 h-2 rounded-full"
                  style={{ backgroundColor: "hsl(193, 100%, 50%)" }}
                />
                <span className="text-[10px] font-mono text-muted-foreground">Completed</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span
                  className="w-2 h-2 rounded-full"
                  style={{ backgroundColor: "hsl(270, 80%, 65%)" }}
                />
                <span className="text-[10px] font-mono text-muted-foreground">Created</span>
              </div>
            </div>
          </GlassCard>
        </motion.div>
      </div>

      {/* Row 3: Agent Radar + Project Health */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <motion.div custom={8} variants={cardVariants} initial="hidden" animate="visible">
          <GlassCard className="p-5">
            <h3 className="text-xs font-mono text-muted-foreground uppercase tracking-wider mb-4">
              Agent Workload Radar
            </h3>
            <ResponsiveContainer width="100%" height={280}>
              <RadarChart data={agentRadar}>
                <PolarGrid stroke="hsl(240, 5%, 15%)" />
                <PolarAngleAxis
                  dataKey="agent"
                  tick={{ fill: "hsl(240, 5%, 55%)", fontSize: 10, fontFamily: "monospace" }}
                />
                <PolarRadiusAxis
                  tick={{ fill: "hsl(240, 5%, 35%)", fontSize: 9 }}
                  axisLine={false}
                />
                <Radar
                  name="Current Tasks"
                  dataKey="tasks"
                  stroke="hsl(193, 100%, 50%)"
                  fill="hsl(193, 100%, 50%)"
                  fillOpacity={0.15}
                  strokeWidth={2}
                />
                <Radar
                  name="Progress"
                  dataKey="progress"
                  stroke="hsl(48, 100%, 52%)"
                  fill="hsl(48, 100%, 52%)"
                  fillOpacity={0.1}
                  strokeWidth={2}
                />
                <Tooltip content={<CustomTooltip />} />
              </RadarChart>
            </ResponsiveContainer>
          </GlassCard>
        </motion.div>

        <motion.div custom={9} variants={cardVariants} initial="hidden" animate="visible">
          <GlassCard className="p-5">
            <h3 className="text-xs font-mono text-muted-foreground uppercase tracking-wider mb-4">
              Project Health
            </h3>
            <div className="space-y-4">
              {projectHealth.map((p) => {
                const healthColor =
                  p.health === "on_track"
                    ? "text-accent-green"
                    : p.health === "at_risk"
                      ? "text-accent-gold"
                      : "text-accent-red";
                const healthLabel = p.health.replace("_", " ").toUpperCase();
                return (
                  <div key={p.name} className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span
                          className="w-2 h-2 rounded-full"
                          style={{ backgroundColor: p.color }}
                        />
                        <span className="text-sm font-medium text-foreground">{p.name}</span>
                      </div>
                      <div className="flex items-center gap-3">
                        <span className={`text-[10px] font-mono font-bold ${healthColor}`}>
                          {healthLabel}
                        </span>
                        <span className="text-xs font-mono text-muted-foreground">
                          {p.progress}%
                        </span>
                      </div>
                    </div>
                    <div className="h-1.5 rounded-full bg-secondary overflow-hidden">
                      <motion.div
                        className="h-full rounded-full"
                        style={{ backgroundColor: p.color }}
                        initial={{ width: 0 }}
                        animate={{ width: `${p.progress}%` }}
                        transition={{ type: "spring", stiffness: 200, damping: 25, delay: 0.3 }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </GlassCard>
        </motion.div>
      </div>
    </div>
  );
}
