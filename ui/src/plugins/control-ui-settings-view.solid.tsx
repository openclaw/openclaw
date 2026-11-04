import { onSettled } from "solid-js";
import type {
  ControlUiSettingsContext,
  ControlUiSettingsView,
  ControlUiSettingsSnapshot,
} from "../../../src/plugin-sdk/control-ui-settings.js";
import type { ApplicationContext } from "../app/context.ts";
import { gatewayPresentationScope } from "../app/gateway-presentation-scope.ts";
import { hasOperatorReadAccess } from "../app/operator-access.ts";
import { formatUiError } from "../lib/format-error.ts";
import { formatRelativeTimestamp } from "../lib/format.ts";
import { listen } from "../lib/reactive/listener.ts";
import { createControlUiSettingsComponents } from "./control-ui-settings-components.solid.tsx";

/**
 * Facts that end a mounted view. Connection state and the transport epoch reach the
 * view through update(), so a same-client reconnect keeps its presentation and drafts.
 */
function viewLifetime(application: ApplicationContext, snapshot: ControlUiSettingsSnapshot) {
  const gateway = application.gateway.snapshot;
  return {
    client: gateway.client,
    key: JSON.stringify([
      gatewayPresentationScope(application.gateway).key,
      // A transport drop retains hello; a connect rejection clears it.
      gateway.hello ? hasOperatorReadAccess(gateway.hello.auth ?? null) : null,
      snapshot.agentId,
      snapshot.engine.kind,
      snapshot.engine.id,
      snapshot.advertisedMethods,
      snapshot.routeIntent,
    ]),
  };
}

function sameLifetime(a: ReturnType<typeof viewLifetime>, b: ReturnType<typeof viewLifetime>) {
  return a.client === b.client && a.key === b.key;
}

export function ControlUiSettingsPresentation(props: {
  application: ApplicationContext;
  placement: ControlUiSettingsView["placement"];
  readSnapshot: () => ControlUiSettingsSnapshot | null;
  subscribe: (listener: () => void) => () => void;
  navigate: ControlUiSettingsContext["navigate"];
  refreshAgents: () => void;
}) {
  let container: HTMLDivElement | undefined;
  let active = true;
  let owner:
    | {
        abort: AbortController;
        identity: ReturnType<typeof viewLifetime>;
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
    if (!snapshot) {
      retire();
      return;
    }
    const identity = viewLifetime(props.application, snapshot);
    if (owner && sameLifetime(owner.identity, identity)) {
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
      const currentSnapshot = props.readSnapshot();
      if (
        !currentSnapshot ||
        !active ||
        owner !== next ||
        !sameLifetime(identity, viewLifetime(props.application, currentSnapshot))
      ) {
        throw new Error("This Settings presentation has ended.");
      }
      return currentSnapshot;
    };
    void props.application.plugins
      .loadSettingsView(props.placement, next.abort.signal)
      .then((loaded) => {
        lifetime = loaded.signal;
        const loadedSnapshot = current();
        const context: ControlUiSettingsContext = {
          props: loadedSnapshot,
          signal: lifetime,
          components: createControlUiSettingsComponents(lifetime),
          async request<T>(method: string, params?: unknown) {
            const requestSnapshot = current();
            const gateway = props.application.gateway.snapshot;
            const epoch = requestSnapshot.connectionEpoch;
            if (
              !gateway.client ||
              gateway.phase !== "connected" ||
              !hasOperatorReadAccess(gateway.hello?.auth ?? null)
            ) {
              throw new Error("The Gateway is offline or operator access is unavailable.");
            }
            const result = await gateway.client.request<T>(method, params);
            // The view survives reconnects; replies from an earlier transport epoch do not.
            if (current().connectionEpoch !== epoch) {
              throw new Error("The Gateway connection changed before this request completed.");
            }
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
        mounted.update(current());
      })
      .catch((error: unknown) => {
        if (owner === next && !next.abort.signal.aborted) {
          fail(error);
        }
      });
  };
  // Owner notifications retire authority synchronously and publish committed presentation facts.
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
