import {
  createComponent,
  createEffect,
  createSignal,
  For,
  onCleanup,
  Show,
  untrack,
} from "solid-js";
import type { ApplicationContext } from "../../app/context.ts";
import type { ApplicationGateway } from "../../app/gateway.ts";
import { createGatewayConnectionLifecycle } from "../../lib/gateway-connection-lifecycle.ts";
import { projectGateway, projectGatewayEventLog } from "../../lib/reactive/application.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { canReadSystemInfo, SYSTEM_INFO_POLL_INTERVAL_MS } from "../../lib/system-info.ts";
import { defineSolidBridge } from "../../lit/solid-bridge.ts";
import "../../styles/debug-data.css";
import { DebugOverlaySectionLoading } from "./debug-overlay-loading-view.tsx";
import {
  DEBUG_OVERLAY_SECTIONS,
  DebugOverlayWidget,
  type DebugOverlayStatusSample,
  type DebugOverlayStatusSnapshot,
} from "./debug-overlay-sections.tsx";

type SectionState = { status: "loading" | "unavailable" } | { status: "ready"; value: unknown };

function Content(props: { gateway: ApplicationGateway; minimized: boolean }) {
  // The keyed parent gives each Gateway source its own request lifetime.
  const source = untrack(() => props.gateway);
  const gateway = projectGateway(source);
  const lifecycle = createGatewayConnectionLifecycle(source.snapshot);
  const [visible, setVisible] = createSignal(document.visibilityState !== "hidden");
  const [sections, setSections] = createSignal(new Map<string, SectionState>(), {
    ownedWrite: true,
  });
  const [history, setHistory] = createSignal<readonly DebugOverlayStatusSample[]>([], {
    ownedWrite: true,
  });
  const requests = new Map<string, AbortController>();
  let timer: ReturnType<typeof setInterval> | undefined;

  const updateSection = (id: string, state: SectionState) => {
    setSections((previous) => new Map(previous).set(id, state));
  };
  const stopPolling = () => {
    clearInterval(timer);
    timer = undefined;
  };
  const startPolling = () => {
    if (timer === undefined) {
      timer = setInterval(refresh, SYSTEM_INFO_POLL_INTERVAL_MS);
    }
  };
  const reset = () => {
    for (const controller of requests.values()) {
      controller.abort();
    }
    requests.clear();
    setHistory([]);
    setSections(
      new Map(
        DEBUG_OVERLAY_SECTIONS.map((section) => [
          section.id,
          {
            status: lifecycle.capture() ? "loading" : "unavailable",
          },
        ]),
      ),
    );
  };
  function refresh() {
    const scope = lifecycle.capture();
    if (!scope || document.visibilityState === "hidden") {
      return;
    }
    for (const section of DEBUG_OVERLAY_SECTIONS) {
      if (
        requests.has(section.id) ||
        (section.id !== "status" && untrack(() => props.minimized)) ||
        (section.id === "status" && !canReadSystemInfo(source.snapshot))
      ) {
        continue;
      }
      const controller = new AbortController();
      requests.set(section.id, controller);
      void section
        .load({ client: scope.client, gateway: source }, controller.signal)
        .then(
          (value) => {
            if (controller.signal.aborted || !lifecycle.isCurrent(scope)) {
              return;
            }
            if (section.id === "status") {
              // SAFETY: The status descriptor is the only producer of this snapshot.
              const sample = value as DebugOverlayStatusSnapshot;
              setHistory((previous) =>
                previous.at(-1)?.at === sample.sampledAt
                  ? previous
                  : [...previous.slice(-89), { at: sample.sampledAt, status: sample }],
              );
              // Measure the next status interval from the completed sample.
              stopPolling();
              if (document.visibilityState !== "hidden") {
                startPolling();
              }
            }
            updateSection(section.id, { status: "ready", value });
          },
          () => {
            if (!controller.signal.aborted && lifecycle.isCurrent(scope)) {
              updateSection(section.id, { status: "unavailable" });
            }
          },
        )
        .finally(() => {
          if (requests.get(section.id) === controller) {
            requests.delete(section.id);
          }
        });
    }
  }
  const visibilityChanged = () => setVisible(document.visibilityState !== "hidden");
  document.addEventListener("visibilitychange", visibilityChanged);
  function syncPolling(initial = false) {
    const snapshot = gateway.read().snapshot;
    const changed = lifecycle.transition(snapshot);
    if (initial || changed) {
      reset();
    }
    const statusAllowed = canReadSystemInfo(snapshot);
    if (!statusAllowed) {
      requests.get("status")?.abort();
      requests.delete("status");
      setHistory([]);
      updateSection("status", { status: "unavailable" });
    }
    if (
      document.visibilityState === "hidden" ||
      !lifecycle.capture() ||
      (props.minimized && !statusAllowed)
    ) {
      stopPolling();
    } else {
      const starting = timer === undefined;
      startPolling();
      if (starting || initial || changed) {
        refresh();
      }
    }
  }
  const stopGateway = gateway.subscribe(() => untrack(syncPolling));
  createEffect(
    () => ({ minimized: props.minimized, visible: visible() }),
    // Start after the previous keyed content has released shared requests.
    (_current, previous) => untrack(() => syncPolling(previous === undefined)),
  );
  const eventLog = projectGatewayEventLog(source);
  const eventRevision = () =>
    !props.minimized && visible() ? eventLog.read().revision : undefined;
  onCleanup(() => {
    stopPolling();
    reset();
    stopGateway();
    lifecycle.dispose();
    document.removeEventListener("visibilitychange", visibilityChanged);
  });
  const state = (id: string) => sections().get(id) ?? { status: "loading" as const };
  const value = (id: string) => {
    const current = state(id);
    return current.status === "ready" ? current.value : undefined;
  };
  return (
    <Show
      when={!props.minimized}
      fallback={
        <Show
          when={state("status").status === "ready"}
          fallback={
            <div class="debug-overlay__compact-loading" role="status">
              {t(
                state("status").status === "loading"
                  ? "common.loading"
                  : "debug.overlay.unavailable",
              )}
            </div>
          }
        >
          <DebugOverlayWidget
            status={
              // SAFETY: A ready status entry contains the status descriptor's snapshot.
              value("status") as DebugOverlayStatusSnapshot
            }
            history={history()}
          />
        </Show>
      }
    >
      <For each={DEBUG_OVERLAY_SECTIONS}>
        {(entry) => (
          <section
            class="debug-overlay__section"
            aria-busy={state(entry.id).status === "loading" ? "true" : "false"}
          >
            <h3>{t(entry.titleKey)}</h3>
            <Show
              when={state(entry.id).status !== "loading"}
              fallback={<DebugOverlaySectionLoading id={entry.id} />}
            >
              <Show
                when={state(entry.id).status === "ready"}
                fallback={<div class="debug-overlay__empty">{t("debug.overlay.unavailable")}</div>}
              >
                {createComponent(entry.render, {
                  get value() {
                    if (entry.id === "events") {
                      eventRevision();
                    }
                    return value(entry.id);
                  },
                  get history() {
                    return history();
                  },
                })}
              </Show>
            </Show>
          </section>
        )}
      </For>
    </Show>
  );
}

type Props = { context: ApplicationContext | undefined; minimized: boolean };

export const DebugOverlayContent = defineSolidBridge<Props>(
  "openclaw-debug-overlay-content",
  (props) => {
    const inherited = untrack(() => props.context) ? undefined : useApplication();
    return (
      <Show when={(props.context ?? inherited)?.gateway} keyed>
        {(gateway) => <Content gateway={gateway} minimized={props.minimized} />}
      </Show>
    );
  },
  {
    properties: {
      context: { default: undefined, attribute: false },
      minimized: { default: false, type: Boolean },
    },
  },
);
