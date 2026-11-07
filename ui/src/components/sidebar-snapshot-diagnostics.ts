import type { AppSidebarOwner } from "./app-sidebar-owner.tsx";
import type { createSidebarSnapshot } from "./sidebar-snapshot.ts";

// Decode only when diagnostics are requested; names and prerequisite reads stay off boot.
export function readSidebarSnapshotCaptureDiagnostics(
  snapshot: ReturnType<typeof createSidebarSnapshot>,
) {
  const [
    lastCapture,
    scheduled,
    connected,
    pending,
    saved,
    scopeReady,
    identityReady,
    cachedDisplay,
    captured,
    settled,
  ] = snapshot.diagnostics();
  return {
    lastCapture,
    scheduled,
    connected,
    pending,
    saved,
    scopeReady,
    identityReady,
    cachedDisplay,
    captured,
    settled,
  };
}

export function readSidebarSnapshotDiagnostics(owner: AppSidebarOwner) {
  const context = owner.sessionDataContext;
  return {
    ...readSidebarSnapshotCaptureDiagnostics(owner.snapshot),
    windowReady: owner.scroll?.windowKeys() !== undefined,
    bootRosterReady: context.sessions.captureBootRoster() !== null,
    agentsReady: context.agents.state.agentsList !== null,
    registryStatus: context.plugins.registryStatus,
    pluginSnapshot: Boolean(owner.sidebarPluginSnapshot),
    sessionsLoading: owner.sessionData.sessionsLoading,
    canonicalListReady: context.sessions.canonicalListReady,
    presentationReady: Boolean(context.sessions.presentation.result),
    presentationCached: context.sessions.presentation.resultCached,
    sessionListError: owner.sessionData.sessionListError !== null,
    sessionsError: context.sessions.state.error !== null,
  };
}
