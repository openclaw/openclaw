import type { JSX } from "@solidjs/web";
import { For, Repeat, Show, createMemo } from "solid-js";
import "../../components/sparkline-tile.tsx";
import { Icon } from "../../components/solid/icon.tsx";
import { formatResourceBytes as bytes, formatTimeAgo } from "../../lib/format.ts";
import { t } from "../../lib/reactive/i18n.ts";
import type { SparklineSample } from "../../lib/sparkline-types.ts";
import type { SystemsInventoryRow } from "./systems-data.ts";
import type { Systems } from "./systems-state.ts";
import {
  SYSTEMS_GATEWAY_STALE_MS,
  SYSTEMS_NODE_STALE_MS,
  systemMeasurements,
  type HostMeasurements,
  type SystemsTelemetrySample,
} from "./systems-telemetry.ts";

function metricSamples(
  history: readonly SystemsTelemetrySample[],
  read: (stats: HostMeasurements) => number | undefined,
): SparklineSample[] {
  const samples: SparklineSample[] = [];
  for (const { at, stats } of history) {
    const value = read(stats);
    if (value === undefined || !Number.isFinite(value)) {
      samples.length = 0;
    } else {
      samples.push({ at, value });
    }
  }
  return samples;
}

type Volume = { path: string; totalBytes?: number; availableBytes?: number };

/** Volumes with the least free space first; the root reading stands in when none are listed. */
function sortedVolumes(stats: HostMeasurements): Volume[] {
  return (
    stats.disks ?? [
      {
        path: "/",
        totalBytes: stats.diskTotalBytes,
        availableBytes: stats.diskAvailableBytes,
      },
    ]
  ).toSorted(
    (a, b) =>
      (a.availableBytes ?? 0) / (a.totalBytes || 1) -
        (b.availableBytes ?? 0) / (b.totalBytes || 1) || a.path.localeCompare(b.path),
  );
}

const byteValue = (value: number | undefined) => (value === undefined ? "—" : bytes(value));

function VolumeSummary(props: { disks: readonly Volume[] }) {
  return (
    <div class="systems-volume-summary">
      <span>{t("systems.disk")}</span>
      <ul>
        <Repeat count={3}>
          {(index) => (
            <li aria-hidden={props.disks[index] ? undefined : "true"}>
              <Show when={props.disks[index]}>
                {(disk) => (
                  <>
                    <span title={disk().path}>{disk().path}</span>
                    <span>
                      {byteValue(disk().availableBytes)} / {byteValue(disk().totalBytes)}
                    </span>
                  </>
                )}
              </Show>
            </li>
          )}
        </Repeat>
      </ul>
    </div>
  );
}

