import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { JSX } from "@solidjs/web";
import { createMemo, For, Show } from "solid-js";
import type { PresenceEntry } from "../../api/types.ts";
import { openDesktopFocus } from "../../components/desktop/desktop-focus-window.ts";
import { Icon } from "../../components/solid/icon.tsx";
import {
  SettingsStatus,
  SettingsSection,
  SettingsEmpty,
  SettingsLoadingSkeleton,
} from "../../components/solid/settings-ui.tsx";
import { workerCapacityPresentation } from "../../components/solid/worker-capacity.tsx";
import { registerDevicesEnglish } from "../../i18n/locales/en-devices.ts";
import { formatDurationCompact } from "../../lib/format-duration.ts";
import { formatList, formatRelativeTimestamp, formatTimeAgo } from "../../lib/format.ts";
import { macFamilyLabel } from "../../lib/mac-form-factor.ts";
import type { DeviceTokenSummary } from "../../lib/nodes/index.ts";
import {
  buildDeviceInventory,
  findGatewayPresence,
  listStaleInventoryEntries,
  listUnpairedPresence,
  resolveInventoryRemoval,
  type DeviceInventoryEntry,
  type DeviceInventoryGroup,
} from "../../lib/nodes/inventory.ts";
import type { InventoryRemovalRequest } from "../../lib/nodes/page-operations.ts";
import { prettifyPlatform } from "../../lib/platform-label.ts";
import { t, registerEnglishCatalog } from "../../lib/reactive/i18n.ts";
import { CapabilityChips } from "./capability-chips.tsx";
import { deviceDesktopEnvironment, DeviceEntryMenu } from "./entry-menu.tsx";
import { HostStats } from "./host-stats.tsx";
import { PendingDeviceRows } from "./view-pending-devices.tsx";
import { deviceIcon, DeviceTile, DeviceIdentityFacts } from "./view-shared.tsx";
import type { DevicesProps } from "./view.types.ts";

registerEnglishCatalog(registerDevicesEnglish);

function toRemovalRequest(entry: DeviceInventoryEntry): InventoryRemovalRequest {
  const removal = resolveInventoryRemoval(entry);
  return { id: entry.id, name: entry.name, ...removal };
}

function inventorySummary(
  groups: DeviceInventoryGroup[],
  pendingCount: number,
  loading: boolean,
): string {
  if (loading && groups.length === 0) {
    return "";
  }
  const connected = groups.filter((group) => group.primary.connected).length;
  const parts = [
    t("devices.inventory.summaryConnected", {
      connected: String(connected),
      total: String(groups.length),
    }),
  ];
  if (pendingCount > 0) {
    parts.push(t("devices.inventory.summaryPending", { count: String(pendingCount) }));
  }
  return parts.join(" · ");
}

export function DeviceInventory(props: DevicesProps) {
  const pending = () => props.devicesList?.pending ?? [];
  const paired = () => props.devicesList?.paired ?? [];
  const groups = createMemo(() =>
    buildDeviceInventory({ paired: paired(), nodes: props.nodes, presence: props.presence }),
  );
  const gatewayPresence = createMemo(() => findGatewayPresence(props.presence));
  const unpairedPresence = createMemo(() => listUnpairedPresence(props.presence, groups()));
  const stale = createMemo(() => listStaleInventoryEntries(groups()));
  const loading = createMemo(() => props.loading || props.devicesLoading);
  const actions = (
    <>
      {stale().length > 0 ? (
        <button
          class="btn btn--sm danger"
          title={props.canManagePairing ? "" : t("devices.readOnly.pairingRequired")}
          disabled={!props.canManagePairing}
          onClick={() => props.onInventoryCleanup(stale().map(toRemovalRequest))}
        >
          <Icon name="trash" />{" "}
          {t("devices.inventory.cleanupStale", { count: String(stale().length) })}
        </button>
      ) : undefined}
      <button
        class="btn"
        title={props.canPairDevice ? "" : t("devices.pairing.adminRequired")}
        disabled={!props.canPairDevice}
        onClick={() => props.onDevicePairSetupOpen()}
      >
        <Icon name="plus" /> {t("devices.pairing.button")}
      </button>
    </>
  );
  // Pending requests and unpaired presence render in their own sections, so
  // this section's empty state depends only on its own rows.
  const empty = createMemo(() => groups().length === 0 && !gatewayPresence());
  const deviceRows = (
    <>
      <Show when={gatewayPresence()}>
        {(presence) => (
          <PresenceRow presence={{ kind: "gateway", entry: presence() }} devices={props} />
        )}
      </Show>
      {loading() && groups().length === 0 ? (
        <SettingsLoadingSkeleton />
      ) : empty() ? (
        <SettingsEmpty message={t("devices.inventory.empty")} />
      ) : (
        <For each={groups()} keyed={(group) => group.key}>
          {(group) => <InventoryGroup group={group()} devices={props} />}
        </For>
      )}
    </>
  );
  return (
    <>
      {props.devicesError ? <div class="callout danger">{props.devicesError}</div> : undefined}
      {props.lastError ? <div class="callout danger">{props.lastError}</div> : undefined}
      {pending().length > 0 ? (
        <SettingsSection title={t("devices.inventory.pendingApproval")} count={pending().length}>
          <PendingDeviceRows pending={pending()} paired={paired()} devices={props} />
        </SettingsSection>
      ) : undefined}
      <SettingsSection
        title={t("devices.inventory.title")}
        description={inventorySummary(groups(), pending().length, loading())}
        actions={actions}
      >
        {deviceRows}
      </SettingsSection>
      {unpairedPresence().length > 0 ? (
        <SettingsSection title={t("devices.inventory.connectedWithoutPairing")}>
          <For
            each={unpairedPresence()}
            keyed={(entry) => entry.instanceId ?? entry.deviceId ?? entry.host}
          >
            {(entry) => (
              <PresenceRow presence={{ kind: "unpaired", entry: entry() }} devices={props} />
            )}
          </For>
        </SettingsSection>
      ) : undefined}
    </>
  );
}

