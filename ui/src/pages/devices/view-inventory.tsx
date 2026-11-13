import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { JSX } from "@solidjs/web";
import { createMemo, For, Show } from "solid-js";
import type { NodeListNode } from "../../../../src/shared/node-list-types.js";
import type { PresenceEntry } from "../../api/types.ts";
import { pathForRoute } from "../../app-route-paths.ts";
import { CopyButton } from "../../components/solid/copy-button.tsx";
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
import { CapabilityList } from "./capability-list.tsx";
import { deviceDesktopEnvironment, DeviceEntryActions } from "./entry-actions.tsx";
import { HostPressure, HostStats } from "./host-stats.tsx";
import { PendingDeviceRows, PendingNode } from "./view-pending.tsx";
import {
  CommandFact,
  DeviceDisclosure,
  DeviceFact,
  DeviceIdentityFacts,
  MetaLine,
} from "./view-shared.tsx";
import type { DevicesProps } from "./view.types.ts";

registerEnglishCatalog(registerDevicesEnglish);

function toRemovalRequest(entry: DeviceInventoryEntry): InventoryRemovalRequest {
  const removal = resolveInventoryRemoval(entry);
  return { id: entry.id, name: entry.name, ...removal };
}

export function DeviceInventoryContent(props: DevicesProps & { pending: boolean }) {
  // Inventory reads replace their snapshots; config and approval drafts publish independently.
  const pending = createMemo(() => props.devicesList?.pending ?? []);
  const pendingNodes = createMemo(() =>
    props.nodes.filter((node) => isPendingNode(node) && node.pendingRequestId),
  );
  const paired = createMemo(() => props.devicesList?.paired ?? []);
  const nodes = createMemo(() => props.nodes);
  const presenceSnapshot = createMemo(() => props.presence);
  const groups = createMemo(() =>
    buildDeviceInventory({ paired: paired(), nodes: nodes(), presence: presenceSnapshot() }),
  );
  const gatewayPresence = createMemo(() => findGatewayPresence(presenceSnapshot()));
  const unpairedPresence = createMemo(() => listUnpairedPresence(presenceSnapshot(), groups()));
  const stale = createMemo(() => listStaleInventoryEntries(groups()));
  // Mutation owners can also start internal reloads after their write settles.
  const loading = () => props.pending || props.loading || props.devicesLoading;
  const actions = (
    <>
      {stale().length > 0 ? (
        <button
          class="btn"
          title={
            props.connected && !props.canManagePairing ? t("devices.readOnly.pairingRequired") : ""
          }
          disabled={props.inventorySaving || !props.connected || !props.canManagePairing}
          onClick={() => props.onInventoryCleanup(stale().map(toRemovalRequest))}
        >
          {t("devices.inventory.cleanupStale", { count: String(stale().length) })}
        </button>
      ) : undefined}
      <button
        class="btn device-entry__pair"
        title={props.connected && !props.canPairDevice ? t("devices.pairing.adminRequired") : ""}
        disabled={!props.connected || !props.canPairDevice}
        onClick={() => props.onDevicePairSetupOpen()}
      >
        <Icon name="plus" /> {t("devices.pairing.button")}
      </button>
    </>
  );
  // Created once, so rows and their open state outlive a loading skeleton.
  const groupedRows = (
    <For each={groups()} keyed={(group) => group.key}>
      {(group) => <InventoryGroup group={group()} devices={props} />}
    </For>
  );
  const deviceRows = (
    <>
      <Show when={gatewayPresence()}>
        {(presence) => <GatewayEntry entry={presence()} devices={props} />}
      </Show>
      {loading() && groups().length === 0 ? (
        <SettingsLoadingSkeleton />
      ) : groups().length === 0 && (props.connected || props.devicesList) ? (
        <SettingsEmpty message={t("devices.inventory.empty")} />
      ) : (
        groupedRows
      )}
    </>
  );
  return (
    <>
      {pending().length + pendingNodes().length > 0 ? (
        <SettingsSection
          title={t("devices.inventory.pendingApproval")}
          count={pending().length + pendingNodes().length}
        >
          <PendingDeviceRows {...props} />
          <For each={pendingNodes()} keyed={(node) => node.pendingRequestId}>
            {(node) => <PendingNode node={node()} devices={props} />}
          </For>
        </SettingsSection>
      ) : undefined}
      <SettingsSection title={t("devices.inventory.title")} actions={actions}>
        {deviceRows}
      </SettingsSection>
      {unpairedPresence().length > 0 ? (
        <SettingsSection title={t("devices.inventory.connectedWithoutPairing")}>
          <For
            each={unpairedPresence()}
            keyed={(entry) => entry.instanceId ?? entry.deviceId ?? entry.host}
          >
            {(entry) => <UnpairedEntry entry={entry()} />}
          </For>
        </SettingsSection>
      ) : undefined}
    </>
  );
}

