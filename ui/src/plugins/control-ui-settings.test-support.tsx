import type {
  ControlUiSettingsContext,
  ControlUiSettingsSnapshot,
} from "../../../src/plugin-sdk/control-ui-settings.js";
import type { ApplicationContext } from "../app/context.ts";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { ControlUiSettingsPresentation } from "./control-ui-settings-view.solid.tsx";

export function mountSettingsPresentation(
  application: ApplicationContext,
  overrides: Partial<ControlUiSettingsSnapshot> = {},
  navigate: ControlUiSettingsContext["navigate"] = () => {},
) {
  let snapshot: ControlUiSettingsSnapshot = {
    agentId: "main",
    agentsLoading: false,
    agentsError: null,
    engine: { kind: "default", id: "memory-core", availability: "enabled" },
    connected: true,
    connectionEpoch: 1,
    routeIntent: "overview",
    locale: "en",
    ...overrides,
  };
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((listener) => listener());
  const mounted = mountSolid(() => (
    <ControlUiSettingsPresentation
      application={application}
      placement={{ section: "memory", panel: "overview" }}
      readSnapshot={() => snapshot}
      subscribe={(listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }}
      navigate={navigate}
      refreshAgents={() => {}}
    />
  ));
  return {
    ...mounted,
    notify,
    change(patch: Partial<ControlUiSettingsSnapshot>, beforeNotify?: () => void) {
      snapshot = { ...snapshot, ...patch };
      beforeNotify?.();
      notify();
    },
  };
}
