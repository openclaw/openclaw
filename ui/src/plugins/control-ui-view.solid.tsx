import type { BoardGetParams } from "@openclaw/gateway-protocol";
import { insert, type JSX } from "@solidjs/web";
import { createRoot, createSignal, getOwner, onSettled, runWithOwner, Show } from "solid-js";
import type {
  ControlUiAccessoryRegistration,
  ControlUiAccessoryProps,
  ControlUiSurface,
  ControlUiSurfaceProps,
  ControlUiView,
  ControlUiViewContext,
} from "../../../src/plugin-sdk/control-ui.js";
import { formatUiError } from "../lib/format-error.ts";
import { useOptionalApplication } from "../lib/reactive/context.ts";
import { t } from "../lib/reactive/i18n.ts";
import { listen } from "../lib/reactive/listener.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../lib/solid-bridge.ts";
import type { ControlUiRegistration } from "./control-ui-capability.ts";
import { observeSolidBridgeProperties } from "./control-ui-properties.ts";
import { scopeControlUiHost } from "./control-ui-scope.ts";
import type { PluginSurfaceProps } from "./control-ui-surfaces.solid.tsx";

export type ViewKind =
  | "pages"
  | "panels"
  | "accessories"
  | "widgets"
  | "inlineViews"
  | "replacements";

type ViewRegistration = ControlUiRegistration<{ mount: ControlUiView<unknown> }>;
type PluginViewProps = {
  kind: ViewKind;
  contributionKey: string;
  surface: ControlUiSurface;
  props: unknown;
  fallback?: () => JSX.Element;
  mountDefaultView: ((target: HTMLElement) => () => void) | undefined;
  mountReplacementCompanion: ((target: HTMLElement) => () => void) | undefined;
  presented: boolean;
};
type PluginViewElement = SolidBridgeElement<
  PluginViewProps,
  { focus(options?: FocusOptions): void }
>;

function MountedContent(props: { mount?: (target: HTMLElement) => () => void }) {
  return (
    <Show when={props.mount} keyed>
      {(mount) => {
        let container!: HTMLDivElement;
        onSettled(() => mount(container));
        return <div style={{ display: "contents" }} ref={(element) => (container = element)} />;
      }}
    </Show>
  );
}

const views = new WeakMap<
  HTMLElement,
  { connected(): void; focus(options?: FocusOptions): void }
>();

