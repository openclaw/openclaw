import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { JSX } from "@solidjs/web";
import { For, Show } from "solid-js";
import type { NodeListNode } from "../../../../src/shared/node-list-types.js";
import { CopyButton } from "../../components/solid/copy-button.tsx";
import { Icon } from "../../components/solid/icon.tsx";
import { SettingsStatus } from "../../components/solid/settings-ui.tsx";
import { formatList } from "../../lib/format.ts";
import { t } from "../../lib/reactive/i18n.ts";

type NodeTargetOption = {
  id: string;
  label: string;
};

type ConfigAgentOption = {
  id: string;
  name?: string;
  isDefault: boolean;
  record: Record<string, unknown>;
};

export function resolveConfigAgents(config: Record<string, unknown> | null): ConfigAgentOption[] {
  const agentsNode = isRecord(config?.agents) ? config.agents : null;
  const entries = isRecord(agentsNode?.entries) ? agentsNode.entries : {};
  const defaults = isRecord(agentsNode?.defaults) ? agentsNode.defaults : null;
  const systemAgent = isRecord(defaults?.systemAgent) ? defaults.systemAgent : null;
  const ownerId = normalizeOptionalString(systemAgent?.agentId);
  const soleAgentId = Object.keys(entries).length === 1 ? Object.keys(entries)[0] : undefined;
  const agents: ConfigAgentOption[] = [];

  for (const [id, entry] of Object.entries(entries)) {
    if (!isRecord(entry)) {
      continue;
    }
    const name = normalizeOptionalString(entry.name);
    const isDefault = id === (ownerId ?? soleAgentId);
    agents.push({ id, name, isDefault, record: entry });
  }

  return agents;
}

export function resolveNodeTargets(
  nodes: readonly NodeListNode[],
  requiredCommands: string[],
): NodeTargetOption[] {
  const list: NodeTargetOption[] = [];

  for (const node of nodes) {
    const advertised = new Set(node.commands ?? []);
    const supports = requiredCommands.every((command) => advertised.has(command));
    if (!supports) {
      continue;
    }

    const nodeId = normalizeOptionalString(node.nodeId) ?? "";
    if (!nodeId) {
      continue;
    }
    const displayName = normalizeOptionalString(node.displayName) ?? nodeId;
    list.push({
      id: nodeId,
      label: displayName === nodeId ? nodeId : `${displayName} · ${nodeId}`,
    });
  }

  list.sort((a, b) => a.label.localeCompare(b.label));
  return list;
}

/** One label and value in a device's facts; the wrapper keeps both on the shared grid. */
export function DeviceFact(props: {
  label: string;
  children: JSX.Element;
  class?: string | string[];
  title?: string;
  valueTitle?: string;
  mono?: boolean;
}) {
  return (
    <div
      class={["device-fact", props.class, { "device-fact--mono": props.mono }]}
      title={props.title}
    >
      <dt>{props.label}</dt>
      <dd title={props.valueTitle}>{props.children}</dd>
    </div>
  );
}

export function DeviceIdentityFacts(props: { id: string; remoteIp?: string }) {
  return (
    <>
      <DeviceFact label={t("devices.inventory.deviceIdLabel")} valueTitle={props.id}>
        <span class="device-fact__id">
          <span>{props.id}</span>
          <CopyButton
            text={props.id}
            idleLabel={t("devices.inventory.copyDeviceId")}
            iconFeedback
          />
        </span>
      </DeviceFact>
      <Show when={props.remoteIp}>
        <DeviceFact label={t("devices.inventory.remoteIpLabel")} mono>
          {props.remoteIp}
        </DeviceFact>
      </Show>
    </>
  );
}

// Node-controlled lists are unbounded input; cap the rendered items so a
// hostile or chatty node cannot bloat the inventory render.
const COMMAND_LINE_LIMIT = 16;

export function CommandFact(props: { values: readonly string[] }) {
  const visible = () => props.values.slice(0, COMMAND_LINE_LIMIT);
  const overflow = () => props.values.length - visible().length;
  return (
    <Show when={props.values.length > 0}>
      <DeviceFact label={t("devices.inventory.commands")} mono>
        {formatList(visible())}
        {overflow() > 0 ? ` +${overflow()}` : ""}
      </DeviceFact>
    </Show>
  );
}

/** Parts wrap whole; the stylesheet draws the separators, so none can end a line. */
export function MetaLine(props: { parts: readonly string[]; plain?: boolean }) {
  return (
    <Show when={props.parts.length > 0}>
      <span class={["device-entry__meta", { "settings-row__desc": !props.plain }]}>
        <For each={props.parts}>
          {(part) => (
            <>
              <span class="device-entry__part">{part}</span>{" "}
            </>
          )}
        </For>
      </span>
    </Show>
  );
}

/** One expandable row: what it is at a glance, everything else on demand. */
export function DeviceDisclosure(props: {
  deviceId?: string;
  name: string;
  meta: readonly string[];
  alerts?: JSX.Element;
  status?: JSX.Element;
  children: JSX.Element;
}) {
  return (
    <details class="device-entry" data-device-id={props.deviceId}>
      <summary class="settings-row settings-row--nav device-entry__summary">
        <span class="settings-row__text">
          <span class="settings-row__title">{props.name}</span>
          <span class="device-entry__line">
            <MetaLine parts={props.meta} />
            {props.alerts}
          </span>
        </span>
        <span class="settings-row__control">
          <Show when={props.status}>
            <span class="device-entry__status">{props.status}</span>
          </Show>
          <span class="settings-row__chevron">
            <Icon name="chevronDown" />
          </span>
        </span>
      </summary>
      <div class="device-entry__body">{props.children}</div>
    </details>
  );
}

/** A note and its action share one line at every width. */
export function PolicyActionRow(props: {
  class?: string;
  title?: JSX.Element;
  description?: JSX.Element;
  children?: JSX.Element;
}) {
  return (
    <div class={["settings-row", "device-policy__action", props.class]}>
      <div class="settings-row__text">
        <Show when={props.title}>
          <span class="settings-row__title">{props.title}</span>
        </Show>
        <Show when={props.description}>
          <span class="settings-row__desc">{props.description}</span>
        </Show>
      </div>
      <Show when={props.children}>
        <div class="settings-row__control">{props.children}</div>
      </Show>
    </div>
  );
}

export function PolicyFailure(props: {
  title: string;
  message: string;
  busy?: boolean;
  onRetry: () => void;
}) {
  return (
    <PolicyActionRow
      title={
        <span role="alert">
          <SettingsStatus kind="danger" label={props.title} />
        </span>
      }
      description={props.message}
    >
      <button class="btn" disabled={props.busy} onClick={() => props.onRetry()}>
        {t("common.retry")}
      </button>
    </PolicyActionRow>
  );
}

/** The id only says something when it differs from the name. */
export function agentDisplayName(agent: { id: string; name?: string }): string {
  const name = agent.name?.trim();
  if (!name) {
    return agent.id;
  }
  return name.toLowerCase() === agent.id.toLowerCase() ? name : `${name} (${agent.id})`;
}