function InventoryGroup(props: { group: DeviceInventoryGroup; devices: DevicesProps }) {
  return (
    <>
      <InventoryEntry entry={props.group.primary} devices={props.devices} />
      <Show when={props.group.duplicates.length > 0}>
        <details class="device-group__dups">
          <summary>
            {t(
              props.group.duplicates.length === 1
                ? "devices.inventory.olderPairing"
                : "devices.inventory.olderPairings",
              { count: String(props.group.duplicates.length), name: props.group.name },
            )}
          </summary>
          <For each={props.group.duplicates} keyed={(entry) => entry.id}>
            {(entry) => <InventoryEntry entry={entry()} devices={props.devices} />}
          </For>
        </details>
      </Show>
    </>
  );
}

function isWindowsPlatform(platform: string | undefined): boolean {
  const normalized = normalizeOptionalString(platform)?.toLowerCase();
  return (
    normalized === "win32" ||
    normalized === "windows" ||
    normalized?.startsWith("windows ") === true
  );
}

function isApprovedNodeEntry(entry: DeviceInventoryEntry): boolean {
  const node = entry.node;
  if (!node?.paired) {
    return false;
  }
  return node.approvalState === undefined || node.approvalState === "approved";
}

function resolveNodeCoreVersion(entry: DeviceInventoryEntry): string | undefined {
  const coreVersion = normalizeOptionalString(entry.node?.coreVersion);
  if (coreVersion) {
    return coreVersion;
  }
  if (normalizeOptionalString(entry.node?.uiVersion)) {
    return undefined;
  }
  const platform = normalizeOptionalString(entry.node?.platform)?.toLowerCase();
  // Legacy headless desktop nodes reported one version field as their core version.
  const legacyHeadless =
    platform === "darwin" || platform === "linux" || platform === "win32" || platform === "windows";
  return legacyHeadless ? normalizeOptionalString(entry.node?.version) : undefined;
}

function entryWarnStatuses(
  entry: DeviceInventoryEntry,
  gatewayVersion: string | null,
): JSX.Element[] {
  const statuses: JSX.Element[] = [];
  const warn = (kind: string, title = t(`devices.inventory.${kind}Title`)) =>
    statuses.push(
      <span title={title}>
        <SettingsStatus kind={"warn"} label={t(`devices.inventory.${kind}`)} />
      </span>,
    );
  const isApprovedNode = isApprovedNodeEntry(entry);
  const nodeVersion = resolveNodeCoreVersion(entry);
  if (isApprovedNode && nodeVersion && gatewayVersion && nodeVersion !== gatewayVersion) {
    warn("versionDrift", t("devices.inventory.versionDriftTitle", { nodeVersion, gatewayVersion }));
  }
  if (entry.node?.workerBundle?.status === "missing") {
    warn("workerMissing");
  }
  if (isApprovedNode && entry.node?.connected === false && isWindowsPlatform(entry.platform)) {
    warn("manualWake");
  }
  const approvalState = entry.node?.approvalState;
  if (approvalState === "pending-approval" || approvalState === "pending-reapproval") {
    statuses.push(<SettingsStatus kind={"warn"} label={t("devices.inventory.approvalNeeded")} />);
  }
  return statuses;
}

