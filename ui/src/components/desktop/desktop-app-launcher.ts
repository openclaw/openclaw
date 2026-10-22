import type { DesktopSource, WorkerDesktopAppId } from "@openclaw/gateway-protocol";
import { createSignal, onSettled } from "solid-js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { formatUiError } from "../../lib/format-error.ts";
import type { DesktopPanelState } from "./desktop-panel-state.ts";

type LaunchTarget = {
  client: GatewayBrowserClient | null;
  source: DesktopSource | null;
  presented: boolean;
  state: DesktopPanelState;
  apps: readonly WorkerDesktopAppId[];
};

/** Keeps app-launch feedback scoped to the current desktop presentation. */
export function createDesktopAppLauncher(target: () => LaunchTarget) {
  const [feedback, setFeedback] = createSignal<{ app?: WorkerDesktopAppId; error?: string }>({});
  // Admission must see a same-turn launch before Solid publishes its busy indicator.
  let pending: { app: WorkerDesktopAppId } | undefined;
  onSettled(() => () => {
    pending = undefined;
  });
  const clear = () => {
    pending = undefined;
    setFeedback({});
  };
  const launch = async (app: WorkerDesktopAppId) => {
    const { client, source, presented, state, apps } = target();
    if (
      !client ||
      !presented ||
      source?.kind !== "environment" ||
      (state !== "connecting" && state !== "connected") ||
      !apps.includes(app) ||
      pending?.app === app
    ) {
      return;
    }
    const request = { app };
    pending = request;
    setFeedback(request);
    let error: string | undefined;
    try {
      await client.request("desktop.launch", { source, app });
    } catch (cause) {
      error = formatUiError(cause);
    }
    if (pending === request) {
      pending = undefined;
      setFeedback({ error });
    }
  };
  return { feedback, clear, launch };
}

export type DesktopAppLauncher = ReturnType<typeof createDesktopAppLauncher>;
