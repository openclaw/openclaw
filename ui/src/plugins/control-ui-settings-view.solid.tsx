import { createEffect, onSettled } from "solid-js";
import type {
  ControlUiSettingsContext,
  ControlUiSettingsView,
  ControlUiSettingsSnapshot,
} from "../../../src/plugin-sdk/control-ui-settings.js";
import type { ApplicationContext } from "../app/context.ts";
import { hasOperatorReadAccess } from "../app/operator-access.ts";
import { formatUiError } from "../lib/format-error.ts";
import { formatRelativeTimestamp } from "../lib/format.ts";
import { listen } from "../lib/reactive/listener.ts";
import { createControlUiSettingsComponents } from "./control-ui-settings-components.solid.tsx";

function authority(snapshot: ControlUiSettingsSnapshot): string {
  return JSON.stringify([
    snapshot.agentId,
    snapshot.engine,
    snapshot.connected,
    snapshot.advertisedMethods,
    snapshot.connectionEpoch,
    snapshot.routeIntent,
  ]);
}

export function ControlUiSettingsPresentation(props: {
  application: ApplicationContext;
  placement: ControlUiSettingsView["placement"];
  readSnapshot: () => ControlUiSettingsSnapshot;
  subscribe: (listener: () => void) => () => void;
  navigate: ControlUiSettingsContext["navigate"];
  refreshAgents: () => void;
}) {
  let container: HTMLDivElement | undefined;
  let active = true;
  let owner:
    | {
        abort: AbortController;
        identity: string;
        update?: (snapshot: ControlUiSettingsSnapshot) => void;
        dispose?: () => void;
      }
    | undefined;
  const retire = () => {
    const previous = owner;
    owner = undefined;
    previous?.abort.abort();
    try {
      previous?.dispose?.();
    } catch (error) {
      props.application.plugins.reportError("host", error);
    } finally {
      container?.replaceChildren();
    }
  };
  const fail = (error: unknown) => {
    retire();
    container?.append(formatUiError(error, "Settings presentation could not load."));
  };
  const sync = () => {
    if (!active || !container) {
      return;
    }
    const snapshot = props.readSnapshot();
    const identity = authority(snapshot);
    if (owner?.identity === identity) {
      try {
        owner.update?.(snapshot);
      } catch (error) {
        fail(error);
      }
      return;
    }
    retire();
    const next: NonNullable<typeof owner> = { abort: new AbortController(), identity };
    let lifetime = next.abort.signal;
    owner = next;
    const current = () => {
      lifetime.throwIfAborted();
      if (!active || owner !== next || authority(props.readSnapshot()) !== identity) {
        throw new Error("This Settings presentation has ended.");
      }
    };
    void props.application.plugins
      .loadSettingsView(props.placement, next.abort.signal)
      .then((loaded) => {
        lifetime = loaded.signal;
        current();
        const context: ControlUiSettingsContext = {
          props: props.readSnapshot(),
          signal: lifetime,
          components: createControlUiSettingsComponents(lifetime),
          async request<T>(method: string, params?: unknown) {
            current();
            const gateway = props.application.gateway.snapshot;
            if (
              !gateway.client ||
              gateway.phase !== "connected" ||
              !hasOperatorReadAccess(gateway.hello?.auth ?? null)
            ) {
              throw new Error("The Gateway is offline or operator access is unavailable.");
            }
            const result = await gateway.client.request<T>(method, params);
            current();
            return result;
          },
          navigate(destination) {
            current();
            props.navigate(destination);
          },
          refreshAgents() {
            current();
            props.refreshAgents();
          },
          formatRelativeTimestamp(timestamp) {
            current();
            return formatRelativeTimestamp(timestamp);
          },
          formatError(error) {
            current();
            return formatUiError(error);
          },
        };
        const mounted = loaded.view.mount(container!, context);
        // The runtime owns assets through abort; this owner disposes only the mounted view.
        next.dispose = () => mounted.dispose();
        if (lifetime.aborted || owner !== next) {
          next.dispose();
          return;
        }
        // The loaded view's abort also owns retirement of its mounted presentation.
        listen(
          lifetime,
          "abort",
          () => {
            if (owner === next) {
              retire();
            }
          },
          { once: true },
        );
        next.update = mounted.update;
        mounted.update(props.readSnapshot());
      })
      .catch((error: unknown) => {
        if (owner === next && !next.abort.signal.aborted) {
          fail(error);
        }
      });
  };
  // The imperative plugin view receives live host props; transport owners also
  // notify synchronously so a batched disconnect/reconnect retires old authority.
  createEffect(props.readSnapshot, sync);
  onSettled(() => {
    const stop = props.subscribe(sync);
    sync();
    return () => {
      active = false;
      stop();
      retire();
    };
  });
  return (
    <div
      style={{ display: "contents" }}
      ref={(node) => {
        container = node;
      }}
    />
  );
}