function InventoryGroup(props: { group: DeviceInventoryGroup; devices: DevicesProps }) {
  return (
    <InventoryEntry entry={props.group.primary} devices={props.devices}>
      <Show when={props.group.duplicates.length > 0}>
        <div class="device-group__dups">
          <p class="settings-row__desc">
            {t(
              props.group.duplicates.length === 1
                ? "devices.inventory.olderPairing"
                : "devices.inventory.olderPairings",
              { count: String(props.group.duplicates.length), name: props.group.name },
            )}
          </p>
          <For each={props.group.duplicates} keyed={(entry) => entry.id}>
            {(entry) => <InventoryEntry entry={entry()} devices={props.devices} />}
          </For>
        </div>
      </Show>
    </InventoryEntry>
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

function isPendingNode(node: NodeListNode | undefined): boolean {
  return node?.approvalState === "pending-approval" || node?.approvalState === "pending-reapproval";
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

type EntryWarning = {
  kind: "version" | "worker" | "wake" | "approval";
  label: string;
  detail?: string;
};

function entryWarnings(entry: DeviceInventoryEntry, gatewayVersion: string | null): EntryWarning[] {
  const warnings: EntryWarning[] = [];
  const isApprovedNode = isApprovedNodeEntry(entry);
  const nodeVersion = resolveNodeCoreVersion(entry);
  if (isApprovedNode && nodeVersion && gatewayVersion && nodeVersion !== gatewayVersion) {
    warnings.push({
      kind: "version",
      label: t("devices.inventory.versionDrift"),
      detail: t("devices.inventory.versionDriftTitle", { nodeVersion, gatewayVersion }),
    });
  }
  if (entry.node?.workerBundle?.status === "missing") {
    warnings.push({
      kind: "worker",
      label: t("devices.inventory.workerMissing"),
      detail: t("devices.inventory.workerMissingTitle"),
    });
  }
  if (isApprovedNode && entry.node?.connected === false && isWindowsPlatform(entry.platform)) {
    warnings.push({
      kind: "wake",
      label: t("devices.inventory.manualWake"),
      detail: t("devices.inventory.manualWakeTitle"),
    });
  }
  if (isPendingNode(entry.node)) {
    warnings.push({ kind: "approval", label: t("devices.inventory.approvalNeeded") });
  }
  return warnings;
}

function identityParts(
  entry: Pick<PresenceEntry, "platform" | "deviceFamily" | "modelIdentifier">,
  name: string,
): string[] {
  const parts: string[] = [];
  if (entry.platform) {
    parts.push(prettifyPlatform(entry.platform, entry.deviceFamily));
  }
  const family = entry.modelIdentifier ? macFamilyLabel(entry.modelIdentifier) : undefined;
  if (family && family !== name) {
    parts.push(family);
  }
  return parts;
}

/** The closed row names the machine and, once it is gone, when it was last around. */
function entryMeta(entry: DeviceInventoryEntry, connected: boolean): string[] {
  const parts = identityParts(entry, entry.name);
  if (!connected && entry.lastSeenAtMs) {
    parts.push(t("devices.inventory.seen", { time: formatRelativeTimestamp(entry.lastSeenAtMs) }));
  } else if (!connected && entry.approvedAtMs) {
    parts.push(
      t("devices.inventory.approved", { time: formatRelativeTimestamp(entry.approvedAtMs) }),
    );
  }
  return parts;
}

function formatInputRecency(lastInputSeconds: number): string {
  return t("devices.inventory.inputAgo", {
    time: formatTimeAgo(lastInputSeconds * 1000, { suffix: false }),
  });
}

function InventoryEntry(props: {
  entry: DeviceInventoryEntry;
  devices: DevicesProps;
  children?: JSX.Element;
}) {
  const capacity = createMemo(() =>
    workerCapacityPresentation({
      workerSlots: props.entry.node?.workerSlots,
      capabilities: props.entry.node?.caps,
      commands: props.entry.node?.commands,
      unavailable: props.entry.node?.connected !== true || !isApprovedNodeEntry(props.entry),
    }),
  );
  const desktopEnvironment = createMemo(() =>
    deviceDesktopEnvironment(props.devices, `node:${props.entry.id}`),
  );
  const rowConnected = () => props.entry.node?.connected ?? props.entry.connected;
  // OpenClaw ID membership owns these browsers; the Access page removes them.
  const managedByOpenClawId = () => props.entry.device?.managedBy === "openclaw-id";
  const warnings = createMemo(() => entryWarnings(props.entry, props.devices.gatewayVersion));
  const tokens = createMemo(() => props.entry.device?.tokens ?? []);
  const tokenRoles = createMemo(() => new Set(tokens().map((token) => token.role)));
  const tokenScopes = createMemo(() => new Set(tokens().flatMap((token) => token.scopes ?? [])));
  // Tokens already carry their role and scopes; the rest only appears when a token does not.
  const showRoles = () => props.entry.roles.some((role) => !tokenRoles().has(role));
  const showScopes = () => props.entry.scopes.some((scope) => !tokenScopes().has(scope));
  const desktopUnavailable = () =>
    !desktopEnvironment() && props.entry.node?.commands?.includes("desktop.stream");
  const liveStats = () => (rowConnected() ? props.entry.node?.hostStats : undefined);
  const hasAlerts = () =>
    warnings().length > 0 || (liveStats() !== undefined && liveStats() !== null);
  return (
    <DeviceDisclosure
      deviceId={props.entry.id}
      name={props.entry.name}
      meta={entryMeta(props.entry, rowConnected())}
      status={
        <SettingsStatus
          kind={rowConnected() ? "ok" : "muted"}
          label={t(rowConnected() ? "devices.inventory.connected" : "devices.inventory.offline")}
        />
      }
      alerts={
        <Show when={hasAlerts()}>
          <span class="device-entry__alerts">
            <For each={warnings()} keyed={(warning) => warning.kind}>
              {(warning) => (
                <span title={warning().detail}>
                  <SettingsStatus kind={"warn"} label={warning().label} />
                </span>
              )}
            </For>
            <HostPressure stats={liveStats()} />
          </span>
        </Show>
      }
    >
      <DeviceEntryActions
        devices={props.devices}
        desktopEnvironment={desktopEnvironment()}
        onEditAlias={
          props.entry.device
            ? () =>
                props.devices.onDeviceRename({
                  id: props.entry.id,
                  name: props.entry.name,
                  operatorLabel: props.entry.device?.operatorLabel,
                })
            : undefined
        }
        onRemove={
          managedByOpenClawId()
            ? undefined
            : () => props.devices.onInventoryRemove(toRemovalRequest(props.entry))
        }
      />
      <dl class="device-entry__facts">
        <Show when={managedByOpenClawId()}>
          <DeviceFact label={t("devices.inventory.openclawIdLabel")}>
            {t("devices.inventory.openclawIdManaged")}{" "}
            <a
              href={`${pathForRoute("plugin", props.devices.basePath)}?${new URLSearchParams({ plugin: "openclaw-id-access", id: "access" })}`}
            >
              {t("devices.inventory.openclawIdOpen")}
            </a>
          </DeviceFact>
        </Show>
        <For
          each={warnings().filter((warning) => warning.detail)}
          keyed={(warning) => warning.kind}
        >
          {(warning) => <DeviceFact label={warning().label}>{warning().detail}</DeviceFact>}
        </For>
        <Show when={desktopUnavailable()}>
          <DeviceFact label={t("devices.inventory.desktop")}>
            {t("devices.inventory.desktopEnableHint")}
          </DeviceFact>
        </Show>
        <HostStats
          stats={props.entry.node?.hostStats}
          lastKnownAtMs={!rowConnected() ? props.entry.node?.hostStats?.updatedAtMs : undefined}
        />
        <Show when={capacity()}>
          {(current) => (
            <DeviceFact label={t("devices.inventory.capacity")}>
              <span class="device-meter">
                <Show when={props.entry.node?.workerSlots}>
                  <span>{current().label}</span>
                </Show>
                {current().meter}
              </span>
            </DeviceFact>
          )}
        </Show>
        <Show when={tokens().length > 0}>
          <DeviceFact label={t("devices.inventory.tokens")} class="device-fact--wide">
            <div class="device-tokens">
              <For each={tokens()} keyed={(token) => token.role}>
                {(token) => (
                  <TokenRow
                    device={{ id: props.entry.id, name: props.entry.name }}
                    tokenSummary={token()}
                    devices={props.devices}
                    revocable={!managedByOpenClawId()}
                  />
                )}
              </For>
            </div>
          </DeviceFact>
        </Show>
        <Show when={showRoles()}>
          <DeviceFact label={t("devices.inventory.rolesLabel")}>
            <details>
              <summary>{t("devices.inventory.showDetails")}</summary>
              {formatList(props.entry.roles)}
            </details>
          </DeviceFact>
        </Show>
        <Show when={showScopes()}>
          <DeviceFact label={t("devices.inventory.scopesLabel")}>
            <details>
              <summary>{t("devices.inventory.showDetails")}</summary>
              {formatList(props.entry.scopes)}
            </details>
          </DeviceFact>
        </Show>
        <Show when={(props.entry.node?.caps ?? []).length > 0}>
          <DeviceFact label={t("devices.inventory.capabilities")}>
            <CapabilityList caps={props.entry.node?.caps ?? []} />
          </DeviceFact>
        </Show>
        <CommandFact values={props.entry.node?.commands ?? []} />
        <VersionFacts
          modelIdentifier={props.entry.modelIdentifier}
          version={props.entry.version}
          workerVersion={
            props.entry.node?.workerBundle?.status === "installed"
              ? props.entry.node.workerBundle.version
              : undefined
          }
        />
        <Show when={rowConnected() && props.entry.presence?.lastInputSeconds != null}>
          <DeviceFact label={t("devices.inventory.lastInputLabel")}>
            {formatTimeAgo((props.entry.presence?.lastInputSeconds ?? 0) * 1000)}
          </DeviceFact>
        </Show>
        <Show when={props.entry.approvedAtMs || props.entry.autoApproved}>
          <DeviceFact label={t("devices.inventory.approvedLabel")}>
            <MetaLine
              plain
              parts={[
                ...(props.entry.approvedAtMs
                  ? [formatRelativeTimestamp(props.entry.approvedAtMs)]
                  : []),
                ...(props.entry.autoApproved ? [t("devices.inventory.autoPaired")] : []),
              ]}
            />
          </DeviceFact>
        </Show>
        <DeviceIdentityFacts id={props.entry.id} remoteIp={props.entry.remoteIp} />
      </dl>
      {props.children}
    </DeviceDisclosure>
  );
}

function VersionFacts(props: {
  modelIdentifier?: string | null;
  version?: string | null;
  workerVersion?: string;
}) {
  const versions = () => [
    ...(props.version ? [props.version] : []),
    ...(props.workerVersion
      ? [t("devices.inventory.workerVersion", { version: props.workerVersion })]
      : []),
  ];
  return (
    <>
      <Show when={props.modelIdentifier}>
        <DeviceFact label={t("devices.inventory.modelLabel")}>{props.modelIdentifier}</DeviceFact>
      </Show>
      <Show when={versions().length > 0}>
        <DeviceFact label={t("devices.inventory.versionLabel")}>
          <MetaLine plain parts={versions()} />
        </DeviceFact>
      </Show>
    </>
  );
}

function GatewayEntry(props: { entry: PresenceEntry; devices: DevicesProps }) {
  const name = () => props.entry.host ?? t("devices.execApprovals.gateway");
  const meta = createMemo(() => {
    const info = props.devices.gatewaySystemInfo;
    return [
      t("devices.inventory.gateway"),
      ...identityParts(props.entry, name()),
      ...(info
        ? [
            t("devices.inventory.uptime", {
              time: formatDurationCompact(info.uptimeMs) ?? "",
            }),
          ]
        : []),
    ];
  });
  return (
    <DeviceDisclosure
      name={name()}
      meta={meta()}
      status={<SettingsStatus kind={"ok"} label={t("devices.inventory.connected")} />}
      alerts={
        <Show when={props.devices.gatewaySystemInfo}>
          {(info) => <PressureLine stats={info()} />}
        </Show>
      }
    >
      <DeviceEntryActions
        devices={props.devices}
        desktopEnvironment={deviceDesktopEnvironment(props.devices, "gateway")}
      />
      <dl class="device-entry__facts">
        <HostStats stats={props.devices.gatewaySystemInfo} />
        <VersionFacts modelIdentifier={props.entry.modelIdentifier} version={props.entry.version} />
        <Show when={props.entry.lastInputSeconds != null}>
          <DeviceFact label={t("devices.inventory.lastInputLabel")}>
            {formatTimeAgo((props.entry.lastInputSeconds ?? 0) * 1000)}
          </DeviceFact>
        </Show>
        <Show when={props.entry.deviceId}>
          {(deviceId) => <DeviceIdentityFacts id={deviceId()} />}
        </Show>
      </dl>
    </DeviceDisclosure>
  );
}

function PressureLine(props: { stats: Parameters<typeof HostPressure>[0]["stats"] }) {
  return (
    <span class="device-entry__alerts">
      <HostPressure stats={props.stats} />
    </span>
  );
}

/** A live connection with no pairing to manage: there is nothing further to open. */
function UnpairedEntry(props: { entry: PresenceEntry }) {
  const title = () => props.entry.host ?? props.entry.mode ?? t("devices.inventory.unknownClient");
  const parts = createMemo(() => {
    const current = props.entry;
    const result: string[] = [];
    if (current.platform) {
      result.push(prettifyPlatform(current.platform, current.deviceFamily));
    }
    if (current.modelIdentifier) {
      const family = macFamilyLabel(current.modelIdentifier);
      if (family) {
        result.push(family);
      }
      result.push(current.modelIdentifier);
    }
    if (current.version) {
      result.push(current.version);
    }
    if (current.lastInputSeconds != null) {
      result.push(formatInputRecency(current.lastInputSeconds));
    }
    if (Array.isArray(current.roles)) {
      result.push(...current.roles.filter(Boolean));
    }
    return result;
  });
  return (
    <div class="settings-row device-entry">
      <div class="settings-row__text">
        <span class="settings-row__title">{title()}</span>
        <MetaLine parts={parts()} />
      </div>
      <Show when={props.entry.deviceId}>
        {(deviceId) => (
          <div class="settings-row__control">
            <CopyButton
              text={deviceId()}
              idleLabel={t("devices.inventory.copyDeviceId")}
              iconFeedback
            />
          </div>
        )}
      </Show>
    </div>
  );
}

function TokenRow(props: {
  device: { id: string; name: string };
  tokenSummary: DeviceTokenSummary;
  devices: DevicesProps;
  revocable: boolean;
}) {
  const disabled = () =>
    props.devices.inventorySaving || !props.devices.connected || !props.devices.canManagePairing;
  const detail = createMemo(() => {
    const when = formatRelativeTimestamp(
      props.tokenSummary.rotatedAtMs ??
        props.tokenSummary.createdAtMs ??
        props.tokenSummary.lastUsedAtMs ??
        null,
    );
    return [props.tokenSummary.revokedAtMs ? t("devices.inventory.revoked") : "", when].filter(
      Boolean,
    );
  });
  return (
    <div class="device-token">
      <div class="device-token__text">
        <span class="device-token__role">
          {t(
            props.tokenSummary.role === "node"
              ? "devices.inventory.deviceToken"
              : props.tokenSummary.role === "operator"
                ? "devices.inventory.accessToken"
                : "devices.inventory.token",
          )}
        </span>
        <MetaLine parts={detail()} />
        <details>
          <summary>{t("devices.inventory.showDetails")}</summary>
          <MetaLine
            parts={[props.tokenSummary.role, formatList(props.tokenSummary.scopes ?? [])]}
          />
        </details>
      </div>
      <div class="device-token__actions">
        <button
          class="btn btn--sm"
          disabled={disabled()}
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
        {props.tokenSummary.revokedAtMs || !props.revocable ? undefined : (
          <button
            class="btn btn--sm danger"
            disabled={disabled()}
            onClick={() => props.devices.onDeviceRevoke(props.device.id, props.tokenSummary.role)}
          >
            {t("devices.inventory.revoke")}
          </button>
        )}
      </div>
    </div>
  );
}
