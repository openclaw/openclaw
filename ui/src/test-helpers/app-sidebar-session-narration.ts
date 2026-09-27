import { vi } from "vitest";
import {
  SidebarSessionNarrationController,
  type SidebarNarrationSyncInput,
} from "../components/app-sidebar-session-narration.ts";
import type { SidebarRecentSession } from "../components/app-sidebar-session-types.ts";

export function runningRow(key: string): SidebarRecentSession {
  return {
    key,
    label: "Run",
    renameValue: "",
    updatedAt: Date.now(),
    active: false,
    visuallyActive: false,
    hasActiveRun: true,
    modelSelectionLocked: false,
    pinned: false,
    pinnable: true,
    cloudWorkerStopAction: null,
    hasAutomation: false,
    unread: false,
    attention: { kind: "none" },
    startedAt: 1,
    childSessionKeys: [],
    children: [],
    isChild: false,
    loadingChildren: false,
    containsActiveDescendant: false,
    runningChildCount: 0,
    failedChildCount: 0,
  };
}

export function createRunningNarrationController(source: SidebarNarrationSyncInput["source"]) {
  const updates: Array<ReadonlyMap<string, string>> = [];
  const controller = new SidebarSessionNarrationController((lines) => updates.push(lines));
  const input: SidebarNarrationSyncInput = {
    enabled: true,
    connected: true,
    connectionIdentity: {},
    source,
    openSessionKey: "",
    rows: [runningRow("agent:main:run")],
    agentId: "main",
  };
  controller.sync(input);
  return { controller, updates, input };
}

export function browserVisibility(initial: DocumentVisibilityState = "visible") {
  let visibility = initial;
  const events = new EventTarget();
  Object.defineProperty(events, "visibilityState", { get: () => visibility });
  vi.stubGlobal("document", events);
  return (next: DocumentVisibilityState) => {
    visibility = next;
    events.dispatchEvent(new Event("visibilitychange"));
  };
}
