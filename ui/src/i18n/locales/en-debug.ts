import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

// Diagnostic data copy loads with its content; panel headings and labels stay eager.
const enDebug = {
  debug: {
    snapshotsTitle: "Snapshots",
    snapshotsSubtitle:
      "Refresh to update status and health snapshots. Heartbeat data updates live.",
    offlineSnapshots: "Reconnect to refresh diagnostics.",
    status: "Status",
    health: "Health",
    lastHeartbeat: "Last heartbeat",
    security: {
      audit: "Security audit",
      critical: "{count} critical",
      warnings: "{count} warnings",
      noCriticalIssues: "No critical issues",
      info: "{count} info",
      runPrefix: "Run",
      runSuffix: "for details.",
    },
    manualRpcTitle: "Manual RPC",
    manualRpcSubtitle: "Send a raw Gateway method with JSON params.",
    callFailed: "Couldn’t call this method. Check the parameters and try again.",
    method: "Method",
    selectMethod: "Select a method…",
    paramsJson: "Params (JSON)",
    modelsTitle: "Models",
    modelsSubtitle: "Model catalog captured by the latest diagnostic refresh.",
    eventLogTitle: "Event log",
    eventLogSubtitle: "Latest Gateway events.",
    noEvents: "No events yet.",
    lanes: {
      title: "Lanes",
      subtitle: "Live command-lane capacity and queue pressure.",
      lane: "Lane",
      sessionLanes: "Session lanes · {count}",
      active: "Active",
      activePerSession: "{active} · {limit}/session",
      queued: "Queued",
      group: "Group",
      blocked: "Blocked",
    },
    overlay: {
      title: en.debug.overlay.title,
      eyebrow: "Live diagnostics",
      move: "Move system busyness with arrow keys, or drag",
      minimize: "Minimize system busyness",
      expand: "Expand system busyness",
      open: "Open overlay",
      openWithShortcut: "Open overlay · {shortcut}",
      unavailable: "Unavailable",
      lanes: "Lanes",
      status: "Event loop / status",
      activeRuns: "Active runs",
      events: "Events",
      cpu: "CPU",
      memory: "Memory",
      ping: "Ping",
      pingMs: "{value} ms",
      pingDescription: "Gateway round-trip time",
      disk: "Disk",
      memoryMb: "{value} MB",
      gatewayCpu: "Gateway CPU",
      cpuCores: "{value} cores",
      gatewayCpuScope: "Process only",
      cpuScopeDescription:
        "Process/thread: 100% = one core. Host: 100% = all cores. Build and tool subprocesses are excluded.",
      gatewayCpuProcess: "Gateway process",
      cpuBreakdown: "Show Gateway CPU breakdown",
      cpuBreakdownCurrent: "CPU usage",
      hostShort: "Host {value}",
      hostCpu: "Host CPU",
      hostCpuCount: "Host · {count} logical CPUs",
      mainThreadCpu: "Main thread",
      workerCpu: "Worker threads",
      otherThreadCpu: "Other threads",
      loopUtilization: "Event loop busy",
      heapShort: "heap {value}",
      maxShort: "max {value}",
      freeShort: "{value} free",
      totalShort: "{value} total",
      delayP99: "Delay p99",
      uptime: "Uptime",
      activeRunsCount: "{count} active",
      noActiveRuns: "No active runs.",
    },
  },
} satisfies TranslationMap;

export const registerDebugEnglish = Object.assign(
  () => {
    const { lanes, overlay, ...sections } = enDebug.debug;
    // Preserve the eager namespaces and their existing readers.
    Object.assign(en.debug, sections);
    Object.assign(en.debug.lanes, lanes);
    Object.assign(en.debug.overlay, overlay);
  },
  { catalog: enDebug },
);
