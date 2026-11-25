import type { JSX } from "@solidjs/web";
import {
  createMemo,
  createSignal,
  createStore,
  Errored,
  For,
  Loading,
  onSettled,
  Show,
} from "solid-js";
import type { ApplicationContext } from "../../app/context.ts";
import type { ApplicationGateway } from "../../app/gateway.ts";
import { createGatewayConnectionLifecycle } from "../../lib/gateway-connection-lifecycle.ts";
import { projectGatewayEventLog } from "../../lib/reactive/application.ts";
import { useOptionalApplication } from "../../lib/reactive/context.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { listen } from "../../lib/reactive/listener.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../../lib/solid-bridge.ts";
import { canReadSystemInfo, SYSTEM_INFO_POLL_INTERVAL_MS } from "../../lib/system-info.ts";
import "../../styles/debug-data.css";
import { DebugOverlaySectionLoading } from "./debug-overlay-loading-view.tsx";
import {
  DEBUG_OVERLAY_SECTIONS,
  DebugOverlayWidget,
  type DebugOverlaySectionDescriptor,
  type DebugOverlayStatusSample,
  type DebugOverlayStatusSnapshot,
} from "./debug-overlay-sections.tsx";

type SectionRead = Promise<unknown> | null | undefined;

const pollingSynchronizers = new WeakMap<HTMLElement, () => void>();

function SectionFrame(props: {
  section: DebugOverlaySectionDescriptor;
  loading?: boolean;
  children: JSX.Element;
}) {
  return (
    <section class="debug-overlay__section" aria-busy={props.loading ? "true" : "false"}>
      <h3>{t(props.section.titleKey)}</h3>
      {props.children}
    </section>
  );
}

function SectionFallback(props: { section: DebugOverlaySectionDescriptor; loading?: boolean }) {
  return (
    <SectionFrame section={props.section} loading={props.loading}>
      <Show
        when={props.loading}
        fallback={<div class="debug-overlay__empty">{t("debug.overlay.unavailable")}</div>}
      >
        <DebugOverlaySectionLoading id={props.section.id} />
      </Show>
    </SectionFrame>
  );
}

function CompactFallback(props: { loading?: boolean }) {
  return (
    <div class="debug-overlay__compact-loading" role="status">
      {t(props.loading ? "common.loading" : "debug.overlay.unavailable")}
    </div>
  );
}