function PluginViewContent(props: PluginViewProps, host: PluginViewElement) {
  const context = useOptionalApplication();
  const [error, setError] = createSignal("", { ownedWrite: true });
  const [mountGeneration, setMountGeneration] = createSignal(0, { ownedWrite: true });
  const [delegated, setDelegated] = createSignal(false, { ownedWrite: true });
  let registration: ViewRegistration | undefined;
  let mountAbort: AbortController | undefined;
  let composerGeneration = 0;
  let ownerChanged = false;
  let handle: ReturnType<ControlUiView<unknown>>;
  let viewContext: ControlUiViewContext<unknown> | undefined;
  let disposed = false;
  let pendingMount: (() => void) | undefined;
  const defaultContainers = new Map<HTMLElement, () => void>();
  host.style.display = "contents";
  const resolveRegistration = (): ViewRegistration | undefined => {
    const runtime = context?.plugins;
    const entry =
      host.kind === "replacements"
        ? runtime?.selectedReplacement(host.surface)
        : runtime
            ?.registrations(host.kind)
            .find((candidate) => candidate.key === host.contributionKey);
    // SAFETY: host renderers pair each registry kind/surface with its SDK props; this mount erases that pair.
    return entry as ViewRegistration | undefined;
  };
  registration = resolveRegistration();
  const [available, setAvailable] = createSignal(Boolean(registration));
  const unmount = () => {
    pendingMount = undefined;
    mountAbort?.abort();
    mountAbort = undefined;
    const previous = handle;
    handle = undefined;
    try {
      previous?.dispose?.();
    } catch (failure) {
      context?.plugins.reportError(registration?.pluginId ?? "host", failure);
    }
    for (const dispose of defaultContainers.values()) {
      dispose();
    }
    defaultContainers.clear();
    viewContext = undefined;
    if (!disposed) {
      setMountGeneration((generation) => generation + 1);
      setDelegated(false);
    }
  };
  const scheduleSync = observeSolidBridgeProperties(
    host,
    ["props", "presented", "kind", "contributionKey", "surface", "mountDefaultView"],
    (key, before, after) => {
      if (key === "presented") {
        composerGeneration += 1;
        return;
      }
      if (key === "kind" || key === "contributionKey" || key === "surface") {
        ownerChanged = true;
        mountAbort?.abort();
        return;
      }
      if (key !== "props") {
        return;
      }
      // SAFETY: the prior bridge value is a host-rendered SDK props record; page props may omit session identity.
      const previous = before as
        | (Partial<BoardGetParams> & { toolCallId?: string; identity?: string })
        | undefined;
      // SAFETY: the next bridge value follows the same host-rendered SDK props contract.
      const next = after as
        | (Partial<BoardGetParams> & { toolCallId?: string; identity?: string })
        | undefined;
      if (
        previous?.sessionKey !== next?.sessionKey ||
        previous?.agentId !== next?.agentId ||
        (host.kind === "inlineViews" && previous?.toolCallId !== next?.toolCallId) ||
        (host.kind === "accessories" && previous?.identity !== next?.identity)
      ) {
        ownerChanged = true;
        mountAbort?.abort();
      }
    },
    sync,
  );
  // Registration replacement must abort the outgoing mount before Solid renders its successor.
  onSettled(() =>
    context?.plugins.subscribe(() => {
      const next = resolveRegistration();
      if (registration?.value !== next?.value || registration?.signal !== next?.signal) {
        ownerChanged = true;
        mountAbort?.abort();
      }
      scheduleSync();
    }),
  );
  const scopedProps = (signal: AbortSignal): unknown => {
    const generation = composerGeneration;
    const check = () => {
      if (
        disposed ||
        !host.isConnected ||
        !host.presented ||
        generation !== composerGeneration ||
        signal.aborted ||
        registration?.signal.aborted
      ) {
        throw new Error("This plugin UI view has ended.");
      }
    };
    if (host.kind === "accessories") {
      // SAFETY: the registry kind identifies the SDK accessory discriminant and host-rendered props.
      const accessory = registration?.value as ControlUiAccessoryRegistration | undefined;
      if (accessory?.placement === "composer-decoration") {
        // SAFETY: this slot is rendered only with the matching typed host geometry and actions.
        const value = host.props as ControlUiAccessoryProps["composer-decoration"];
        return {
          ...value,
          composerElements: () => {
            check();
            return value.composerElements();
          },
          onVisitsDisabled: () => {
            check();
            value.onVisitsDisabled();
          },
        };
      }
      if (accessory?.placement === "ambient-appearance") {
        // SAFETY: the checked Settings slot supplies these browser-local preference actions.
        const value = host.props as ControlUiAccessoryProps["ambient-appearance"];
        return {
          ...value,
          onChange: (change: Parameters<typeof value.onChange>[0]) => {
            check();
            value.onChange(change);
          },
        };
      }
      if (accessory?.placement === "tab-icon") {
        // SAFETY: the checked artwork slot supplies the selected value and its host setter.
        const value = host.props as ControlUiAccessoryProps["tab-icon"];
        return {
          ...value,
          onChange: (next: string) => {
            check();
            value.onChange(next);
          },
        };
      }
    }
    if (host.kind !== "replacements" || host.surface !== "composer") {
      return structuredClone(host.props);
    }
    // SAFETY: host renderers supply SDK composer props for the kind and surface checked above.
    const value = host.props as ControlUiSurfaceProps["composer"];
    return {
      ...value,
      setDraft: (text: string) => {
        check();
        value.setDraft(text);
      },
      send: async () => {
        check();
        const result = await value.send();
        check();
        return result;
      },
      abort: value.abort
        ? () => {
            check();
            value.abort!();
          }
        : undefined,
    };
  };
  const fail = (failure: unknown) => {
    const pluginId = registration?.pluginId ?? "host";
    unmount();
    setError(formatUiError(failure));
    context?.plugins.reportError(pluginId, failure);
  };
  const update = () => {
    if (!mountAbort || !viewContext || !registration) {
      return;
    }
    try {
      viewContext = {
        ...viewContext,
        props: scopedProps(mountAbort.signal),
        presented: host.presented,
      };
      handle?.update?.(viewContext);
    } catch (failure) {
      fail(failure);
    }
  };
  function sync() {
    // A retired host can remain queued until its owner commits the replacement.
    if (!host.isConnected) {
      return;
    }
    const next = resolveRegistration();
    if (
      registration?.value !== next?.value ||
      registration?.signal !== next?.signal ||
      ownerChanged
    ) {
      ownerChanged = false;
      unmount();
      registration = next;
      setAvailable(Boolean(next));
      setError("");
    }
    update();
  }
  const mount = (container: HTMLElement) => {
    if (!host.isConnected || disposed || !registration || registration.signal.aborted) {
      return;
    }
    const abort = new AbortController();
    mountAbort = abort;
    listen(registration.signal, "abort", unmount, { once: true, signal: abort.signal });
    try {
      viewContext = {
        reportError: (failure) => {
          if (mountAbort === abort && !abort.signal.aborted && host.isConnected && !disposed) {
            fail(failure);
          }
        },
        host: scopeControlUiHost(registration.host, abort.signal, () => host.isConnected),
        signal: abort.signal,
        props: scopedProps(abort.signal),
        presented: host.presented,
        mountDefault: (target) => {
          if (!host.isConnected || abort.signal.aborted) {
            throw new Error("This plugin UI view has ended.");
          }
          defaultContainers.get(target)?.();
          const dispose = host.mountDefaultView?.(target) ?? (() => {});
          defaultContainers.set(target, dispose);
          setDelegated(true);
          return () => {
            if (defaultContainers.get(target) !== dispose) {
              return;
            }
            defaultContainers.delete(target);
            dispose();
            if (!disposed) {
              setDelegated(defaultContainers.size > 0);
            }
          };
        },
      };
      const mounted = registration.value.mount(container, viewContext);
      // A plugin can report a synchronous failure before returning its disposer.
      if (abort.signal.aborted) {
        mounted?.dispose?.();
      } else {
        handle = mounted;
      }
    } catch (failure) {
      fail(failure);
    }
  };
  function ViewRoot() {
    // Plugins may mount host Solid content, which must inherit this retained root.
    const viewOwner = getOwner();
    let container!: HTMLDivElement;
    onSettled(() => {
      // A routed page can settle inside a workspace that its replacement inserts later.
      pendingMount = () => {
        pendingMount = undefined;
        runWithOwner(viewOwner, () => mount(container));
      };
      if (host.isConnected) {
        pendingMount();
      }
    });
    return (
      <div
        data-plugin-view-root
        style={{ display: "contents" }}
        ref={(element) => {
          container = element;
        }}
      />
    );
  }
  onSettled(() => {
    views.set(host, {
      connected: () => pendingMount?.(),
      focus(options) {
        if (handle?.focus) {
          handle.focus();
        } else {
          // The plugin owns its markup; focus falls back to its first editable control.
          const input = host.querySelector<HTMLElement>("textarea, input, [contenteditable=true]");
          if (input) {
            input.focus(options);
          } else {
            HTMLElement.prototype.focus.call(host, options);
          }
        }
      },
    });
    return () => {
      disposed = true;
      unmount();
      views.delete(host);
    };
  });
  return (
    <>
      <Show when={error()}>
        <div class="card" role="alert">
          {error()}
          <button class="btn btn--sm" onClick={() => setError("")}>
            {t("pluginUi.retryView")}
          </button>
        </div>
      </Show>
      <Show
        when={available() && !error()}
        fallback={
          <>
            {props.fallback?.()}
            <MountedContent mount={props.mountDefaultView} />
          </>
        }
      >
        <Show when={!delegated()}>
          <MountedContent mount={props.mountReplacementCompanion} />
        </Show>
        <Show when={mountGeneration() + 1} keyed>
          {(_generation) => <ViewRoot />}
        </Show>
      </Show>
    </>
  );
}

