import type { JSX } from "@solidjs/web";
import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import type { ControlUiAction } from "../../../src/plugin-sdk/control-ui.js";
import { iconData, type IconName } from "../components/icon-data.ts";
import type { SidebarMenusController } from "../components/sidebar-menus-controller.ts";
import { Icon } from "../components/solid/icon.tsx";
import { shouldHandleNavigationClick } from "../lib/navigation-click.ts";
import { useApplication } from "../lib/reactive/context.ts";
import { projectSource } from "../lib/reactive/projection.ts";
import { findUiSessionRow } from "../lib/sessions/route-navigation.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../lit/solid-bridge.ts";
import { runControlUiPluginAction } from "./control-ui-actions.ts";
import type { ControlUiRegistration } from "./control-ui-capability.ts";
import { observePluginProperties, PluginContribution } from "./control-ui-view.runtime.tsx";

type ContributionsProps = {
  kind: "navigation" | "session-header" | "composer" | "header";
  sessionKey: string;
  agentId: string | undefined;
  navigationKey: string;
  navigationChildren: boolean;
  navigationMenus: SidebarMenusController | undefined;
  presented: boolean;
};
type ContributionsElement = SolidBridgeElement<ContributionsProps>;

function PluginContributionsContent(props: ContributionsProps, host: ContributionsElement) {
  const context = useApplication();
  const [actionError, setActionError] = createSignal("");
  let lifetime = new AbortController();
  const actionLifetimes = new Map<
    AbortSignal,
    { entry: ControlUiRegistration<ControlUiAction>; abort: AbortController }
  >();
  host.style.display = "contents";
  const currentSession = () =>
    context ? findUiSessionRow(context, host.sessionKey, host.agentId) : undefined;
  const retireAction = (signal: AbortSignal) => {
    const action = actionLifetimes.get(signal);
    actionLifetimes.delete(signal);
    action?.abort.abort();
  };
  const resolveAction = (entry: ControlUiRegistration<ControlUiAction>) => {
    const session = currentSession();
    try {
      return entry.value.resolve?.({
        sessionKey: host.sessionKey,
        agentId: host.agentId ?? session?.agentId,
        session: session ? structuredClone(session) : undefined,
      });
    } catch (error) {
      retireAction(entry.signal);
      context?.plugins.reportError(entry.pluginId, error);
      return { hidden: true };
    }
  };
  const retireHiddenActions = () => {
    for (const [signal, { entry }] of actionLifetimes) {
      if (signal.aborted || resolveAction(entry)?.hidden) {
        retireAction(signal);
      }
    }
  };
  observePluginProperties(host, ["sessionKey", "agentId", "presented"], () => {
    lifetime.abort();
    actionLifetimes.clear();
    lifetime = new AbortController();
  });
  const source = projectSource(
    { context, kind: host.kind },
    {
      read: (binding) => binding.context?.plugins,
      subscribe: ({ context: current, kind }, notify) => {
        const changed = () => {
          retireHiddenActions();
          notify();
        };
        const stops = [current?.plugins.subscribe(changed)];
        if (kind === "navigation") {
          stops.push(current?.router?.subscribe(changed));
        }
        if (kind === "header" || kind === "composer") {
          stops.push(current?.sessions?.subscribe(changed));
        }
        return () => stops.forEach((stop) => stop?.());
      },
      equality: "revision",
    },
  );
  createEffect(
    () => props.kind,
    (kind) => source.replaceSource({ context, kind }),
  );
  onCleanup(() => {
    lifetime.abort();
    actionLifetimes.clear();
  });
  const navigation = createMemo(() => {
    const runtime = source.read();
    const search = new URLSearchParams(window.location.search);
    return (
      runtime?.registrations("navigation").map((entry) => {
        const href = entry.host.navigation.pageHref(entry.value.page);
        const target = new URL(href, window.location.href);
        const active =
          target.pathname === window.location.pathname &&
          [...target.searchParams].every(([key, value]) => search.get(key) === value);
        return { entry, href, active };
      }) ?? []
    );
  });
  type Navigation = ReturnType<typeof navigation>[number];
  const iconName = (entry: Navigation["entry"], fallback = "plug"): IconName => {
    const icon = entry.value.icon;
    const name = icon && Object.hasOwn(iconData, icon) ? icon : fallback;
    // SAFETY: the own-key check admits only names from the fixed icon registry.
    return Object.hasOwn(iconData, name) ? (name as IconName) : "plug";
  };
  function NavigationLink(link: { item: Navigation; child?: boolean; fallbackIcon?: string }) {
    const menu: JSX.EventHandler<HTMLAnchorElement, MouseEvent | KeyboardEvent> = (event) => {
      if (!link.item.entry.value.actions?.length) {
        return;
      }
      if (
        event instanceof KeyboardEvent &&
        event.key !== "ContextMenu" &&
        !(event.shiftKey && event.key === "F10")
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const trigger = event.currentTarget;
      const rect = trigger.getBoundingClientRect();
      props.navigationMenus?.openPluginNavigationMenu(
        link.item.entry,
        event instanceof MouseEvent ? event.clientX : rect.left,
        event instanceof MouseEvent ? event.clientY : rect.bottom,
        trigger,
      );
    };
    return (
      <a
        class={[
          "nav-item",
          { "nav-item--child": link.child, "nav-item--active": link.item.active },
        ]}
        href={link.item.href}
        aria-current={link.item.active ? "page" : undefined}
        aria-label={link.item.entry.value.label}
        aria-haspopup={link.item.entry.value.actions?.length ? "menu" : undefined}
        onContextMenu={menu}
        onKeyDown={menu}
        onClick={(event) => {
          if (!shouldHandleNavigationClick(event)) {
            return;
          }
          event.preventDefault();
          link.item.entry.host.navigation.openPage(link.item.entry.value.page);
        }}
      >
        <span class="nav-item__icon" aria-hidden="true">
          <Icon name={iconName(link.item.entry, link.fallbackIcon)} />
        </span>
        <span class="nav-item__text">{link.item.entry.value.label}</span>
      </a>
    );
  }
  const actions = createMemo(() => {
    const runtime = source.read();
    // Target changes retire the invocation before this presentation is recomputed.
    void [props.sessionKey, props.agentId, props.presented];
    return (
      runtime
        ?.registrations("actions")
        .filter((entry) => entry.value.placement === props.kind)
        .flatMap((entry) => {
          const state = resolveAction(entry);
          if (state?.hidden) {
            retireAction(entry.signal);
            return [];
          }
          let action = actionLifetimes.get(entry.signal);
          if (!action) {
            action = { entry, abort: new AbortController() };
            actionLifetimes.set(entry.signal, action);
          }
          return [
            {
              entry,
              state,
              signal: AbortSignal.any([lifetime.signal, entry.signal, action.abort.signal]),
            },
          ];
        }) ?? []
    );
  });
  return (
    <Show
      when={props.kind === "navigation"}
      fallback={
        <Show
          when={props.kind === "session-header"}
          fallback={
            <>
              <Show when={actionError()}>
                <span role="alert">{actionError()}</span>
              </Show>
              <For each={actions()} keyed={(action) => action.entry.signal}>
                {(action) => (
                  <button
                    class="btn btn--sm"
                    type="button"
                    disabled={action().state?.disabled ?? false}
                    onClick={() =>
                      void (async () => {
                        const current = action();
                        const runtime = context?.plugins;
                        if (
                          !runtime ||
                          current.signal.aborted ||
                          !host.presented ||
                          !host.isConnected
                        ) {
                          return;
                        }
                        setActionError("");
                        try {
                          await runControlUiPluginAction({
                            runtime,
                            id: current.entry.key,
                            placement: current.entry.value.placement,
                            sessionKey: host.sessionKey,
                            agentId: host.agentId,
                            session: currentSession(),
                            signal: current.signal,
                            isCurrent: () => host.isConnected && host.presented,
                          });
                        } catch (error) {
                          if (!current.signal.aborted) {
                            setActionError(error instanceof Error ? error.message : String(error));
                          }
                        }
                      })()
                    }
                  >
                    {action().state?.label ?? action().entry.value.label}
                  </button>
                )}
              </For>
            </>
          }
        >
          <For
            each={source
              .read()
              ?.registrations("accessories")
              .filter((entry) => entry.value.placement === "session-header")}
            keyed={(entry) => entry.signal}
          >
            {(entry) => (
              <PluginContribution
                kind="accessories"
                contributionKey={entry().key}
                props={{ sessionKey: props.sessionKey, agentId: props.agentId }}
                presented={props.presented}
              />
            )}
          </For>
        </Show>
      }
    >
      <For
        each={navigation().filter(({ entry }) => entry.key === props.navigationKey)}
        keyed={(item) => item.entry.key}
      >
        {(parent) => {
          const children = () =>
            navigation()
              .filter(
                ({ entry }) =>
                  entry.pluginId === parent().entry.pluginId &&
                  entry.value.parent === parent().entry.value.id &&
                  entry.key !== parent().entry.key,
              )
              .toSorted(
                (a, b) =>
                  (a.entry.value.order ?? 0) - (b.entry.value.order ?? 0) ||
                  a.entry.value.label.localeCompare(b.entry.value.label),
              );
          return (
            <Show
              when={
                props.navigationChildren &&
                children().length > 0 &&
                (parent().active || children().some((child) => child.active))
              }
              fallback={<NavigationLink item={parent()} />}
            >
              <div class="nav-item-group">
                <NavigationLink item={parent()} />
                <ul class="nav-item__children">
                  <For each={children()} keyed={(item) => item.entry.key}>
                    {(child) => (
                      <li>
                        <NavigationLink
                          item={child()}
                          child
                          fallbackIcon={parent().entry.value.icon}
                        />
                      </li>
                    )}
                  </For>
                </ul>
              </div>
            </Show>
          );
        }}
      </For>
    </Show>
  );
}

export const PluginContributions = defineSolidBridge<ContributionsProps>(
  "openclaw-plugin-contributions",
  PluginContributionsContent,
  {
    properties: {
      kind: { default: "navigation", attribute: false },
      sessionKey: { default: "", attribute: false },
      agentId: { default: undefined, attribute: false },
      navigationKey: { default: "", attribute: false },
      navigationChildren: { default: true, type: Boolean },
      navigationMenus: { default: undefined, attribute: false },
      presented: { default: true, type: Boolean },
    },
  },
);

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-plugin-contributions": ContributionsElement;
  }
}
