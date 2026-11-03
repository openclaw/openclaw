import { onTestFinished } from "vitest";
import type { GatewaySessionRow } from "../api/types.ts";
import { createAgentSelectionCapability } from "../app/agent-selection.ts";
import { createApplicationTheme } from "../app/bootstrap-theme.ts";
import { createConnectionBootstrapCoordinator } from "../app/connection-bootstrap.ts";
import type { ApplicationGateway } from "../app/context.ts";
import { loadSettings, patchSettings } from "../app/settings.ts";
import { isSessionRunStateActive } from "../lib/session-run-state.ts";
import type { SessionCapability } from "../lib/sessions/index.ts";
import { preserveDocumentStyle } from "./preserve-document-style.ts";

const cleanups = new Set<() => void>();

export function createSidebarContextLifecycle(
  gateway: ApplicationGateway,
  agents: Parameters<typeof createAgentSelectionCapability>[1],
  selectedAgentId: string,
) {
  preserveDocumentStyle();
  const connectionBootstrap = createConnectionBootstrapCoordinator();
  const synchronizeBootstrap = (snapshot: ApplicationGateway["snapshot"]) =>
    connectionBootstrap.synchronize({
      client: snapshot.client,
      connected: snapshot.phase === "connected",
    });
  synchronizeBootstrap(gateway.snapshot);
  const stopBootstrap = gateway.subscribe(synchronizeBootstrap);
  const theme = createApplicationTheme(loadSettings(gateway.connection.gatewayUrl), gateway);
  const agentSelection = createAgentSelectionCapability(
    gateway,
    agents,
    { load: () => selectedAgentId, save: () => undefined },
    {
      get settings() {
        return theme.settings;
      },
      subscribe: theme.subscribe,
      patch: patchSettings,
    },
  );
  const cleanup = () => {
    if (!cleanups.delete(cleanup)) {
      return;
    }
    stopBootstrap();
    connectionBootstrap.reset();
    agentSelection.dispose();
    theme.dispose();
  };
  cleanups.add(cleanup);
  onTestFinished(cleanup);
  return { theme, agentSelection, connectionBootstrap };
}

export function disposeSidebarContextLifecycles() {
  for (const cleanup of cleanups) {
    cleanup();
  }
  cleanups.clear();
}

/** Fixture projections borrow native custody/currentness; they do not reproduce its policy. */
export function sidebarSessionHostServices(read: () => SessionCapability | null) {
  return {
    isRunVisuallyActive: (row: GatewaySessionRow) =>
      read()?.isRunVisuallyActive(row) ?? isSessionRunStateActive(row),
    captureConnectionScope: () => read()?.captureConnectionScope() ?? null,
    isConnectionScopeCurrent: (
      scope: Parameters<SessionCapability["isConnectionScopeCurrent"]>[0],
    ) => read()?.isConnectionScopeCurrent(scope) ?? false,
  };
}
