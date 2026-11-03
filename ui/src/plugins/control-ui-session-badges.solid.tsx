import { For, Show, createMemo } from "solid-js";
import type { ControlUiSessionBadgeTarget } from "../../../src/plugin-sdk/control-ui.js";
import { iconData, type IconName } from "../components/icon-data.ts";
import type { SidebarSnapshotSessionBadge as CachedSessionBadge } from "../components/sidebar-snapshot-data.ts";
import { Icon } from "../components/solid/icon.tsx";
import { useApplication, useOptionalApplication } from "../lib/reactive/context.ts";
import { listen } from "../lib/reactive/listener.ts";
import { projectSource } from "../lib/reactive/projection.ts";
import { sharedPluginsProjection } from "../lib/reactive/shared-application-projections.ts";
import {
  resolveSessionBadge,
  sessionBadgeRegistrations,
  type SessionBadgeRegistration,
} from "./control-ui-session-badges.ts";

function Badge(props: { value: CachedSessionBadge }) {
  const icon = (): IconName => {
    const name = props.value.icon;
    // SAFETY: only own keys of the native icon inventory reach Icon.
    return Object.hasOwn(iconData, name) ? (name as IconName) : "plug";
  };
  return (
    <span class="session-row-badges">
      <span
        class={["session-row-badge", { ["session-row-badge--" + props.value.id]: true }]}
        data-control-ui-badge={props.value.pluginId + "/" + props.value.id}
        data-badge-tone={props.value.tone}
        {...(props.value.state === undefined
          ? {}
          : { ["data-" + props.value.id + "-state"]: props.value.state })}
        title={props.value.label}
        role="img"
        aria-label={props.value.label}
      >
        <Icon name={icon()} />
        <Show when={props.value.count}>
          <span aria-hidden="true">{props.value.count}</span>
        </Show>
      </span>
    </span>
  );
}

function LiveBadge(props: {
  entry: SessionBadgeRegistration;
  target: ControlUiSessionBadgeTarget;
  onChange?: () => void;
}) {
  const context = useApplication();
  const source = createMemo(() => {
    // A projection owns this captured registration until the tracked binding changes.
    const initialEntry = props.entry;
    const initialObserve = initialEntry.value.observe?.bind(initialEntry.value);
    const initialPluginId = initialEntry.pluginId;
    return projectSource(
      { entry: initialEntry, target: props.target },
      {
        read: ({ entry, target }) => resolveSessionBadge(context.plugins, entry, target),
        subscribe: ({ entry, target }, notify) => {
          const abort = new AbortController();
          const signal = AbortSignal.any([entry.signal, abort.signal]);
          let stop: (() => void) | undefined;
          try {
            stop = initialObserve?.({ ...target, signal }, () => {
              if (!signal.aborted) {
                notify();
                props.onChange?.();
              }
            });
          } catch (error) {
            abort.abort();
            context.plugins.reportError(initialPluginId, error);
          }
          const stopAbort = listen(signal, "abort", () => stop?.(), { once: true });
          return () => {
            abort.abort();
            stopAbort();
          };
        },
        equality: (before, after) => JSON.stringify(before) === JSON.stringify(after),
      },
    );
  });
  return <Show when={source().read()}>{(badge) => <Badge value={badge()} />}</Show>;
}

/** Cached rows render inert native facts. Only current registrations can run a live projection. */
export function SessionAccessoryBadges(
  props: ControlUiSessionBadgeTarget & {
    cached?: readonly CachedSessionBadge[];
    onChange?: () => void;
  },
) {
  const context = useOptionalApplication();
  const plugins = context && sharedPluginsProjection(context.plugins);
  const entries = createMemo(() => {
    const runtime = plugins?.read();
    return runtime ? sessionBadgeRegistrations(runtime) : [];
  });
  const cached = () => {
    const runtime = plugins?.read();
    return (props.cached ?? []).filter(
      (badge) =>
        runtime?.registryStatus !== "complete" ||
        runtime.isLoading(badge.pluginId) ||
        entries().some((entry) => entry.pluginId === badge.pluginId && entry.value.id === badge.id),
    );
  };
  const target = createMemo(() => ({
    sessionKey: props.sessionKey,
    agentId: props.agentId,
    worktreeId: props.worktreeId,
    artifact: props.artifact,
  }));
  return (
    <Show
      when={props.cached !== undefined}
      fallback={
        <For each={entries()} keyed={(entry) => entry.signal}>
          {(entry) => <LiveBadge entry={entry()} target={target()} onChange={props.onChange} />}
        </For>
      }
    >
      <For each={cached()} keyed={(badge) => badge.pluginId + "/" + badge.id}>
        {(badge) => <Badge value={badge()} />}
      </For>
    </Show>
  );
}