function Content(
  source: ApplicationGateway,
  props: { minimized: boolean },
  host: SolidBridgeElement<Props>,
) {
  const lifecycle = createGatewayConnectionLifecycle(source.snapshot);
  const [visible, setVisible] = createSignal(document.visibilityState !== "hidden");
  // Polls retain settled samples; a new connection immediately hides them.
  const [epoch, setEpoch] = createSignal(lifecycle.epoch);
  const [sections, setSections] = createStore<Record<string, SectionRead>>({});
  const [history, setHistory] = createStore<DebugOverlayStatusSample[]>([]);
  const requests = new Map<string, AbortController>();
  let timer: ReturnType<typeof setInterval> | undefined;

  const updateSection = (id: string, read: SectionRead) => {
    setSections((draft) => {
      draft[id] = read;
    });
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
  const abortRequests = () => {
    for (const controller of requests.values()) {
      controller.abort();
    }
    requests.clear();
  };
  const reset = () => {
    abortRequests();
    setEpoch(lifecycle.epoch);
    setHistory((draft) => {
      draft.length = 0;
    });
    setSections((draft) => {
      for (const section of DEBUG_OVERLAY_SECTIONS) {
        draft[section.id] = lifecycle.capture() ? undefined : null;
      }
    });
  };

  function refresh(minimized = host.minimized) {
    const scope = lifecycle.capture();
    if (!scope || document.visibilityState === "hidden") {
      return;
    }
    for (const section of DEBUG_OVERLAY_SECTIONS) {
      if (
        requests.has(section.id) ||
        (section.id !== "status" && minimized) ||
        (section.id === "status" && !canReadSystemInfo(source.snapshot))
      ) {
        continue;
      }
      const controller = new AbortController();
      requests.set(section.id, controller);
      const read = section
        .load({ client: scope.client, gateway: source }, controller.signal)
        .then((value) => {
          if (controller.signal.aborted || !lifecycle.isCurrent(scope)) {
            return undefined;
          }
          if (section.id === "status") {
            // SAFETY: The status descriptor is the only producer of this snapshot.
            const sample = value as DebugOverlayStatusSnapshot;
            setHistory((draft) => {
              if (draft.at(-1)?.at !== sample.sampledAt) {
                draft.splice(0, Math.max(0, draft.length - 89));
                draft.push({ at: sample.sampledAt, status: sample });
              }
            });
            // Measure the next status interval from the completed sample.
            stopPolling();
            if (document.visibilityState !== "hidden") {
              startPolling();
            }
          }
          return value;
        })
        .finally(() => {
          if (requests.get(section.id) === controller) {
            requests.delete(section.id);
          }
        });
      // Hidden sections retain the rejection for their next Errored reader.
      void read.catch(() => undefined);
      updateSection(section.id, read);
    }
  }
  const visibilityChanged = () => {
    setVisible(document.visibilityState !== "hidden");
    syncPolling(host.minimized);
  };
  function syncPolling(minimized: boolean, initial = false) {
    const snapshot = source.snapshot;
    const changed = lifecycle.transition(snapshot);
    if (initial || changed) {
      reset();
    }
    const statusAllowed = canReadSystemInfo(snapshot);
    if (!statusAllowed) {
      requests.get("status")?.abort();
      requests.delete("status");
      setHistory((draft) => {
        draft.length = 0;
      });
      updateSection("status", null);
    }
    if (
      document.visibilityState === "hidden" ||
      !lifecycle.capture() ||
      (minimized && !statusAllowed)
    ) {
      stopPolling();
    } else {
      const starting = timer === undefined;
      startPolling();
      if (starting || initial || changed) {
        refresh(minimized);
      }
    }
  }
  const eventLog = projectGatewayEventLog(source);
  const eventRevision = () =>
    !props.minimized && visible() ? eventLog.read().revision : undefined;
  // Keep settled reads across compact/expanded presentation changes.
  const status = createMemo(() => sections.status);
  const entries = DEBUG_OVERLAY_SECTIONS.map((section) => {
    if (section.id === "status") {
      return Object.assign({ read: status }, section);
    }
    const read = createMemo(() => sections[section.id]);
    return Object.assign({ read }, section);
  });
  onSettled(() => {
    // Gateway receipts abort retired diagnostics and synchronously revoke unauthorized status polling.
    const synchronize = () => syncPolling(host.minimized);
    const stopGateway = source.subscribe(synchronize);
    const stopVisibility = listen(document, "visibilitychange", visibilityChanged);
    pollingSynchronizers.set(host, synchronize);
    // The previous gateway's keyed content has released its shared diagnostics first.
    syncPolling(host.minimized, true);
    return () => {
      pollingSynchronizers.delete(host);
      stopPolling();
      abortRequests();
      stopGateway();
      lifecycle.dispose();
      stopVisibility();
    };
  });
  const value = (entry: (typeof entries)[number]) => {
    if (entry.id === "events") {
      eventRevision();
    }
    return entry.read();
  };
  return (
    <Show
      when={!props.minimized}
      fallback={
        <Show
          when={Boolean(sections.status)}
          fallback={<CompactFallback loading={sections.status === undefined} />}
        >
          <Errored fallback={<CompactFallback />}>
            <Loading on={epoch()} fallback={<CompactFallback loading />}>
              <DebugOverlayWidget
                status={
                  // SAFETY: Only the status descriptor produces this read's snapshot.
                  status() as DebugOverlayStatusSnapshot
                }
                history={history}
              />
            </Loading>
          </Errored>
        </Show>
      }
    >
      <For each={entries}>
        {(entry) => (
          <Show
            when={Boolean(sections[entry.id])}
            fallback={
              <SectionFallback section={entry} loading={sections[entry.id] === undefined} />
            }
          >
            <Errored fallback={<SectionFallback section={entry} />}>
              <Loading on={epoch()} fallback={<SectionFallback section={entry} loading />}>
                <SectionFrame section={entry}>
                  <entry.render value={value(entry)} history={history} />
                </SectionFrame>
              </Loading>
            </Errored>
          </Show>
        )}
      </For>
    </Show>
  );
}

type Props = { context: ApplicationContext | undefined; minimized: boolean };

export const DebugOverlayContent = defineSolidBridge<Props>(
  "openclaw-debug-overlay-content",
  (props, host) => {
    // A bridge's provider ancestry is fixed for this renderer lifetime.
    const inherited = useOptionalApplication();
    return (
      <Show when={(props.context ?? inherited)?.gateway} keyed>
        {(gateway) => Content(gateway, props, host)}
      </Show>
    );
  },
  {
    propertyChanged: (host, key) => {
      if (key === "minimized") {
        // A batched context replacement must retire the previous diagnostics before polling.
        onSettled(() => pollingSynchronizers.get(host)?.());
      }
    },
    properties: {
      context: { default: undefined, attribute: false },
      minimized: { default: false, type: Boolean },
    },
  },
);