export function SystemMeasurements(props: {
  row: SystemsInventoryRow;
  controller: Systems;
  summary?: boolean;
  onDetails?: () => void;
  /** Summary only: further cards in the same row, such as Backups. */
  cards?: JSX.Element;
  /** Summary only: the strip shows as one line of headline values. */
  collapsed?: boolean;
  onCollapsedChange?: (collapsed: boolean) => void;
}) {
  const row = () => props.row;
  const controller = () => props.controller;
  const stats = () => systemMeasurements(row());

  const observedAt = () => row().node?.hostStats?.updatedAtMs ?? controller().sampledAtMs();
  const gatewayHost = () => row()!.environment.id === "gateway";
  const lastKnown = () =>
    !controller().connected() ||
    row()!.environment.status !== "available" ||
    Boolean(controller().state.inventory?.errors[gatewayHost() ? "systemInfo" : "nodes"]) ||
    (observedAt() !== null &&
      Date.now() - observedAt()! >
        (gatewayHost() ? SYSTEMS_GATEWAY_STALE_MS : SYSTEMS_NODE_STALE_MS));
  const retained = () => controller().telemetryHistory(row()!.environment.id);
  const history = () =>
    retained().length ? retained() : [{ at: observedAt() ?? 0, stats: stats()! }];
  const volumes = createMemo(() => (stats() ? sortedVolumes(stats()!) : []));
  // Keyboard focus follows the strip between its chevron and the collapsed line.
  const setCollapsed = (collapsed: boolean, event: MouseEvent) => {
    const button = event.currentTarget as HTMLElement;
    const focused = button === document.activeElement;
    const strip = button.closest(".systems-overview");
    props.onCollapsedChange?.(collapsed);
    if (focused) {
      requestAnimationFrame(() =>
        strip
          ?.querySelector<HTMLElement>(collapsed ? ".systems-strip-line" : ".systems-strip__toggle")
          ?.focus(),
      );
    }
  };
  const collapseToggle = () =>
    props.onCollapsedChange ? (
      <button
        type="button"
        class="systems-strip__toggle"
        aria-expanded="true"
        aria-label={t("systems.collapseStats")}
        title={t("systems.collapseStats")}
        onClick={(event) => setCollapsed(true, event)}
      >
        <Icon name="chevronUp" />
      </button>
    ) : null;
  const collapsedLine = (content: JSX.Element) => (
    <button
      type="button"
      class="systems-strip-line"
      aria-expanded="false"
      title={t("systems.expandStats")}
      onClick={(event) => setCollapsed(false, event)}
    >
      <span class="sr-only">{t("systems.expandStats")}</span>
      <span class="systems-strip-line__values">{content}</span>
      <Icon name="chevronDown" />
    </button>
  );
  const hasMultipleDisks = () => {
    const disks = stats()?.disks;
    return disks !== undefined && disks.length !== 1;
  };
  const noTelemetry = () =>
    (gatewayHost()
      ? controller().state.inventory?.errors.systemInfo
      : row().environment.type === "node"
        ? controller().state.inventory?.errors.nodes
        : undefined) ??
    (controller().telemetryLoading(row()) ? t("common.loading") : t("systems.noTelemetry"));
  const Disk = (diskProps: { path?: string; totalBytes?: number }) => (
    <openclaw-sparkline
      class="gateway-vital systems-vital systems-vital--disk"
      title={diskProps.path}
      prop:label={diskProps.path ? `${t("systems.disk")} ${diskProps.path}` : t("systems.disk")}
      prop:sub={diskProps.totalBytes === undefined ? "" : `/ ${bytes(diskProps.totalBytes!)}`}
      prop:samples={metricSamples(history(), (sample) =>
        diskProps.path === undefined
          ? sample.disks === undefined
            ? sample.diskAvailableBytes
            : undefined
          : sample.disks?.find((disk) => disk.path === diskProps.path)?.availableBytes,
      )}
      prop:format={bytes}
      prop:autorange={true}
    />
  );
  return (
    <Show
      when={stats()}
      fallback={
        <>
          {props.summary && props.collapsed ? (
            collapsedLine(<span>{noTelemetry()}</span>)
          ) : props.summary ? (
            <div class="systems-metrics">
              <div class="systems-vitals">
                <p class="systems-no-telemetry">{noTelemetry()}</p>
                {props.cards}
              </div>
              <div class="systems-metrics-caption">{collapseToggle()}</div>
            </div>
          ) : (
            <p class="systems-no-telemetry">{noTelemetry()}</p>
          )}
        </>
      }
    >
      <Show when={row().environment.id} keyed>
        {(_environmentId) => (
          <>
            {props.summary && props.collapsed ? (
              <div class="systems-metrics" data-stale={String(lastKnown())}>
                {collapsedLine(
                  <>
                    <span>
                      <strong>{stats()!.loadAverage?.[0]?.toFixed(2) ?? "—"}</strong>{" "}
                      {t("systems.load")}
                    </span>
                    <span>
                      <strong>{bytes(stats()!.memoryTotalBytes - stats()!.memoryFreeBytes)}</strong>{" "}
                      {t("systems.memory")} / {bytes(stats()!.memoryTotalBytes)}
                    </span>
                    <Show when={volumes()[0]}>
                      {(disk) => (
                        <span>
                          <strong>{byteValue(disk().availableBytes)}</strong> {t("systems.disk")}
                          {volumes().length > 1 ? ` ${disk().path}` : ""} /{" "}
                          {byteValue(disk().totalBytes)}
                        </span>
                      )}
                    </Show>
                  </>,
                )}
              </div>
            ) : (
              <div class="systems-metrics" data-stale={String(lastKnown())}>
                <div
                  class={[
                    "systems-vitals",
                    { "systems-vitals--volumes": !props.summary && hasMultipleDisks() },
                  ]}
                >
                  <openclaw-sparkline
                    class="gateway-vital systems-vital systems-vital--load"
                    prop:label={t("systems.load")}
                    prop:sub={t("systems.cpuCount", { count: String(stats()!.cpuCount) })}
                    prop:samples={metricSamples(history(), (sample) => sample.loadAverage?.[0])}
                    prop:format={(value: number) => value.toFixed(2)}
                    prop:floorMax={stats()!.cpuCount}
                  />
                  <openclaw-sparkline
                    class="gateway-vital systems-vital systems-vital--memory"
                    prop:label={t("systems.memory")}
                    prop:sub={`/ ${bytes(stats()!.memoryTotalBytes)}`}
                    prop:samples={metricSamples(
                      history(),
                      (sample) => sample.memoryTotalBytes - sample.memoryFreeBytes,
                    )}
                    prop:format={bytes}
                    prop:floorMax={stats()!.memoryTotalBytes}
                  />
                  {props.summary ? (
                    <>
                      <VolumeSummary disks={volumes()} />
                      {props.cards}
                    </>
                  ) : stats()!.disks === undefined ? (
                    <Disk totalBytes={stats()!.diskTotalBytes} />
                  ) : (
                    <For each={stats()!.disks!} keyed={(disk) => disk.path}>
                      {(disk) => <Disk path={disk().path} totalBytes={disk().totalBytes} />}
                    </For>
                  )}
                </div>
                <div class="systems-metrics-caption">
                  {props.summary ? (
                    <button
                      class="systems-summary-link systems-volumes-link"
                      onClick={() => props.onDetails?.()}
                    >
                      {volumes().length > 3
                        ? t("systems.moreVolumes", { count: String(volumes().length - 3) })
                        : t("systems.volumeDetails")}
                    </button>
                  ) : null}
                  {!lastKnown() && history().length < 2 ? (
                    <span>{t("systems.collectingHistory")}</span>
                  ) : null}
                  {observedAt() === null ? null : (
                    <span class="systems-sample-time">
                      {t(lastKnown() ? "systems.lastKnown" : "systems.sampled", {
                        time: formatTimeAgo(Math.max(0, Date.now() - observedAt()!)),
                      })}
                    </span>
                  )}
                  {props.summary ? collapseToggle() : null}
                </div>
              </div>
            )}
          </>
        )}
      </Show>
    </Show>
  );
}