function formatInputRecency(lastInputSeconds: number): string {
  return t("devices.inventory.inputAgo", {
    time: formatTimeAgo(lastInputSeconds * 1000, { suffix: false }),
  });
}

function identityMetaParts(
  entry: Pick<PresenceEntry, "platform" | "deviceFamily" | "modelIdentifier" | "version">,
): string[] {
  const parts: string[] = [];
  if (entry.platform) {
    parts.push(prettifyPlatform(entry.platform, entry.deviceFamily));
  }
  if (entry.modelIdentifier) {
    const family = macFamilyLabel(entry.modelIdentifier);
    if (family) {
      parts.push(family);
    }
    parts.push(entry.modelIdentifier);
  }
  if (entry.version) {
    parts.push(entry.version);
  }
  return parts;
}

function entryMetaLine(entry: DeviceInventoryEntry): string {
  const parts = identityMetaParts(entry);
  if (entry.node?.workerBundle?.status === "installed") {
    parts.push(t("devices.inventory.workerVersion", { version: entry.node.workerBundle.version }));
  }
  if (entry.connected && entry.presence?.lastInputSeconds != null) {
    parts.push(formatInputRecency(entry.presence.lastInputSeconds));
  } else if (!entry.connected && entry.lastSeenAtMs) {
    parts.push(t("devices.inventory.seen", { time: formatRelativeTimestamp(entry.lastSeenAtMs) }));
  } else if (!entry.connected && entry.approvedAtMs) {
    parts.push(
      t("devices.inventory.approved", { time: formatRelativeTimestamp(entry.approvedAtMs) }),
    );
  }
  for (const role of entry.roles) {
    parts.push(role);
  }
  if (entry.autoApproved) {
    parts.push(t("devices.inventory.autoPaired"));
  }
  return parts.join(" · ");
}

// Node-controlled lists are unbounded input; cap the rendered items so a
// hostile or chatty node cannot bloat the inventory render.
const COMMAND_LINE_LIMIT = 16;

function CommandLine(props: { values: string[] }) {
  const visible = createMemo(() => props.values.slice(0, COMMAND_LINE_LIMIT));
  const overflow = createMemo(() => props.values.length - visible().length);
  const suffix = createMemo(() => (overflow() > 0 ? ` +${overflow()}` : ""));
  return (
    <Show when={props.values.length > 0}>
      <dt class="settings-row__desc">{t("devices.inventory.commands")}</dt>
      <dd class="settings-row__value settings-row__value--mono">
        {formatList(visible())}
        {suffix()}
      </dd>
    </Show>
  );
}

function EntryDetails(props: { entry: DeviceInventoryEntry; devices: DevicesProps }) {
  const tokens = createMemo(() => props.entry.device?.tokens ?? []);
  const commands = createMemo(() => props.entry.node?.commands ?? []);
  const scopes = createMemo(() => props.entry.scopes);
  return (
    <details class="device-entry__details">
      <summary>{t("devices.inventory.details")}</summary>
      <dl class="device-entry__facts">
        <DeviceIdentityFacts id={props.entry.id} remoteIp={props.entry.remoteIp} />
        {scopes().length > 0 ? (
          <>
            <dt class="settings-row__desc">{t("devices.inventory.scopesLabel")}</dt>
            <dd class="device-entry__scopes">
              <For each={scopes()}>
                {(scope) => <span class="device-capability device-capability--scope">{scope}</span>}
              </For>
            </dd>
          </>
        ) : undefined}
        {tokens().length > 0 ? (
          <>
            <dt class="settings-row__desc">{t("devices.inventory.tokens")}</dt>
            <dd class="device-entry__tokens">
              <table
                class="device-token-table settings-table--stacked"
                role="table"
                aria-label={t("devices.inventory.tokens")}
              >
                <thead>
                  <tr>
                    <th scope="col">{t("devices.inventory.tokenRole")}</th>
                    <th scope="col">{t("devices.inventory.tokenStatus")}</th>
                    <th scope="col">{t("devices.inventory.scopesLabel")}</th>
                    <th scope="col">{t("devices.inventory.tokenAge")}</th>
                    <th scope="col">{t("devices.inventory.actions")}</th>
                  </tr>
                </thead>
                <tbody>
                  <For each={tokens()} keyed={(token) => token.role}>
                    {(token) => (
                      <TokenRow
                        device={{ id: props.entry.id, name: props.entry.name }}
                        tokenSummary={token()}
                        devices={props.devices}
                      />
                    )}
                  </For>
                </tbody>
              </table>
            </dd>
          </>
        ) : undefined}
        <CommandLine values={commands()} />
      </dl>
    </details>
  );
}

