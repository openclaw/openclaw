import { createAgentSelectionCapability } from "../app/agent-selection.ts";
import { createApplicationTheme } from "../app/bootstrap-theme.ts";
import type { ApplicationGateway } from "../app/context.ts";
import { loadSettings, patchSettings } from "../app/settings.ts";

const cleanups = new Set<() => void>();

export function createSidebarContextLifecycle(
  gateway: ApplicationGateway,
  agents: Parameters<typeof createAgentSelectionCapability>[1],
  selectedAgentId: string,
) {
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
    agentSelection.dispose();
    theme.dispose();
  });
  return { theme, agentSelection };
}

export function disposeSidebarContextLifecycles() {
  for (const cleanup of cleanups) {
    cleanup();
  }
  cleanups.clear();
}
