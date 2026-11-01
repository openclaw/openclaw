import { For, Repeat, Show, createMemo } from "solid-js";
import "../../components/sparkline-tile.tsx";
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

function VolumeSummary(props: { stats: HostMeasurements; onDetails: () => void }) {
  const disks = createMemo(() =>
    (
      props.stats.disks ?? [
        {
          path: "/",
          totalBytes: props.stats.diskTotalBytes,
          availableBytes: props.stats.diskAvailableBytes,
        },
      ]
    ).toSorted(
      (a, b) =>
        (a.availableBytes ?? 0) / (a.totalBytes || 1) -
          (b.availableBytes ?? 0) / (b.totalBytes || 1) || a.path.localeCompare(b.path),
    ),
  );
  return (
    <div class="systems-volume-summary">
      <span>{t("systems.disk")}</span>
      <ul>
        <Repeat count={3}>
          {(index) => (
            <li aria-hidden={disks()[index] ? undefined : "true"}>
              <Show when={disks()[index]}>
                {(disk) => (
                  <>
                    <span title={disk().path}>{disk().path}</span>
                    <span>
                      {disk().availableBytes === undefined ? "—" : bytes(disk().availableBytes!)} /{" "}
                      {disk().totalBytes === undefined ? "—" : bytes(disk().totalBytes!)}
                    </span>
                  </>
                )}
              </Show>
            </li>
          )}
        </Repeat>
      </ul>
      <button class="systems-summary-link" onClick={() => props.onDetails()}>
        {disks().length > 3
          ? t("systems.moreVolumes", { count: String(disks().length - 3) })
          : t("systems.volumeDetails")}
      </button>
    </div>
  );
}

export function SystemMeasurements(props: {
  row: SystemsInventoryRow;
  controller: Systems;
  summary?: boolean;
  onDetails?: () => void;
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
  const hasMultipleDisks = () => {
    const disks = stats()?.disks;
    return disks !== undefined && disks.length !== 1;
  };
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
    <Show when={stats()} fallback={<p class="systems-no-telemetry">{t("systems.noTelemetry")}</p>}>
      <Show when={row().environment.id} keyed>
        {(_environmentId) => (
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
              {props.summary ? null : stats()!.disks === undefined ? (
                <Disk totalBytes={stats()!.diskTotalBytes} />
              ) : (
                <For each={stats()!.disks!} keyed={(disk) => disk.path}>
                  {(disk) => <Disk path={disk().path} totalBytes={disk().totalBytes} />}
                </For>
              )}
            </div>
            {props.summary ? (
              <VolumeSummary stats={stats()!} onDetails={() => props.onDetails?.()} />
            ) : null}
            <div class="systems-metrics-caption">
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
            </div>
          </div>
        )}
      </Show>
    </Show>
  );
}
