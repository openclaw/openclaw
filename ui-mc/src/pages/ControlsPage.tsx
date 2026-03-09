import { motion } from "framer-motion";
import {
  Flame,
  Users,
  Mic,
  Droplets,
  RotateCcw,
  Play,
  Pause,
  Settings2,
  Sliders,
  Bell,
  Volume2,
  Wifi,
  WifiOff,
  RefreshCw,
} from "lucide-react";
import { GlassCard } from "@/components/ui/GlassCard";
import { HeroSection } from "@/components/ui/HeroSection";
import { avatarMap } from "@/lib/avatars";
import { gateway } from "@/lib/gateway";
import { useGatewayState } from "@/lib/simulation";
import { useAgentStore } from "@/store/agentStore";
import { useUIStore, WorkMode } from "@/store/uiStore";

const MODES: { id: WorkMode; icon: typeof Flame; label: string; desc: string }[] = [
  { id: "working", icon: Flame, label: "Working", desc: "All agents active, high frequency" },
  { id: "gather", icon: Users, label: "Gather", desc: "Agents sync and pull context" },
  { id: "meeting", icon: Mic, label: "Run Meeting", desc: "Council session with status briefs" },
  { id: "cooler", icon: Droplets, label: "Water Cooler", desc: "Low priority, passive discovery" },
];

const MODELS = ["Claude 3.5", "DeepSeek R1", "GPT-4o"];

