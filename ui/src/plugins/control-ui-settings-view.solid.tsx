import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { onSettled } from "solid-js";
import type {
  ControlUiSettingsContext,
  ControlUiSettingsContextV2,
  ControlUiSettingsView,
  ControlUiSettingsSnapshot,
  ControlUiContributionSettingsSnapshot,
  ControlUiContributedSettingsView,
} from "../../../src/plugin-sdk/control-ui-settings.js";
import type { ApplicationContext } from "../app/context.ts";
import { gatewayPresentationScope } from "../app/gateway-presentation-scope.ts";
import { hasOperatorReadAccess } from "../app/operator-access.ts";
import { showConfirmDialog } from "../components/confirm-dialog.ts";
import { handleCopyButton } from "../components/copy-button-state.ts";
import { currentConfigObject } from "../lib/config/config-state-model.ts";
import { formatUiExternalText, formatUiError } from "../lib/format-error.ts";
import { formatDateTimeMs, formatRelativeTimestamp } from "../lib/format.ts";
import { t } from "../lib/reactive/i18n.ts";
import { listen } from "../lib/reactive/listener.ts";
import { projectOwner } from "../lib/reactive/projection.ts";
import { registerControlUiEnglish } from "./control-ui-english.ts";
import { createControlUiSettingsComponents } from "./control-ui-settings-components.solid.tsx";

function isMemoryView(
  view:
    | ControlUiSettingsView
    | ControlUiContributedSettingsView
    | import("../../../src/plugin-sdk/control-ui-settings.js").ControlUiChannelSettingsView,
): view is ControlUiSettingsView {
  return view.placement.section === "memory";
}
function isContributedView(
  view:
    | ControlUiSettingsView
    | ControlUiContributedSettingsView
    | import("../../../src/plugin-sdk/control-ui-settings.js").ControlUiChannelSettingsView,
): view is ControlUiContributedSettingsView {
  return view.placement.section === "profile" || view.placement.section === "agents";
}

/**
 * Facts that end a mounted view. Connection state and the transport epoch reach the
 * view through update(), so a same-client reconnect keeps its presentation and drafts.
 */
