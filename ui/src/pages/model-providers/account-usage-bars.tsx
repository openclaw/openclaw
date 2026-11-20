import type { JSX } from "@solidjs/web";
import { createMemo, createSignal, For, Loading, Show } from "solid-js";
import {
  remainingPercent,
  remainingTone,
  resetText,
} from "../../components/solid/provider-usage.tsx";
import { moveArrayEntry } from "../../lib/array-order.ts";
import { formatNumber } from "../../lib/reactive/format.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { listen } from "../../lib/reactive/listener.ts";
import { createPointerDrag } from "../../lib/reactive/pointer-drag.ts";
import { accountCreditBalance, type AccountUsageRead } from "./account-usage.tsx";

/** Equal slots compare accounts, not token capacity. Only windows with the same label share a track. */
export function AccountUsageBars(props: {
  readings: AccountUsageRead[];
  identities: Map<string, string>;
  expandedAccount?: string;
  onToggleAccount: (id: string) => void;
  status: (id: string) => JSX.Element;
  canReorder: boolean;
  onReorder: (ids: string[]) => void;
}) {
  const ids = createMemo(() => props.readings.map((read) => read.account().profileId));
  const tracks = createMemo(() => {
    const identities = props.identities;
    const accounts = props.readings.map((read) => ({
      id: read.account().profileId,
      value: read.result(),
    }));
    const labels = new Set(
      accounts.flatMap(
        ({ value }) =>
          value.snapshot?.windows.filter((w) => !w.groupLabel).map((w) => w.label) ?? [],
      ),
    );
    return Array.from(labels, (label) => ({
      label,
      segments: accounts.map(({ id, value }) => {
        const window = value.snapshot?.windows.find((w) => !w.groupLabel && w.label === label);
        const percent = window && remainingPercent(window);
        const reset = window && resetText(window);
        const quota =
          percent === undefined
            ? (value.error ??
              value.snapshot?.error ??
              t(value.loading ? "common.loading" : "modelProviders.limits.notReported"))
            : t("usage.providerUsage.remaining", { percent: String(percent) });
        return {
          id,
          percent,
          tone: window && remainingTone(window),
          detail: [
            identities.get(id),
            label,
            quota,
            reset?.date && t("usage.providerUsage.resets", { date: reset.date }),
          ]
            .filter(Boolean)
            .join(" · "),
        };
      }),
    }));
  });
  const drag = createPointerDrag();
  const [preview, setPreview] = createSignal<{
    source: number;
    target: number;
    dx: number;
    pitch: number;
  }>();
  let suppressPointerClick = false;
  const translation = (index: number) => {
    const p = preview();
    if (!p) {
      return undefined;
    }
    if (index === p.source) {
      return `${p.dx}px`;
    }
    if (p.source < index && index <= p.target) {
      return `${-p.pitch}px`;
    }
    if (p.target <= index && index < p.source) {
      return `${p.pitch}px`;
    }
    return "0px";
  };
  const [selected, select] = createSignal<{ id: string; label: string }>();
  const move = (source: string, target: string) => {
    const current = ids();
    if (
      !props.canReorder ||
      source === target ||
      !current.includes(source) ||
      !current.includes(target)
    ) {
      return;
    }
    props.onReorder(
      moveArrayEntry(
        current,
        source,
        target,
        current.indexOf(source) < current.indexOf(target) ? "after" : "before",
      ),
    );
  };
  const reorderByKey = (event: KeyboardEvent, id: string, index: number) => {
    if (event.key === "Escape") {
      drag.cancel();
      select(undefined);
      return;
    }
    if (!props.canReorder || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) {
      return;
    }
    event.preventDefault();
    const target = ids()[index + (event.key === "ArrowLeft" ? -1 : 1)];
    const button = event.currentTarget;
    if (target && button instanceof HTMLButtonElement) {
      move(id, target);
      queueMicrotask(() => {
        if (button.isConnected) {
          button.focus({ preventScroll: true });
        }
      });
    }
  };
  let chart!: HTMLElement;
  const startDrag = (event: PointerEvent, source: number) => {
    const cell = event.currentTarget;
    suppressPointerClick = false;
    if (
      !props.canReorder ||
      !event.isPrimary ||
      event.button !== 0 ||
      !(cell instanceof HTMLElement)
    ) {
      return;
    }
    const track = cell.parentElement;
    const first = track?.children[0];
    const second = track?.children[1];
    if (!track || !first || !second) {
      return;
    }
    // Equal-width columns: measure the original slot pitch, never the moving cells.
    const pitch = second.getBoundingClientRect().x - first.getBoundingClientRect().x;
    const initialIds = ids();
    let dragged = false;
    let target = source;
    const update = (p: PointerEvent) => {
      const dx = p.clientX - event.clientX;
      if (!dragged && Math.abs(dx) < 4) {
        return;
      }
      dragged = true;
      const bounds = track.getBoundingClientRect();
      const vertical = chart.getBoundingClientRect();
      const inside =
        p.clientX >= bounds.left &&
        p.clientX <= bounds.right &&
        p.clientY >= vertical.top &&
        p.clientY <= vertical.bottom;
      target = inside
        ? Math.max(0, Math.min(initialIds.length - 1, source + Math.round(dx / pitch)))
        : source;
      setPreview({ source, target, pitch, dx });
    };
    const cleanup = () => {
      stopKeydown();
      suppressPointerClick = dragged;
      setPreview(undefined);
    };
    const stopKeydown = listen(
      cell.ownerDocument,
      "keydown",
      (e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          drag.cancel();
        }
      },
      true,
    );
    if (
      !drag.start(event, cell, {
        move: update,
        cancel: cleanup,
        end: (p) => {
          update(p);
          cleanup();
          if (target !== source) {
            move(initialIds[source]!, initialIds[target]!);
          }
        },
      })
    ) {
      stopKeydown();
    }
  };
  const selectedDetail = () =>
    tracks()
      .find((track) => track.label === selected()?.label)
      ?.segments.find((segment) => segment.id === selected()?.id)?.detail;
  return (
    <section
      ref={(el) => (chart = el)}
      class="model-providers__usage-bars"
      data-sorting={preview() ? true : undefined}
      aria-label={t("modelProviders.limits.subscriptionLimits")}
    >
      <Loading fallback={<small>{t("common.loading")}</small>}>
        <div class="model-providers__usage-window">
          <span />
          <div class="model-providers__usage-track">
            <For each={ids()}>
              {(id, index) => (
                <button
                  type="button"
                  aria-expanded={props.expandedAccount === id ? "true" : "false"}

                  onClick={(e) => {
                    if (!e.detail || !suppressPointerClick) {
                      props.onToggleAccount(id);
                    }
                  }}
                  aria-keyshortcuts={props.canReorder ? "ArrowLeft ArrowRight" : undefined}
                  onKeyDown={(e) => reorderByKey(e, id, index())}
                  class="model-providers__segment-name"
                  title={preview() ? undefined : props.identities.get(id)}
                  data-movable={props.canReorder || undefined}
                  data-grabbed={preview()?.source === index() || undefined}
                  style={{ translate: translation(index()) }}
                  onPointerDown={(e) => startDrag(e, index())}
                >
                  <span class="settings-control__sr-label">
                    {t("modelProviders.limits.detailsFor", { account: props.identities.get(id)! })}
                  </span>
                  <span class="model-providers__account-name" aria-hidden="true">
                    {props.identities.get(id)}
                  </span>
                  {props.status(id)}
                </button>
              )}
            </For>
          </div>
        </div>
        <For each={tracks()} keyed={(track) => track.label}>
          {(track) => (
            <div class="model-providers__usage-window" role="group" aria-label={track().label}>
              <span class="model-providers__usage-label">{track().label}</span>
              <div class="model-providers__usage-track">
                <For each={track().segments} keyed={(s) => s.id}>
                  {(segment, index) => {
                    const id = () => segment().id;
                    return (
                      <button
                        type="button"
                        class="model-providers__usage-segment"
                        data-account-segment={id()}
                        data-movable={props.canReorder || undefined}
                        data-grabbed={preview()?.source === index() || undefined}
                        style={{ translate: translation(index()) }}
                        data-known={segment().percent !== undefined}
                        data-tone={segment().tone}
                        aria-label={segment().detail}
                        title={preview() ? undefined : segment().detail}
                        aria-keyshortcuts={props.canReorder ? "ArrowLeft ArrowRight" : undefined}
                        aria-pressed={
                          selected()?.id === id() && selected()?.label === track().label
                            ? "true"
                            : "false"
                        }
                        onClick={(e) => {
                          if (e.detail && suppressPointerClick) {
                            return;
                          }
                          select(
                            selected()?.id === id() && selected()?.label === track().label
                              ? undefined
                              : { id: id(), label: track().label },
                          );
                        }}
                        onKeyDown={(e) => reorderByKey(e, id(), index())}
                        onPointerDown={(e) => startDrag(e, index())}
                      >
                        <span
                          class="model-providers__segment-fill"
                          aria-hidden="true"
                          style={{ width: (segment().percent ?? 0) + "%" }}
                        />
                        <strong>
                          {segment().percent === undefined ? "—" : segment().percent + "%"}
                        </strong>
                      </button>
                    );
                  }}
                </For>
              </div>
            </div>
          )}
        </For>
        <div
          class="model-providers__usage-window"
          role="group"
          aria-label={t("modelProviders.limits.credits")}
        >
          <span class="model-providers__usage-label">{t("modelProviders.limits.credits")}</span>
          <div class="model-providers__usage-track">
            <For each={props.readings}>
              {(read, index) => {
                const credit = () => {
                  const balance = accountCreditBalance(read.result().snapshot);
                  return balance
                    ? formatNumber(balance.amount, { maximumSignificantDigits: 21 })
                    : undefined;
                };
                return (
                  <span
                    class="model-providers__credit"
                    data-grabbed={preview()?.source === index() || undefined}
                    style={{ translate: translation(index()) }}
                  >
                    <span class="settings-control__sr-label">
                      {props.identities.get(read.account().profileId)}:{" "}
                    </span>
                    <span aria-hidden={credit() === undefined ? "true" : undefined}>
                      {credit() ?? "—"}
                    </span>
                    <Show when={credit() === undefined}>
                      <span class="settings-control__sr-label">
                        {t(
                          read.result().loading
                            ? "common.loading"
                            : "modelProviders.limits.notReported",
                        )}
                      </span>
                    </Show>
                  </span>
                );
              }}
            </For>
          </div>
        </div>
        <Show when={selectedDetail()}>{(detail) => <small role="status">{detail()}</small>}</Show>
      </Loading>
    </section>
  );
}
