import { createMemo, createSignal, Loading, refresh, Show } from "solid-js";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../../../packages/gateway-protocol/src/client-info.ts";
import type { NodeListNode } from "../../../../src/shared/node-list-types.ts";
import { deviceSettingsGroupLabelKey } from "../../app-navigation.ts";
import { SettingsRow, SettingsValue } from "../../components/solid/settings-ui.tsx";
import { formatUiError } from "../../lib/format-error.ts";
import { projectNativeDeviceSettings } from "../../lib/reactive/application-native.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { SettingsSelectRow } from "./settings-select-row.tsx";
import { DeviceUpdates } from "./updates-device.tsx";
import type { UpdatesViewProps } from "./updates-types.ts";

const nativeClientIds: ReadonlySet<string> = new Set([
  GATEWAY_CLIENT_IDS.MACOS_APP,
  GATEWAY_CLIENT_IDS.LINUX_APP,
  GATEWAY_CLIENT_IDS.IOS_APP,
  GATEWAY_CLIENT_IDS.WATCHOS_APP,
  GATEWAY_CLIENT_IDS.ANDROID_APP,
]);

export function pairedCompanionApps(nodes: readonly NodeListNode[], localNodeId?: string) {
  return nodes
    .filter(
      (node) =>
        node.paired === true &&
        node.clientMode === GATEWAY_CLIENT_MODES.NODE &&
        nativeClientIds.has(node.clientId ?? "") &&
        (!node.approvalState || node.approvalState === "approved") &&
        (!localNodeId || node.nodeId !== localNodeId),
    )
    .toSorted(
      (a, b) =>
        Number(b.connected === true) - Number(a.connected === true) ||
        (b.lastConnectedAtMs ?? 0) - (a.lastConnectedAtMs ?? 0) ||
        (a.displayName ?? a.nodeId).localeCompare(b.displayName ?? b.nodeId),
    );
}

export function AppsUpdates(props: UpdatesViewProps) {
  const native = createMemo(() =>
    props.nativeDeviceSettings ? projectNativeDeviceSettings(props.nativeDeviceSettings) : null,
  );
  const local = () => native()?.read();
  const [selection, setSelection] = createSignal<string | null>(null);
  // A read-only view-local query: Solid retires superseded connection results;
  // no renderer cache publishes into the Gateway or the Devices page owner.
  const nodes = createMemo(() => {
    void props.appsConnectionRevision;
    const client = props.appsClient;
    return props.connected && client
      ? client.request<{ nodes: NodeListNode[] }>("node.list", {}).then(
          (result) => ({ nodes: result.nodes, error: null }),
          (error: unknown) => ({ nodes: [], error: formatUiError(error) }),
        )
      : { nodes: [], error: null };
  });
  const apps = createMemo(() => pairedCompanionApps(nodes().nodes, local()?.device.nodeId));
  const options = createMemo(() => [
    ...(local()
      ? [
          {
            value: "local",
            label: `${local()!.device.modelName ?? t(deviceSettingsGroupLabelKey(local()!))} · ${t("updates.apps.current")}`,
          },
        ]
      : []),
    ...apps().map((node) => ({
      value: `node:${node.nodeId}`,
      label: `${node.displayName ?? node.modelIdentifier ?? node.nodeId} · ${t(node.connected ? "updates.apps.connected" : "updates.apps.offline")}`,
    })),
  ]);
  // A removed selection falls back to the first current installation, never a stale node.
  const selected = () =>
    local() && (selection() === null || selection() === "local")
      ? "local"
      : (options().find((option) => option.value === selection())?.value ?? options()[0]?.value);
  const remote = () => apps().find((node) => `node:${node.nodeId}` === selected());
  return (
    <>
      <Show when={!props.connected}>
        <p class="settings-page__hint">{t("updates.apps.disconnected")}</p>
      </Show>
      <Loading
        on={[props.appsClient, props.appsConnectionRevision, props.connected]}
        fallback={<p role="status">{t("common.loading")}</p>}
      >
        <Show when={nodes().error}>
          <div class="callout danger" role="alert">
            {nodes().error}
            <button class="btn btn--sm" type="button" onClick={() => void refresh(nodes)}>
              {t("common.retry")}
            </button>
          </div>
        </Show>
        <Show
          when={options().length > 0}
          fallback={<p class="settings-page__hint">{t("updates.apps.empty")}</p>}
        >
          <SettingsSelectRow
            title={t("updates.page.system")}
            value={selected() ?? ""}
            options={options()}
            onChange={setSelection}
          />
          <Show when={remote()}>
            {(node) => (
              <section class="card stack" aria-label={t("updates.device.checkTitle")}>
                <h2 class="card-title">
                  {node().displayName ?? node().modelIdentifier ?? node().nodeId}
                </h2>
                <SettingsRow
                  title={t("updates.apps.platform")}
                  control={
                    <SettingsValue
                      value={node().platform ?? node().deviceFamily ?? node().clientId}
                    />
                  }
                />
                <SettingsRow
                  title={t("updates.device.version")}
                  control={
                    <SettingsValue value={node().version ?? t("updates.apps.unknownVersion")} />
                  }
                />
                <p class="settings-page__hint">
                  {t(node().connected ? "updates.apps.connected" : "updates.apps.offline")}
                </p>
                <SettingsRow
                  title={t("updates.apps.onDevice")}
                  description={t("updates.apps.onDeviceDescription")}
                />
              </section>
            )}
          </Show>
        </Show>
      </Loading>
      {/* The native updater does not depend on Gateway inventory readiness. */}
      <Loading>
        <Show when={selected() === "local" && props.nativeDeviceSettings} keyed>
          {(capability) => (
            <DeviceUpdates
              capability={capability}
              captureCommandPresentation={props.captureCommandPresentation}
            />
          )}
        </Show>
      </Loading>
      <Show when={props.connected && props.appsClient}>
        <button class="btn btn--sm" type="button" onClick={() => void refresh(nodes)}>
          {t("common.refresh")}
        </button>
      </Show>
    </>
  );
}
