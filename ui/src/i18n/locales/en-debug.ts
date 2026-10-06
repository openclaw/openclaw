import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

// Diagnostic data copy loads with its content; panel headings and labels stay eager.
const enDebug = {
  debug: {
    snapshotsTitle: "Snapshots",
    snapshotsSubtitle:
      "Refresh to update status and health snapshots. Heartbeat data updates live.",
    offlineSnapshots: "Connect to the Gateway to refresh diagnostics.",
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
    manualRpcSubtitle: "Send a raw gateway method with JSON params.",
    callFailed: "Call failed",
    method: "Method",
    selectMethod: "Select a method…",
    paramsJson: "Params (JSON)",
    modelsTitle: "Models",
    modelsSubtitle: "Model catalog captured by the latest diagnostic refresh.",
    eventLogTitle: "Event Log",
    eventLogSubtitle: "Latest gateway events.",
    noEvents: "No events yet.",
    lanes: {
      title: "Lanes",
      subtitle: "Live command-lane capacity and queue pressure.",
      lane: en.debug.lanes.lane,
      sessionLanes: "Session lanes · {count}",
      active: en.debug.lanes.active,
      activePerSession: "{active} · {limit}/session",
      queued: en.debug.lanes.queued,
      group: "Group",
      blocked: en.debug.lanes.blocked,
    },
    overlay: {
      title: en.debug.overlay.title,
      eyebrow: en.debug.overlay.eyebrow,
      move: en.debug.overlay.move,
      minimize: en.debug.overlay.minimize,
      expand: en.debug.overlay.expand,
      open: "Open overlay",
      openWithShortcut: "Open overlay · {shortcut}",
      unavailable: "Unavailable",
      lanes: en.debug.overlay.lanes,
      status: en.debug.overlay.status,
      activeRuns: en.debug.overlay.activeRuns,
      events: en.debug.overlay.events,
      cpu: en.debug.overlay.cpu,
      memory: en.debug.overlay.memory,
      ping: "Ping",
      pingMs: "{value} ms",
      pingDescription: "Round-trip time for the Gateway diagnostics request",
      disk: "Disk",
      memoryMb: "{value} MB",
      gatewayCpuScope: "Gateway",
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
      delayP99: en.debug.overlay.delayP99,
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
