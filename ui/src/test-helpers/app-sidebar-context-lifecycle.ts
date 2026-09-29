import { createAgentSelectionCapability } from "../app/agent-selection.ts";
import { createApplicationTheme } from "../app/bootstrap-theme.ts";
import { createConnectionBootstrapCoordinator } from "../app/connection-bootstrap.ts";
import type { ApplicationGateway } from "../app/context.ts";
import { loadSettings, patchSettings } from "../app/settings.ts";

const cleanups = new Set<() => void>();

export function createSidebarContextLifecycle(
  gateway: ApplicationGateway,
  agents: Parameters<typeof createAgentSelectionCapability>[1],
  selectedAgentId: string,
) {
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
  cleanups.add(() => {
    stopBootstrap();
    connectionBootstrap.reset();
    agentSelection.dispose();
    theme.dispose();
  });
  return { theme, agentSelection, connectionBootstrap };
}

export function disposeSidebarContextLifecycles() {
  for (const cleanup of cleanups) {
    cleanup();
  }
  cleanups.clear();
}