function viewLifetime(
  application: ApplicationContext,
  snapshot: ControlUiSettingsSnapshot | ControlUiContributionSettingsSnapshot,
  placement: ControlUiSettingsView["placement"] | ControlUiContributedSettingsView["placement"],
) {
  const gateway = application.gateway.snapshot;
  return {
    client: gateway.client,
    key: JSON.stringify([
      gatewayPresentationScope(application.gateway).key,
      // A transport drop retains hello; a connect rejection clears it.
      gateway.hello ? hasOperatorReadAccess(gateway.hello.auth ?? null) : null,
      placement.section === "profile" ? undefined : snapshot.agentId,
      gatewayPresentationScope(application.gateway).displayUser?.id,
      "canRead" in snapshot ? snapshot.canRead : undefined,
      "canAdmin" in snapshot ? snapshot.canAdmin : undefined,
      "engine" in snapshot ? snapshot.engine.kind : undefined,
      "engine" in snapshot ? snapshot.engine.id : undefined,
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
  placement: ControlUiSettingsView["placement"] | ControlUiContributedSettingsView["placement"];
  pluginId?: string;
  readSnapshot: () => ControlUiSettingsSnapshot | ControlUiContributionSettingsSnapshot | null;
  subscribe: (listener: () => void) => () => void;
  navigate: ControlUiSettingsContext["navigate"];
  refreshAgents: () => void;
  navigateTo?: ControlUiSettingsContextV2["navigateTo"];
}) {
  let container: HTMLDivElement | undefined;
  let active = true;
  let owner:
    | {
        abort: AbortController;
        identity: ReturnType<typeof viewLifetime>;
        update?: (
          snapshot: ControlUiSettingsSnapshot | ControlUiContributionSettingsSnapshot,
        ) => void;
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
    const identity = viewLifetime(props.application, snapshot, props.placement);
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
        !sameLifetime(identity, viewLifetime(props.application, currentSnapshot, props.placement))
      ) {
        throw new Error("This Settings presentation has ended.");
      }
      return currentSnapshot;
    };
    void props.application.plugins
      .loadSettingsView(props.placement, next.abort.signal, props.pluginId)
      .then((loaded) => {
        lifetime = loaded.signal;
        current();
        const context: Omit<ControlUiSettingsContextV2, "props"> = {
          apiVersion: 2 as const,
          readConfig(path: readonly string[]) {
            current();
            let value: unknown = currentConfigObject(props.application.runtimeConfig.state);
            for (const key of path) {
              value = isRecord(value) ? value[key] : undefined;
            }
            return value;
          },
          signal: lifetime,
          components: createControlUiSettingsComponents(lifetime),
          async request<T>(method: string, params?: unknown, options?: { signal?: AbortSignal }) {
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
            const signal =
              "id" in props.placement
                ? options?.signal
                  ? AbortSignal.any([lifetime, options.signal])
                  : lifetime
                : options?.signal;
            const result = await gateway.client.request<T>(
              method,
              params,
              signal ? { signal } : undefined,
            );
            current();
            // The view survives reconnects; replies from an earlier transport epoch do not.
            if (current().connectionEpoch !== epoch) {
              throw new Error("The Gateway connection changed before this request completed.");
            }
            return result;
          },
          registerEnglish(catalog: Parameters<ControlUiSettingsContextV2["registerEnglish"]>[0]) {
            current();
            registerControlUiEnglish(catalog);
          },
          projectOwner(source) {
            const projection = projectOwner(source, (sourceOwner) => {
              current();
              return sourceOwner.read();
            });
            const stop = listen(lifetime, "abort", projection.dispose, { once: true });
            return {
              read: projection.read,
              dispose() {
                stop();
                projection.dispose();
              },
            };
          },
          copyButton(
            event: Event,
            text: string,
            label: string,
            targets: { label?: HTMLElement; feedback?: HTMLElement; announcement?: HTMLElement },
          ) {
            current();
            return handleCopyButton(event, text, label, targets);
          },
          async runConfigMutation(task, options) {
            current();
            return props.application.runtimeConfig.runExternalMutation(
              async (client) => {
                current();
                let operationOpen = true;
                try {
                  // Accepted configuration work owns settlement and staged cleanup,
                  // even when its presentation ends while an RPC is in flight.
                  return await task({
                    request(method, params, requestOptions) {
                      const gateway = props.application.gateway.snapshot;
                      if (
                        !operationOpen ||
                        gateway.client !== client ||
                        gateway.phase !== "connected"
                      ) {
                        throw new Error("This Settings configuration operation has ended.");
                      }
                      return client.request(method, params, requestOptions);
                    },
                  });
                } finally {
                  operationOpen = false;
                }
              },
              {
                ...options,
                canDispatch: () => {
                  current();
                  return options?.canDispatch?.() !== false;
                },
              },
            );
          },
          ensureConfig() {
            current();
            // The existing config owner settles this read; it publishes no view-owned result.
            return props.application.runtimeConfig.ensureLoaded();
          },
          async confirm(options: Parameters<ControlUiSettingsContextV2["confirm"]>[0]) {
            current();
            const result = await showConfirmDialog({ ...options, signal: lifetime });
            current();
            return result;
          },
          translate: t,
          formatExternalText: formatUiExternalText,
          formatDateTime: formatDateTimeMs,
          navigateTo(destination: Parameters<ControlUiSettingsContextV2["navigateTo"]>[0]) {
            current();
            props.navigateTo?.(destination);
          },
          navigate(destination: Parameters<ControlUiSettingsContext["navigate"]>[0]) {
            current();
            props.navigate(destination);
          },
          refreshAgents() {
            current();
            props.refreshAgents();
          },
          formatRelativeTimestamp(timestamp: number) {
            current();
            return formatRelativeTimestamp(timestamp);
          },
          formatError(error: unknown) {
            current();
            return formatUiError(error);
          },
        };
        const initial = current();
        const view = loaded.view;
        let mounted: { dispose(): void };
        if (isMemoryView(view) && "engine" in initial) {
          const memory = view.mount(container!, { ...context, props: initial });
          mounted = memory;
          next.update = (updated) => {
            if ("engine" in updated) {
              memory.update(updated);
            }
          };
        } else if (isContributedView(view) && !("engine" in initial)) {
          const contributed = view.mount(container!, { ...context, props: initial });
          mounted = contributed;
          next.update = (updated) => {
            if (!("engine" in updated)) {
              contributed.update(updated);
            }
          };
        } else {
          throw new Error("Settings presentation received facts for another placement.");
        }
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
        next.update?.(current());
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