export const PluginView = defineSolidBridge<
  PluginViewProps,
  { focus(options?: FocusOptions): void }
>("openclaw-plugin-view", PluginViewContent, {
  properties: {
    kind: { default: "replacements", attribute: false },
    contributionKey: { default: "", attribute: false },
    surface: { default: "workspace", attribute: false },
    props: { default: {}, attribute: false },
    fallback: { default: undefined, attribute: false },
    mountDefaultView: { default: undefined, attribute: false },
    mountReplacementCompanion: { default: undefined, attribute: false },
    presented: { default: true, type: Boolean },
  },
  connected: (host) => views.get(host)?.connected(),
  methods: { focus: (host, options) => views.get(host)?.focus(options) },
});

export function PluginReplacement<S extends ControlUiSurface>(props: PluginSurfaceProps<S>) {
  // Delegated mounts retain the host owner inside the replacement.
  const owner = getOwner();
  const mount = (target: HTMLElement, view: () => JSX.Element) =>
    runWithOwner(owner, () =>
      createRoot((dispose) => {
        // The plugin owns the target and may keep controls beside this delegated view.
        const start = document.createComment("plugin-default-start");
        const end = document.createComment("plugin-default-end");
        target.append(start, end);
        insert(target, view(), end);
        return () => {
          dispose();
          while (start.nextSibling && start.nextSibling !== end) {
            target.removeChild(start.nextSibling);
          }
          start.remove();
          end.remove();
        };
      }),
    );
  function DefaultView() {
    // Preserve the transparent legacy host: direct-child CSS selectors depend on it.
    return <span style={{ display: "contents" }}>{props.renderDefault()}</span>;
  }
  const mountDefault = (target: HTMLElement) => mount(target, DefaultView);
  const mountCompanion = (target: HTMLElement) =>
    mount(target, () => <>{props.renderCompanion?.()}</>);
  let host!: HTMLElement;
  onSettled(() => props.replacementRef?.(host));
  return (
    <PluginView
      ref={(element) => {
        host = element;
      }}
      data-plugin-composer={props.surface === "composer" ? "" : undefined}
      surface={props.surface}
      props={props.props}
      presented={props.presented}
      mountDefaultView={mountDefault}
      mountReplacementCompanion={mountCompanion}
    />
  );
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-plugin-view": PluginViewElement;
  }
}