function InventoryEntry(props: { entry: DeviceInventoryEntry; devices: DevicesProps }) {
  const capacity = createMemo(() =>
    workerCapacityPresentation({
      workerSlots: props.entry.node?.workerSlots,
      capabilities: props.entry.node?.caps,
      commands: props.entry.node?.commands,
      unavailable: props.entry.node?.connected !== true || !isApprovedNodeEntry(props.entry),
    }),
  );
  const pendingRequestId = createMemo(() =>
    props.entry.node?.approvalState === "pending-approval" ||
    props.entry.node?.approvalState === "pending-reapproval"
      ? props.entry.node.pendingRequestId
      : undefined,
  );
  const desktopEnvironment = createMemo(() =>
    deviceDesktopEnvironment(props.devices, `node:${props.entry.id}`),
  );
  const rowConnected = createMemo(() => props.entry.node?.connected ?? props.entry.connected);
  const connectionStatus = (
    <SettingsStatus
      kind={rowConnected() ? "ok" : "muted"}
      label={t(rowConnected() ? "devices.inventory.connected" : "devices.inventory.offline")}
    />
  );
  return (
    <div class="settings-row device-entry" title={capacity()?.title ?? undefined}>
      <DeviceTile icon={deviceIcon(props.entry)} />
      <div class="device-entry__body">
        <div class="device-entry__heading">
          <span class="settings-row__title">{props.entry.name}</span>
          <span class="device-entry__status">{connectionStatus}</span>
        </div>
        <span class="settings-row__desc">{entryMetaLine(props.entry)}</span>
        <HostStats
          stats={props.entry.node?.hostStats}
          lastKnownAtMs={!rowConnected() ? props.entry.node?.hostStats?.updatedAtMs : undefined}
        />
        <CapabilityChips caps={props.entry.node?.caps ?? []} />
      </div>
      <div class="settings-row__control">
        {capacity()?.meter ?? undefined}{" "}
        {entryWarnStatuses(props.entry, props.devices.gatewayVersion)}
        <DesktopControl
          devices={props.devices}
          environmentId={desktopEnvironment()}
          commands={props.entry.node?.commands}
        />
        <DeviceEntryMenu
          devices={props.devices}
          entry={{
            name: props.entry.name,
            deviceId: props.entry.id,
            desktopEnvironment: desktopEnvironment(),
            pendingRequestId: pendingRequestId(),
            onEditAlias: props.entry.device
              ? () =>
                  props.devices.onDeviceRename({
                    id: props.entry.id,
                    name: props.entry.name,
                    operatorLabel: props.entry.device?.operatorLabel,
                  })
              : undefined,
            onRemove: () => props.devices.onInventoryRemove(toRemovalRequest(props.entry)),
          }}
        />
      </div>
      <EntryDetails entry={props.entry} devices={props.devices} />
    </div>
  );
}

