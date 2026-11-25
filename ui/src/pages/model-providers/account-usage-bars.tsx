import type { JSX } from "@solidjs/web";
import { createMemo, createSignal, For, Loading, omit, Show } from "solid-js";
import {
  remainingPercent,
  remainingTone,
  resetText,
} from "../../components/solid/provider-usage.tsx";
import { moveArrayEntry } from "../../lib/array-order.ts";
import { formatNumber } from "../../lib/reactive/format.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { createPointerDrag } from "../../lib/reactive/pointer-drag.ts";
import { accountCreditBalance, type AccountUsageRead } from "./account-usage.tsx";
import { neighborOffset, reorderByArrow } from "./profile-reorder.ts";

function UsageTrack(props: { label?: string; heading?: JSX.Element; children: JSX.Element }) {
  return (
    <div
      class="model-providers__usage-window"
      role={props.label === undefined ? undefined : "group"}
      aria-label={props.label}
    >
      <span class={props.label === undefined ? undefined : "model-providers__usage-label"}>
        {props.label ?? props.heading}
      </span>
      <div class="model-providers__usage-track">{props.children}</div>
    </div>
  );
}

/** Equal slots compare accounts, not token capacity. Only windows with the same label share a track. */
export function AccountUsageBars(props: {
  readings: (AccountUsageRead & { name: () => string; status: () => JSX.Element })[];
  expandedAccount?: string;
  onToggleAccount: (id: string) => void;
  canReorder: boolean;
  onReorder: (ids: string[]) => void;
}) {
  const ids = createMemo(() => props.readings.map((read) => read.account().profileId));
  const pending = createMemo(() => props.readings.some((read) => read.result().loading));
  const tracks = createMemo(() => {
    const accounts = props.readings.map((read) => ({
      id: read.account().profileId,
      name: read.name(),
      value: read.result(),
    }));
    const labels = new Set(
      accounts.flatMap(
        ({ value }) =>
          value.snapshot?.windows.filter((w) => !w.groupLabel).map((w) => w.label) ?? [],
      ),
    );
    // Reserve the common Codex slots, not entitlements. Only a reported window gets a label.
    const slots = new Set(["5h", "Week", ...labels]);
    return [...slots]
      .filter((label) => pending() || labels.has(label))
      .map((label) => ({
        label,
        reported: labels.has(label),
        segments: accounts.map(({ id, name, value }) => {
          const window = value.snapshot?.windows.find((w) => !w.groupLabel && w.label === label);
          const percent = window && remainingPercent(window);
          const reset = window && resetText(window);
          const quota =
            percent === undefined
              ? (value.error ?? value.snapshot?.error ?? t("modelProviders.limits.notReported"))
              : t("usage.providerUsage.remaining", { percent: String(percent) });
          return {
            id,
            pending: value.loading,
            percent,
            tone: window && remainingTone(window),
            detail: [
              name,
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
  const drag = createPointerDrag({ cancelOnEscape: true });
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
    return `${neighborOffset(index, p.source, p.target, p.pitch)}px`;
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
    props.onReorder(moveArrayEntry(current, source, target));
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
      suppressPointerClick = dragged;
      setPreview(undefined);
    };
    drag.start(event, cell, {
      move: update,
      cancel: cleanup,
      end: (p) => {
        update(p);
        cleanup();
        if (target !== source) {
          move(initialIds[source]!, initialIds[target]!);
        }
      },
    });
  };
  function ColumnButton(
    cell: JSX.ButtonHTMLAttributes<HTMLButtonElement> & {
      index: number;
      activate: () => void;
    },
  ) {
    const attributes = omit(cell, "index", "activate", "title", "children");
    return (
      <button
        {...attributes}
        type="button"
        title={preview() ? undefined : cell.title}
        data-movable={props.canReorder || undefined}
        data-grabbed={preview()?.source === cell.index || undefined}
        style={{ translate: translation(cell.index) }}
        aria-keyshortcuts={props.canReorder ? "ArrowLeft ArrowRight" : undefined}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            select(undefined);
          } else if (props.canReorder) {
            const source = ids()[cell.index]!;
            reorderByArrow(e, ids(), cell.index, "horizontal", (target) => move(source, target));
          }
        }}
        onPointerDown={(e) => startDrag(e, cell.index)}
        onClick={(e) => {
          if (!e.detail || !suppressPointerClick) {
            cell.activate();
          }
        }}
      >
        {cell.children}
      </button>
    );
  }
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
      <Loading fallback={<small role="status">{t("common.loading")}</small>}>
        <UsageTrack
          heading={
            <small
              role={pending() ? "status" : undefined}
              style={{ visibility: pending() ? undefined : "hidden" }}
            >
              {t("common.loading")}
            </small>
          }
        >
          <For each={props.readings}>
            {(read, index) => {
              const id = () => read.account().profileId;
              const plan = () => read.result().snapshot?.plan?.trim();
              return (
                <ColumnButton
                  index={index()}
                  activate={() => props.onToggleAccount(id())}
                  aria-expanded={props.expandedAccount === id() ? "true" : "false"}
                  class="model-providers__segment-name"
                  aria-description={plan() || undefined}
                  title={[read.name(), plan()].filter(Boolean).join(" · ")}
                >
                  <span class="settings-control__sr-label">
                    {t("modelProviders.limits.detailsFor", {
                      account: read.name(),
                    })}
                  </span>
                  <span class="model-providers__account-name" aria-hidden="true">
                    {read.name()}
                  </span>
                  {read.status()}
                </ColumnButton>
              );
            }}
          </For>
        </UsageTrack>
        <For each={tracks()} keyed={(track) => track.label}>
          {(track) => (
            <UsageTrack label={track().reported ? track().label : undefined}>
              <For each={track().segments} keyed={(s) => s.id}>
                {(segment, index) => {
                  const id = () => segment().id;
                  const pressed = () =>
                    selected()?.id === id() && selected()?.label === track().label;
                  return (
                    <Show
                      when={track().reported && !segment().pending}
                      fallback={
                        <span
                          aria-hidden="true"
                          class={segment().pending ? "model-providers__usage-segment" : undefined}
                          data-grabbed={preview()?.source === index() || undefined}
                          style={{ translate: translation(index()) }}
                        />
                      }
                    >
                      <ColumnButton
                        index={index()}
                        class="model-providers__usage-segment"
                        data-account-segment={id()}
                        data-known={segment().percent !== undefined}
                        data-tone={segment().tone}
                        aria-label={segment().detail}
                        title={segment().detail}
                        aria-pressed={pressed() ? "true" : "false"}
                        activate={() =>
                          select(pressed() ? undefined : { id: id(), label: track().label })
                        }
                      >
                        <span
                          class="model-providers__segment-fill"
                          aria-hidden="true"
                          style={{ width: (segment().percent ?? 0) + "%" }}
                        />
                        <strong>
                          {segment().percent === undefined ? "—" : segment().percent + "%"}
                        </strong>
                      </ColumnButton>
                    </Show>
                  );
                }}
              </For>
            </UsageTrack>
          )}
        </For>
        <UsageTrack label={t("modelProviders.limits.credits")}>
          <For each={props.readings}>
            {(read, index) => {
              const credit = createMemo(() => {
                const balance = accountCreditBalance(read.result().snapshot);
                return balance
                  ? formatNumber(balance.amount, { maximumSignificantDigits: 21 })
                  : undefined;
              });
              return (
                <span
                  class="model-providers__credit"
                  aria-hidden={read.result().loading ? "true" : undefined}
                  data-grabbed={preview()?.source === index() || undefined}
                  style={{ translate: translation(index()) }}
                >
                  <span class="settings-control__sr-label">
                    {read.name()}: {credit() ?? t("modelProviders.limits.notReported")}
                  </span>
                  <span aria-hidden="true">{read.result().loading ? "" : (credit() ?? "—")}</span>
                </span>
              );
            }}
          </For>
        </UsageTrack>
        <For each={props.readings}>
          {(read) => {
            const outcome = () => {
              const { error, snapshot } = read.result();
              const failure = error ?? snapshot?.error;
              if (failure !== undefined) {
                return failure
                  ? t("modelProviders.limits.readFailed", { error: failure })
                  : t("usage.providerUsage.unavailable");
              }
              return undefined;
            };
            return (
              <Show when={outcome()}>
                {(message) => (
                  <small role="status">
                    {read.name()}: {message()}
                  </small>
                )}
              </Show>
            );
          }}
        </For>
        <Show when={selectedDetail()}>{(detail) => <small role="status">{detail()}</small>}</Show>
      </Loading>
    </section>
  );
}
