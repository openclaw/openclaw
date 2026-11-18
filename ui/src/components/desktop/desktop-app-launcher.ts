import type { DesktopSource, WorkerDesktopAppId } from "@openclaw/gateway-protocol";
import { action, createOptimistic, createSignal, onSettled } from "solid-js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
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
  const [attempt, setAttempt] = createSignal<{
    result: Promise<void>;
  }>();
  const [saving, setSaving] = createOptimistic(false);
  // Admission must see a same-turn launch before Solid publishes its busy indicator.
  let pending: { app: WorkerDesktopAppId; retire: () => void } | undefined;
  onSettled(() => () => {
    pending?.retire();
    pending = undefined;
  });
  const clear = () => {
    pending?.retire();
    pending = undefined;
    setAttempt(undefined);
  };
  const present = action(function* (completion: Promise<unknown>, retired: Promise<void>) {
    setSaving(true);
    yield Promise.race([completion, retired]);
  });
  const launch = (app: WorkerDesktopAppId) => {
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
    const retirement = Promise.withResolvers<void>();
    const request = { app, retire: () => retirement.resolve() };
    pending?.retire();
    pending = request;
    const result = present(client.request("desktop.launch", { source, app }), retirement.promise);
    setAttempt({ result });
    void result
      .catch(() => {})
      .finally(() => {
        if (pending === request) {
          pending = undefined;
        }
      });
  };
  return {
    launchingApp: () => (saving() ? (pending?.app ?? null) : null),
    outcome: attempt,
    clear,
    launch,
  };
}

export type DesktopAppLauncher = ReturnType<typeof createDesktopAppLauncher>;