function PresenceRow(props: {
  presence: { kind: "gateway" | "unpaired"; entry: PresenceEntry };
  devices: DevicesProps;
}) {
  const entry = () => props.presence.entry;
  const gateway = () => props.presence.kind === "gateway";
  const parts = createMemo(() => {
    const current = entry();
    const result = identityMetaParts(current);
    if (current.lastInputSeconds != null) {
      result.push(formatInputRecency(current.lastInputSeconds));
    }
    if (gateway() && props.devices.gatewaySystemInfo) {
      result.push(
        t("devices.inventory.uptime", {
          time: formatDurationCompact(props.devices.gatewaySystemInfo.uptimeMs) ?? "",
        }),
      );
    }
    if (!gateway() && Array.isArray(current.roles)) {
      result.push(...current.roles.filter(Boolean));
    }
    return result;
  });
  const icon = () =>
    gateway() ? (
      <Icon name="server" />
    ) : (
      deviceIcon({
        clientMode: entry().mode ?? undefined,
        platform: entry().platform ?? undefined,
        modelIdentifier: entry().modelIdentifier ?? undefined,
      })
    );
  const title = () =>
    gateway()
      ? (entry().host ?? t("devices.execApprovals.gateway"))
      : (entry().host ?? entry().mode ?? t("devices.inventory.unknownClient"));
  const desktopEnvironment = createMemo(() =>
    gateway() ? deviceDesktopEnvironment(props.devices, "gateway") : undefined,
  );
  return (
    <div class="settings-row device-entry">
      <DeviceTile icon={icon()} />
      <div class="device-entry__body">
        <div class="device-entry__heading">
          <span class="settings-row__title">{title()}</span>
          <span class="device-entry__status">
            <SettingsStatus
              kind={gateway() ? "accent" : "muted"}
              label={t(gateway() ? "devices.inventory.gateway" : "devices.inventory.unpaired")}
            />
          </span>
        </div>
        {parts().length > 0 ? (
          <span class="settings-row__desc">{parts().join(" · ")}</span>
        ) : undefined}
        {gateway() ? <HostStats stats={props.devices.gatewaySystemInfo} /> : undefined}
      </div>
      <div class="settings-row__control">
        <DesktopControl devices={props.devices} environmentId={desktopEnvironment()} />
        <DeviceEntryMenu
          devices={props.devices}
          entry={{
            name: title(),
            deviceId: entry().deviceId,
            desktopEnvironment: desktopEnvironment(),
          }}
        />
      </div>
    </div>
  );
}

function DesktopControl(props: {
  devices: DevicesProps;
  environmentId: string | undefined;
  commands?: string[];
}) {
  return (
    <Show
      when={props.environmentId}
      fallback={
        props.commands?.includes("desktop.stream") ? (
          <span
            class="device-capability device-capability--disabled"
            aria-disabled="true"
            title={t("devices.inventory.desktopEnableHint")}
          >
            <Icon name="monitor" /> {t("devices.inventory.desktop")}
          </span>
        ) : undefined
      }
    >
      {(environmentId) => {
        // Settings routes suppress the docked Desktop panel, so the row opens the
        // standalone desktop focus window instead of dispatching a panel toggle.
        return (
          <button
            class="btn btn--sm device-entry__desktop"
            title={t("devices.inventory.desktopOpenWindow")}
            onClick={() => openDesktopFocus(props.devices.basePath, environmentId())}
          >
            <Icon name="monitor" /> {t("devices.inventory.desktop")}
          </button>
        );
      }}
    </Show>
  );
}

function TokenRow(props: {
  device: { id: string; name: string };
  tokenSummary: DeviceTokenSummary;
  devices: DevicesProps;
}) {
  const status = createMemo(() =>
    props.tokenSummary.revokedAtMs ? t("devices.inventory.revoked") : t("devices.inventory.active"),
  );
  const scopes = createMemo(() => formatList(props.tokenSummary.scopes));
  const when = createMemo(() =>
    formatRelativeTimestamp(
      props.tokenSummary.rotatedAtMs ??
        props.tokenSummary.createdAtMs ??
        props.tokenSummary.lastUsedAtMs ??
        null,
    ),
  );
  return (
    <tr>
      <td data-label={t("devices.inventory.tokenRole")}>{props.tokenSummary.role}</td>
      <td data-label={t("devices.inventory.tokenStatus")}>{status()}</td>
      <td data-label={t("devices.inventory.scopesLabel")}>{scopes()}</td>
      <td data-label={t("devices.inventory.tokenAge")}>{when()}</td>
      <td data-label={t("devices.inventory.actions")}>
        <div class="device-entry__token-actions">
          <button
            class="btn btn--sm"
            disabled={!props.devices.canManagePairing}
            onClick={() =>
              props.devices.onDeviceRotate(
                props.device,
                props.tokenSummary.role,
                props.tokenSummary.scopes,
              )
            }
          >
            {t("devices.inventory.rotate")}
          </button>
          {props.tokenSummary.revokedAtMs ? undefined : (
            <button
              class="btn btn--sm danger"
              disabled={!props.devices.canManagePairing}
              onClick={() => props.devices.onDeviceRevoke(props.device.id, props.tokenSummary.role)}
            >
              {t("devices.inventory.revoke")}
            </button>
          )}
        </div>
      </td>
    </tr>
  );
}
