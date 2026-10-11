import type { BoardGetParams } from "@openclaw/gateway-protocol";
import { createEffect, createSignal, onCleanup, onSettled, Show } from "solid-js";
import type {
  ControlUiSurface,
  ControlUiSurfaceProps,
  ControlUiView,
  ControlUiViewContext,
} from "../../../src/plugin-sdk/control-ui.js";
import { useOptionalApplication } from "../lib/reactive/context.ts";
import { t } from "../lib/reactive/i18n.ts";
import { projectSource } from "../lib/reactive/projection.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../lit/solid-bridge.ts";
import type { ControlUiRegistration } from "./control-ui-capability.ts";
import { scopeControlUiHost } from "./control-ui-scope.ts";
import { renderPluginTemplate } from "./control-ui-view.runtime.ts";
import type { ViewKind } from "./control-ui-view.ts";

type ViewRegistration = ControlUiRegistration<{ mount: ControlUiView<unknown> }>;
export type PluginViewProps = {
  kind: ViewKind;
  contributionKey: string;
  surface: ControlUiSurface;
  props: unknown;
  defaultView: unknown;
  replacementCompanion: unknown;
  defaultHost: object | undefined;
  presented: boolean;
};
type PluginViewElement = SolidBridgeElement<
  PluginViewProps,
  { focus(options?: FocusOptions): void }
>;

/** Property writes retire authority before Solid's batched DOM commit, including A→B→A. */
export function observePluginProperties<P extends object>(
  host: SolidBridgeElement<P>,
  keys: (keyof P)[],
  changed: (key: keyof P, before: unknown, after: unknown) => void,
) {
  const descriptors = keys.map((key) => [key, Object.getOwnPropertyDescriptor(host, key)] as const);
  for (const [key, descriptor] of descriptors) {
    if (!descriptor?.get || !descriptor.set) {
      throw new Error(`Missing plugin host property: ${String(key)}`);
    }
    Object.defineProperty(host, key, {
      ...descriptor,
      set(value: unknown) {
        const before: unknown = descriptor.get?.call(host);
        descriptor.set?.call(host, value);
        if (!Object.is(before, value)) {
          changed(key, before, value);
        }
      },
    });
  }
  onCleanup(() => {
    for (const [key, descriptor] of descriptors) {
      if (descriptor) {
        Object.defineProperty(host, key, descriptor);
      }
    }
  });
}

function MountedContent(props: { value: unknown; host?: object }) {
  let container!: HTMLDivElement;
  createEffect(
    () => ({ value: props.value, host: props.host }),
    ({ value, host }) => {
      renderPluginTemplate(value, container, host);
    },
  );
  onCleanup(() => renderPluginTemplate(undefined, container));
  return (
    <div
      style={{ display: "contents" }}
      ref={(element) => {
        container = element;
      }}
    />
  );
}

const views = new WeakMap<HTMLElement, { focus(options?: FocusOptions): void }>();

