import type { WorkerDesktopAppId, WorkerDesktopLaunchResult } from "@openclaw/gateway-protocol";
import { createSignal, onCleanup } from "solid-js";
import { formatUiError } from "../../lib/format-error.ts";
import type { DesktopPanelController } from "./desktop-panel-controller.ts";

/** Keeps app-launch feedback scoped to the current desktop presentation. */
export function createDesktopAppLauncher(target: () => DesktopPanelController["launchTarget"]) {
  const [app, setApp] = createSignal<WorkerDesktopAppId | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  // Admission must see a same-turn launch before Solid publishes its busy indicator.
  let pendingApp: WorkerDesktopAppId | null = null;
  let operationId = 0;
  onCleanup(() => {
    operationId += 1;
  });
  const clear = () => {
    operationId += 1;
    pendingApp = null;
    setApp(null);
    setError(null);
  };
  const launch = async (nextApp: WorkerDesktopAppId) => {
    const { client, source, presented, state, apps } = target();
    if (
      !client ||
      !presented ||
      source?.kind !== "environment" ||
      (state !== "connecting" && state !== "connected") ||
      !apps.includes(nextApp) ||
      pendingApp === nextApp
    ) {
      return;
    }
    const requestId = ++operationId;
    pendingApp = nextApp;
    setApp(nextApp);
    setError(null);
    try {
      await client.request<WorkerDesktopLaunchResult>("desktop.launch", { source, app: nextApp });
    } catch (cause) {
      if (requestId === operationId) {
        setError(formatUiError(cause));
      }
    }
    if (requestId === operationId) {
      pendingApp = null;
      setApp(null);
    }
  };
  return { app, error, clear, launch };
}

export type DesktopAppLauncher = ReturnType<typeof createDesktopAppLauncher>;
