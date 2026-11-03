import { For, Show, createMemo } from "solid-js";
import type { ControlUiSessionBadgeTarget } from "../../../src/plugin-sdk/control-ui.js";
import { iconData, type IconName } from "../components/icon-data.ts";
import { sameSidebarPresentation } from "../components/sidebar-projection-cache.ts";
import type { SidebarSnapshotSessionBadge as CachedSessionBadge } from "../components/sidebar-snapshot-data.ts";
import { Icon } from "../components/solid/icon.tsx";
import { listen } from "../lib/reactive/listener.ts";
import { projectSource } from "../lib/reactive/projection.ts";
import { sharedPluginsProjection } from "../lib/reactive/shared-application-projections.ts";
import type { ControlUiPluginCapability } from "./control-ui-capability.ts";
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
  plugins: ControlUiPluginCapability;
  entry: SessionBadgeRegistration;
  target: ControlUiSessionBadgeTarget;
  onChange?: () => void;
}) {
  const onChange = createMemo(() => props.onChange);
  let reportedFacts: string | undefined;
  const source = createMemo(() => {
    // A projection owns this captured registration until the tracked binding changes.
    const initialPlugins = props.plugins;
    const initialEntry = props.entry;
    const initialObserve = initialEntry.value.observe?.bind(initialEntry.value);
    const initialPluginId = initialEntry.pluginId;
    let currentBadge: CachedSessionBadge | undefined;
    return projectSource(
      { entry: initialEntry, target: props.target },
      {
        read: ({ entry, target }) => {
          const resolution = resolveSessionBadge(initialPlugins, entry, target);
          if (resolution.status === "ready") {
            currentBadge = resolution.badge;
          }
          return currentBadge;
        },
        subscribe: ({ entry, target }, notify) => {
          const abort = new AbortController();
          const signal = AbortSignal.any([entry.signal, abort.signal]);
          let stop: (() => void) | undefined;
          try {
            stop = initialObserve?.({ ...target, signal }, () => {
              if (!signal.aborted) {
                notify();
                const facts = JSON.stringify(currentBadge);
                if (reportedFacts !== facts) {
                  reportedFacts = facts;
                  onChange()?.();
                }
              }
            });
          } catch (error) {
            abort.abort();
            initialPlugins.reportError(initialPluginId, error);
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
    plugins: ControlUiPluginCapability | undefined;
    cached?: readonly CachedSessionBadge[];
    onChange?: () => void;
  },
) {
  // Native sidebar row roots carry their owning capability explicitly.
  const capability = createMemo(() => props.plugins);
  const plugins = createMemo(() => {
    const current = capability();
    return current && sharedPluginsProjection(current);
  });
  const entries = createMemo(
    () => {
      const runtime = plugins()?.read();
      return runtime ? sessionBadgeRegistrations(runtime) : [];
    },
    {
      equals: (previous, next) =>
        previous.length === next.length &&
        previous.every(
          (entry, index) =>
            entry.key === next[index]?.key &&
            entry.pluginId === next[index]?.pluginId &&
            entry.value === next[index]?.value &&
            entry.host === next[index]?.host &&
            entry.signal === next[index]?.signal,
        ),
    },
  );
  const cached = () => {
    const runtime = plugins()?.read();
    return (props.cached ?? []).filter(
      (badge) =>
        runtime?.registryStatus !== "complete" ||
        runtime.isLoading(badge.pluginId) ||
        entries().some((entry) => entry.pluginId === badge.pluginId && entry.value.id === badge.id),
    );
  };
  const target = createMemo(
    () => ({
      sessionKey: props.sessionKey,
      agentId: props.agentId,
      worktreeId: props.worktreeId,
      artifact: props.artifact,
    }),
    { equals: sameSidebarPresentation },
  );
  return (
    <Show
      when={props.cached !== undefined}
      fallback={
        <Show when={capability()}>
          {(source) => (
            <For each={entries()} keyed={(entry) => entry.signal}>
              {(entry) => (
                <LiveBadge
                  plugins={source()}
                  entry={entry()}
                  target={target()}
                  onChange={props.onChange}
                />
              )}
            </For>
          )}
        </Show>
      }
    >
      <For each={cached()} keyed={(badge) => badge.pluginId + "/" + badge.id}>
        {(badge) => <Badge value={badge()} />}
      </For>
    </Show>
  );
}
