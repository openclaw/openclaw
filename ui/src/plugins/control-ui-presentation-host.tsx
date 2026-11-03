import type { JSX } from "@solidjs/web";
import { createRoot, createSignal, merge, Show } from "solid-js";
import type { ControlUiComponentHandle } from "../../../src/plugin-sdk/control-ui-components.js";
import type { ControlUiPresentationHost } from "../../../src/plugin-sdk/control-ui-presentation.js";
import type { ApplicationGateway } from "../app/gateway.ts";
import { availableLinkPreviewReaders, availableLinkReaders } from "../app/link-reader-routing.ts";
import {
  isStaleChunkImportError,
  retryStaleChunkReloadWhenReachable,
} from "../app/stale-chunk-reload.ts";
import { iconData, type IconName } from "../components/icon-data.ts";
import "../components/link-reader-hovercard-registration.ts";
import { ActivityPill } from "../components/solid/activity-pill.tsx";
import { Icon } from "../components/solid/icon.tsx";
import { LazyViewError } from "../components/solid/lazy-view-error.tsx";
import { Menu, type MenuEntry } from "../components/solid/menu.tsx";
import { PanelLoadingSkeleton } from "../components/solid/panel-loading-skeleton.tsx";
import { SettingsToggle } from "../components/solid/settings-toggle.tsx";
import { createTextOverflow } from "../components/solid/text-overflow.ts";
import { copyToClipboard } from "../lib/clipboard.ts";
import { formatDurationCompact } from "../lib/format-duration.ts";
import { formatUiError } from "../lib/format-error.ts";
import { resolveSafeExternalUrl } from "../lib/open-external-url.ts";
import { projectGateway } from "../lib/reactive/application.ts";
import { subscribeI18n, t } from "../lib/reactive/i18n.ts";
import { listen } from "../lib/reactive/listener.ts";
import "../components/tooltip.ts";
import { mountSolidContent } from "../lib/reactive/mount-solid-content.ts";
import { HoverMarquee } from "../lib/solid/hover-marquee.tsx";
import { showToast } from "../lib/toast.ts";
import { registerControlUiEnglish } from "./control-ui-english.ts";

