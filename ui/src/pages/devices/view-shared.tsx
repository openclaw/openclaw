import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { JSX } from "@solidjs/web";
import { Match, Switch } from "solid-js";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../../../packages/gateway-protocol/src/client-info.js";
import { Icon } from "../../components/solid/icon.tsx";
import { resolveMacFormFactor } from "../../lib/mac-form-factor.ts";
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
  nodes: Array<Record<string, unknown>>,
  requiredCommands: string[],
): NodeTargetOption[] {
  const list: NodeTargetOption[] = [];

  for (const node of nodes) {
    const commands = Array.isArray(node.commands) ? node.commands : [];
    const advertised = new Set(commands.map(String));
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

type DeviceIconSource = {
  clientId?: string;
  clientMode?: string;
  platform?: string;
  modelIdentifier?: string;
};

const WATCH_PLATFORM_PATTERN = /\bwatchos\b/;
const TABLET_PLATFORM_PATTERN = /\b(ipados|ipad)\b/;
const PHONE_PLATFORM_PATTERN = /\b(ios|android|iphone)\b/;
const PHONE_CLIENT_IDS: ReadonlySet<string> = new Set([
  GATEWAY_CLIENT_IDS.IOS_APP,
  GATEWAY_CLIENT_IDS.ANDROID_APP,
]);
const BROWSER_CLIENT_IDS: ReadonlySet<string> = new Set([
  GATEWAY_CLIENT_IDS.CONTROL_UI,
  GATEWAY_CLIENT_IDS.WEBCHAT_UI,
  GATEWAY_CLIENT_IDS.WEBCHAT,
]);
const TERMINAL_CLIENT_MODES: ReadonlySet<string> = new Set([
  GATEWAY_CLIENT_MODES.CLI,
  GATEWAY_CLIENT_MODES.BACKEND,
  GATEWAY_CLIENT_MODES.PROBE,
  GATEWAY_CLIENT_MODES.TEST,
]);
// The TUI connects with mode "ui"; only its client id marks it as a terminal.
const TERMINAL_CLIENT_IDS: ReadonlySet<string> = new Set([
  GATEWAY_CLIENT_IDS.CLI,
  GATEWAY_CLIENT_IDS.TUI,
]);

/** Prefer client identity for browser/terminal sessions, then the machine's form factor. */
export function deviceIcon(source: DeviceIconSource): JSX.Element {
  const platform = source.platform?.trim().toLowerCase() ?? "";
  const model = source.modelIdentifier?.trim() ?? "";
  const clientId = source.clientId?.trim().toLowerCase() ?? "";
  const mode = source.clientMode?.trim().toLowerCase() ?? "";
  // Watch and tablet checks run before the phone check: watchOS/iPadOS
  // platforms would otherwise never match once "ios" is tested.
  if (
    model.startsWith("Watch") ||
    WATCH_PLATFORM_PATTERN.test(platform) ||
    clientId === GATEWAY_CLIENT_IDS.WATCHOS_APP
  ) {
    return <DeviceGlyph kind="watch" />;
  }
  if (model.startsWith("iPad") || TABLET_PLATFORM_PATTERN.test(platform)) {
    return <DeviceGlyph kind="tablet" />;
  }
  if (
    model.startsWith("iPhone") ||
    PHONE_PLATFORM_PATTERN.test(platform) ||
    PHONE_CLIENT_IDS.has(clientId)
  ) {
    return <Icon name="smartphone" />;
  }
  if (BROWSER_CLIENT_IDS.has(clientId) || mode === GATEWAY_CLIENT_MODES.WEBCHAT) {
    return <Icon name="globe" />;
  }
  if (TERMINAL_CLIENT_MODES.has(mode) || TERMINAL_CLIENT_IDS.has(clientId)) {
    return <Icon name="terminal" />;
  }
  if (mode === "gateway") {
    return <Icon name="server" />;
  }
  switch (resolveMacFormFactor(model)) {
    case "laptop":
      return <DeviceGlyph kind="laptop" />;
    case "mini":
      return <DeviceGlyph kind="macMini" />;
    case "studio":
    case "pro":
      return <DeviceGlyph kind="pcCase" />;
    case "imac":
      return <Icon name="monitor" />;
    default:
      return <Icon name="monitor" />;
  }
}

/* Connectivity state lives in the row's renderSettingsStatus dot + text, so
   the tile stays a purely decorative form-factor glyph. */
export function DeviceTile(props: { icon: JSX.Element }) {
  return (
    <div class="device-entry__tile" aria-hidden="true">
      <span class="device-entry__tile-icon">{props.icon}</span>
    </div>
  );
}

export function DeviceIdentityFacts(props: { id: string; remoteIp?: string }) {
  return (
    <>
      <dt class="settings-row__desc">{t("devices.inventory.deviceIdLabel")}</dt>
      <dd class="settings-row__value settings-row__value--mono" title={props.id}>
        {props.id}
      </dd>
      {props.remoteIp ? (
        <>
          <dt class="settings-row__desc">{t("devices.inventory.remoteIpLabel")}</dt>
          <dd class="settings-row__value settings-row__value--mono">{props.remoteIp}</dd>
        </>
      ) : undefined}
    </>
  );
}

function DeviceGlyph(props: { kind: "watch" | "tablet" | "laptop" | "macMini" | "pcCase" }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <Switch>
        <Match when={props.kind === "watch"}>
          <circle cx="12" cy="12" r="6" />
          <polyline points="12 10 12 12 13 13" />
          <path d="m16.13 7.66-.81-4.05a2 2 0 0 0-2-1.61h-2.68a2 2 0 0 0-2 1.61l-.78 4.05" />
          <path d="m7.88 16.36.8 4a2 2 0 0 0 2 1.61h2.72a2 2 0 0 0 2-1.61l.81-4.05" />
        </Match>
        <Match when={props.kind === "tablet"}>
          <rect width="16" height="20" x="4" y="2" rx="2" ry="2" />
          <path d="M12 18h.01" />
        </Match>
        <Match when={props.kind === "laptop"}>
          <path d="M18 5a2 2 0 0 1 2 2v8.526a2 2 0 0 0 .212.897l1.068 2.127a1 1 0 0 1-.9 1.45H3.62a1 1 0 0 1-.9-1.45l1.068-2.127A2 2 0 0 0 4 15.526V7a2 2 0 0 1 2-2z" />
          <path d="M20.054 15.987H3.946" />
        </Match>
        <Match when={props.kind === "pcCase"}>
          <rect width="14" height="20" x="5" y="2" rx="2" />
          <path d="M15 14h.01M9 6h6M9 10h6" />
        </Match>
        <Match when={props.kind === "macMini"}>
          <path d="M2.212 11.577a2 2 0 0 0-.212.896V18a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-5.527a2 2 0 0 0-.212-.896L18.55 5.11A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
          <path d="M21.946 12.013H2.054M6 16h.01M10 16h.01" />
        </Match>
      </Switch>
    </svg>
  );
}