function PluginViewContent(props: PluginViewProps, host: PluginViewElement) {
  const context = useOptionalApplication();
  const [revision, setRevision] = createSignal(0, { ownedWrite: true });
  const notify = () => setRevision((value) => value + 1);
  let registration: ViewRegistration | undefined;
  let mountAbort: AbortController | undefined;
  let mountGeneration = 0;
  let composerGeneration = 0;
  let ownerChanged = false;
  let error = "";
  let handle: ReturnType<ControlUiView<unknown>>;
  let viewContext: ControlUiViewContext<unknown> | undefined;
  let disposed = false;
  const defaultContainers = new Set<HTMLElement>();
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
  const unmount = () => {
    mountGeneration += 1;
    mountAbort?.abort();
    mountAbort = undefined;
    const previous = handle;
    handle = undefined;
    try {
      previous?.dispose?.();
    } catch (failure) {
      context?.plugins.reportError(registration?.pluginId ?? "host", failure);
    }
    for (const target of defaultContainers) {
      renderPluginTemplate(undefined, target);
    }
    defaultContainers.clear();
    viewContext = undefined;
  };
  observePluginProperties(
    host,
    ["props", "presented", "kind", "contributionKey", "surface"],
    (key, before, after) => {
      if (key === "presented") {
        composerGeneration += 1;
        return;
      }
      if (key !== "props") {
        ownerChanged = true;
        mountAbort?.abort();
        return;
      }
      // SAFETY: the prior bridge value is a host-rendered SDK props record; page props may omit session identity.
      const previous = before as Partial<BoardGetParams> | undefined;
      // SAFETY: the next bridge value follows the same host-rendered SDK props contract.
      const next = after as Partial<BoardGetParams> | undefined;
      if (previous?.sessionKey !== next?.sessionKey || previous?.agentId !== next?.agentId) {
        ownerChanged = true;
        mountAbort?.abort();
      }
    },
  );
  const runtime = projectSource(context?.plugins, {
    read: (source) => source,
    subscribe: (source, publish) =>
      source?.subscribe(() => {
        const next = resolveRegistration();
        if (registration?.value !== next?.value || registration?.signal !== next?.signal) {
          ownerChanged = true;
          mountAbort?.abort();
        }
        publish();
      }) ?? (() => {}),
    equality: "revision",
  });
  const scopedProps = (signal: AbortSignal): unknown => {
    if (host.kind !== "replacements" || host.surface !== "composer") {
      return structuredClone(host.props);
    }
    // SAFETY: renderPluginSurface supplies composer props for the kind and surface checked above.
    const value = host.props as ControlUiSurfaceProps["composer"];
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
    error = failure instanceof Error ? failure.message : String(failure);
    context?.plugins.reportError(pluginId, failure);
    notify();
  };
  const update = () => {
    if (!mountAbort || !viewContext || !registration || error) {
      return;
    }
    try {
      viewContext = {
        ...viewContext,
        props: scopedProps(mountAbort.signal),
        presented: host.presented,
      };
      handle?.update?.(viewContext);
      for (const target of defaultContainers) {
        renderPluginTemplate(host.defaultView, target, host.defaultHost ?? host);
      }
    } catch (failure) {
      fail(failure);
    }
  };
  createEffect(
    () => {
      runtime.read();
      return [
        props.kind,
        props.contributionKey,
        props.surface,
        props.props,
        props.presented,
        props.defaultView,
        props.defaultHost,
      ];
    },
    () => {
      // The Lit caller may already have restored its nodes before this queued effect runs.
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
        error = "";
        notify();
      }
      update();
    },
  );
  const mount = (container: HTMLElement) => {
    if (!host.isConnected || disposed || !registration || registration.signal.aborted || error) {
      return;
    }
    const abort = new AbortController();
    mountAbort = abort;
    registration.signal.addEventListener(
      "abort",
      () => {
        unmount();
        notify();
      },
      { once: true, signal: abort.signal },
    );
    try {
      viewContext = {
        host: scopeControlUiHost(registration.host, abort.signal, () => host.isConnected),
        signal: abort.signal,
        props: scopedProps(abort.signal),
        presented: host.presented,
        mountDefault: (target) => {
          if (!host.isConnected || abort.signal.aborted) {
            throw new Error("This plugin UI view has ended.");
          }
          defaultContainers.add(target);
          renderPluginTemplate(host.defaultView, target, host.defaultHost ?? host);
          notify();
          return () => {
            if (!defaultContainers.delete(target)) {
              return;
            }
            renderPluginTemplate(undefined, target);
            if (!disposed) {
              notify();
            }
          };
        },
      };
      handle = registration.value.mount(container, viewContext);
    } catch (failure) {
      fail(failure);
    }
  };
  function ViewRoot() {
    let container!: HTMLDivElement;
    onSettled(() => {
      mount(container);
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
  views.set(host, {
    focus(options) {
      if (handle?.focus) {
        handle.focus();
      } else {
        const input = host.querySelector<HTMLElement>("textarea, input, [contenteditable=true]");
        if (input) {
          input.focus(options);
        } else {
          HTMLElement.prototype.focus.call(host, options);
        }
      }
    },
  });
  onCleanup(() => {
    disposed = true;
    unmount();
    views.delete(host);
  });
  const state = () => {
    revision();
    return { registration, error, mountGeneration, delegated: defaultContainers.size > 0 };
  };
  return (
    <>
      <Show when={state().error}>
        <div class="card" role="alert">
          {state().error}
          <button
            class="btn btn--sm"
            onClick={() => {
              error = "";
              notify();
            }}
          >
            {t("pluginUi.retryView")}
          </button>
        </div>
      </Show>
      <Show
        when={state().registration && !state().error}
        fallback={<MountedContent value={props.defaultView} host={props.defaultHost ?? host} />}
      >
        <Show when={!state().delegated}>
          <MountedContent value={props.replacementCompanion} host={props.defaultHost ?? host} />
        </Show>
        <Show when={state().mountGeneration + 1} keyed>
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
    defaultView: { default: undefined, attribute: false },
    replacementCompanion: { default: undefined, attribute: false },
    defaultHost: { default: undefined, attribute: false },
    presented: { default: true, type: Boolean },
  },
  methods: { focus: (host, options) => views.get(host)?.focus(options) },
});

export function PluginContribution(props: {
  kind: Exclude<ViewKind, "replacements">;
  contributionKey: string;
  props: unknown;
  presented?: boolean;
}) {
  return (
    <PluginView
      kind={props.kind}
      contributionKey={props.contributionKey}
      props={props.props}
      presented={props.presented ?? true}
    />
  );
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-plugin-view": PluginViewElement;
  }
}