export function createControlUiPresentationHost(
  current: () => { gateway: ApplicationGateway },
  signal: AbortSignal,
): ControlUiPresentationHost {
  const active = () => {
    current();
    signal.throwIfAborted();
  };
  function mount<P extends object>(
    container: HTMLElement,
    initial: P,
    view: (props: ReturnType<typeof merge<[() => P]>>) => JSX.Element,
  ): ControlUiComponentHandle<P> {
    active();
    const [state, setState] = createSignal({ value: initial }, { ownedWrite: true });
    const View = view;
    // SDK controls own an independent renderer even when mounted from a plugin effect.
    const stop = mountSolidContent(container, () => <View {...merge(() => state().value)} />);
    let disposed = false;
    const dispose = () => {
      if (disposed) {
        return;
      }
      disposed = true;
      stopAbort();
      stop();
    };
    const stopAbort = listen(signal, "abort", dispose, { once: true });
    return {
      update(props) {
        active();
        if (disposed) {
          throw new Error("This plugin presentation has ended.");
        }
        setState({ value: props });
      },
      dispose,
    };
  }
  function menuEntry(
    entry: Parameters<ControlUiPresentationHost["mountMenu"]>[1]["items"][number],
  ): MenuEntry {
    if (entry.kind === "group") {
      return { ...entry, class: entry.className, items: entry.items.map(menuEntry) };
    }
    if (entry.kind === "content") {
      return entry;
    }
    return { ...entry, class: entry.className };
  }
  const iconName = (name: string): IconName => {
    // SAFETY: only the host's own icon inventory reaches the typed renderer.
    return Object.hasOwn(iconData, name) ? (name as IconName) : "plug";
  };
  return {
    apiVersion: 1,
    mountLazyState(container, props) {
      return mount(container, props, (read) => (
        <Show
          when={(() => {
            const value = read;
            return value.status === "error" ? value : undefined;
          })()}
          fallback={
            <PanelLoadingSkeleton variant="file-list" label={t("common.loading")} compact />
          }
        >
          {(state) => (
            <LazyViewError
              error={state().error}
              stale={isStaleChunkImportError(state().error)}
              inline
              onRetry={() => {
                active();
                const value = state();
                if (!value.isCurrent()) {
                  return;
                }
                if (isStaleChunkImportError(value.error)) {
                  void retryStaleChunkReloadWhenReachable({
                    canReload: () => !signal.aborted && value.isCurrent(),
                  });
                } else {
                  value.onRetry();
                }
              }}
            />
          )}
        </Show>
      ));
    },
    mountLinkPreviews(container, initial) {
      const source = current().gateway;
      return mount(container, initial, (props) => {
        const gateway = projectGateway(source);
        const snapshot = () => gateway.read().snapshot;
        return (
          <openclaw-link-reader-hovercard-provider
            prop:client={snapshot().client}
            prop:readers={availableLinkPreviewReaders(snapshot())}
            prop:claimedReaders={availableLinkReaders(snapshot())}
            prop:previewSeeds={props.previewSeeds}
            prop:sessionKey={props.sessionKey}
            prop:agentId={props.agentId}
          >
            {props.child}
          </openclaw-link-reader-hovercard-provider>
        );
      });
    },
    mountActivityPill(container, props) {
      return mount(container, props, (read) => <ActivityPill {...read} />);
    },
    subscribe(listener) {
      active();
      let live = true;
      const stopSource = subscribeI18n(() => {
        if (live && !signal.aborted) {
          listener();
        }
      });
      const stop = () => {
        if (!live) {
          return;
        }
        live = false;
        stopAbort();
        stopSource();
      };
      const stopAbort = listen(signal, "abort", stop, { once: true });
      return stop;
    },
    formatError: formatUiError,
    formatDuration: formatDurationCompact,
    safeExternalUrl: resolveSafeExternalUrl,
    translate: t,
    registerEnglish(catalog) {
      active();
      registerControlUiEnglish(catalog);
    },
    mountToggle: (container, initial) =>
      mount(container, initial, (props) => (
        <SettingsToggle
          {...props}
          onChange={(checked) => {
            active();
            return props.onChange(checked);
          }}
        />
      )),
    mountIcon: (container, initial) =>
      mount(container, initial, (props) => (
        <Icon name={iconName(props.name)} class={props.className} />
      )),
    mountTextOverflow(element, initial) {
      active();
      let update!: (props: { content: unknown }) => void;
      // Plugin renderers carry a different Solid owner graph. Native directives
      // receive explicit values and own their measurement lifecycle here.
      const stop = createRoot((dispose) => {
        const [state, setState] = createSignal({ value: initial }, { ownedWrite: true });
        update = (props) => setState({ value: props });
        createTextOverflow(() => state().value.content)(element);
        return dispose;
      });
      let disposed = false;
      const dispose = () => {
        if (!disposed) {
          disposed = true;
          stopAbort();
          stop();
        }
      };
      const stopAbort = listen(signal, "abort", dispose, { once: true });
      return {
        update(props) {
          active();
          if (disposed) {
            throw new Error("This plugin presentation has ended.");
          }
          update(props);
        },
        dispose,
      };
    },
    copyText(value, isCurrent) {
      active();
      return copyToClipboard(value, () => !signal.aborted && isCurrent());
    },
    notify(message) {
      active();
      showToast({ message });
    },
    mountMarquee: (container, initial) =>
      mount(container, initial, (props) => (
        <HoverMarquee content={props.content} class={props.className} options={props.options} />
      )),
    mountTooltip: (container, initial) =>
      mount(container, initial, (props) => (
        <openclaw-tooltip content={props.content} prop:disabled={props.disabled}>
          {props.child}
        </openclaw-tooltip>
      )),
    mountMenu: (container, initial) =>
      mount(container, initial, (props) => (
        <Menu
          id={props.id}
          class={props.className}
          panelClass={props.panelClass}
          placement={props.placement}
          label={props.label}
          disabled={props.disabled}
          triggerClass={props.triggerClass}
          trigger={props.trigger}
          triggerAttributes={props.triggerAttributes}
          controls={props.controls}
          ref={(handle) => props.ref?.(handle)}
          items={props.items.map(menuEntry)}
          onOpenChange={(open) => props.onOpenChange?.(open)}
          onEscape={() => props.onEscape?.() ?? false}
          open={props.presented ? undefined : false}
          onBeforeShow={(event) => {
            active();
            props.onBeforeShow?.(event);
            if (!props.presented) {
              event.preventDefault();
            }
          }}
          onSelect={(item) => {
            active();
            props.onSelect(item.id);
          }}
        >
          {props.content}
        </Menu>
      )),
  };
}