export default function ControlsPage() {
  const agents = useAgentStore((s) => s.agents);
  const resetAgents = useAgentStore((s) => s.resetAgents);
  const updateAgentStatus = useAgentStore((s) => s.updateAgentStatus);
  const {
    workMode,
    setWorkMode,
    notificationsEnabled,
    setNotificationsEnabled,
    soundEnabled,
    setSoundEnabled,
  } = useUIStore();
  const { connected, connecting, gwHost, lastSync } = useGatewayState();

  return (
    <div className="space-y-6">
      <HeroSection title="System Controls" subtitle="Master control panel" />

      {/* Working Mode */}
      <GlassCard className="p-5" hover={false}>
        <h3 className="text-sm font-medium text-foreground mb-4 flex items-center gap-2">
          <Sliders className="w-4 h-4 text-primary" /> Working Mode
        </h3>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {MODES.map((mode) => (
            <button
              key={mode.id}
              onClick={() => setWorkMode(mode.id)}
              className={`glass-panel-sm p-4 text-left transition-all ${
                workMode === mode.id ? "border-primary/40 glow-accent" : ""
              }`}
            >
              <mode.icon
                className={`w-6 h-6 mb-2 ${workMode === mode.id ? "text-primary" : "text-text-2"}`}
              />
              <div className="text-sm font-medium text-foreground">{mode.label}</div>
              <div className="text-[10px] text-text-2 mt-1">{mode.desc}</div>
            </button>
          ))}
        </div>
      </GlassCard>

      {/* Agent Controls */}
      <GlassCard className="p-5" hover={false}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-medium text-foreground flex items-center gap-2">
            <Settings2 className="w-4 h-4 text-primary" /> Agent Master Controls
          </h3>
          <button
            onClick={resetAgents}
            className="text-[10px] text-text-2 hover:text-foreground flex items-center gap-1 glass-pill px-3 py-1"
          >
            <RotateCcw className="w-3 h-3" /> Reset All
          </button>
        </div>
        <div className="space-y-2">
          {agents.map((agent) => (
            <div
              key={agent.id}
              className="flex items-center gap-3 p-3 rounded-lg bg-secondary/30 border border-border/50"
            >
              <img
                src={avatarMap[agent.id]}
                alt={agent.name}
                className="w-10 h-10 object-contain"
              />
              <div className="w-20">
                <div className="text-sm font-bold" style={{ color: agent.color }}>
                  {agent.name}
                </div>
                <div className="text-[10px] text-text-2">{agent.role}</div>
              </div>
              <span className="text-[10px] font-mono text-text-3 w-16">{agent.status}</span>

              {/* Toggle Active/Pause */}
              <button
                onClick={() =>
                  updateAgentStatus(agent.id, agent.status === "IDLE" ? "WORKING" : "IDLE")
                }
                className={`w-7 h-7 rounded-md flex items-center justify-center transition-colors ${
                  agent.status === "IDLE"
                    ? "bg-accent-green/20 text-accent-green"
                    : "bg-accent-red/20 text-accent-red"
                }`}
                title={agent.status === "IDLE" ? "Activate" : "Pause"}
              >
                {agent.status === "IDLE" ? (
                  <Play className="w-3.5 h-3.5" />
                ) : (
                  <Pause className="w-3.5 h-3.5" />
                )}
              </button>

              {/* Model selector */}
              <select className="bg-secondary text-text-2 text-[10px] font-mono rounded-md px-2 py-1 border border-border focus:outline-none focus:border-primary/40 flex-1 max-w-[120px]">
                {MODELS.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>

              {/* Stats */}
              <div className="text-[10px] font-mono text-text-3 hidden lg:block">
                {agent.tasksDone}/{agent.tasksCompleted}
              </div>
            </div>
          ))}
        </div>
      </GlassCard>

      {/* System Settings */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Gateway Connection */}
        <GlassCard className="p-5" hover={false}>
          <h3 className="text-sm font-medium text-foreground mb-3 flex items-center gap-2">
            {connected ? (
              <Wifi className="w-4 h-4 text-accent-green" />
            ) : (
              <WifiOff className="w-4 h-4 text-text-2" />
            )}
            Gateway Connection
          </h3>
          <div className="space-y-2">
            <div
              className={`glass-pill px-4 py-2 text-xs font-mono ${
                connected
                  ? "text-accent-green glow-green"
                  : connecting
                    ? "text-yellow-400"
                    : "text-text-2"
              }`}
            >
              {connected ? "● Connected" : connecting ? "◌ Connecting…" : "○ Disconnected"}
            </div>
            <div className="text-[10px] font-mono text-text-3">ws://{gwHost}</div>
            {lastSync && (
              <div className="text-[10px] text-text-3">
                Last sync: {lastSync.toLocaleTimeString()}
              </div>
            )}
            <button
              onClick={() => gateway.connect()}
              className="glass-pill px-3 py-1.5 text-[10px] font-mono text-text-2 hover:text-foreground flex items-center gap-1 transition-all"
            >
              <RefreshCw className="w-3 h-3" /> Reconnect
            </button>
          </div>
        </GlassCard>

        {/* Notification Preferences */}
        <GlassCard className="p-5" hover={false}>
          <h3 className="text-sm font-medium text-foreground mb-3 flex items-center gap-2">
            <Bell className="w-4 h-4 text-primary" /> Notifications
          </h3>
          <div className="space-y-3">
            <button
              onClick={() => setNotificationsEnabled(!notificationsEnabled)}
              className={`glass-pill px-4 py-2 text-xs font-mono transition-all flex items-center gap-2 ${
                notificationsEnabled ? "text-accent-green glow-green" : "text-text-2"
              }`}
            >
              <Bell className="w-3.5 h-3.5" />
              {notificationsEnabled ? "● Desktop Notifications On" : "○ Desktop Notifications Off"}
            </button>
            <button
              onClick={() => setSoundEnabled(!soundEnabled)}
              className={`glass-pill px-4 py-2 text-xs font-mono transition-all flex items-center gap-2 ${
                soundEnabled ? "text-accent-green glow-green" : "text-text-2"
              }`}
            >
              <Volume2 className="w-3.5 h-3.5" />
              {soundEnabled ? "● Sound Effects On" : "○ Sound Effects Off"}
            </button>
          </div>
        </GlassCard>
      </div>

      {/* System Info */}
      <GlassCard className="p-5" hover={false}>
        <h3 className="text-sm font-medium text-foreground mb-3">System Info</h3>
        <div className="space-y-2 text-[11px] font-mono">
          <div className="flex justify-between">
            <span className="text-text-2">Version</span>
            <span className="text-foreground">MAVIS v1.0.0</span>
          </div>
          <div className="flex justify-between">
            <span className="text-text-2">Agents Online</span>
            <span className="text-accent-green">
              {agents.filter((a) => a.status !== "IDLE").length}/{agents.length}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-text-2">State Storage</span>
            <span className="text-foreground">localStorage</span>
          </div>
          <div className="flex justify-between">
            <span className="text-text-2">Default Model</span>
            <span className="text-primary">Claude 3.5</span>
          </div>
        </div>
      </GlassCard>
    </div>
  );
}
