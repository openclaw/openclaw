// Curated answers above the schema-backed approval forwarding and policy editors.
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import type { JSX } from "@solidjs/web";
import { createSignal } from "solid-js";
import type { ApplicationContext } from "../../app/context.ts";
import type { ConfigFormProps } from "../../components/config-form.shared.ts";
import { SettingsSelect } from "../../components/solid/settings-select.tsx";
import {
  SettingsNavRow,
  SettingsPage,
  SettingsRow,
  SettingsSection,
  SettingsStatus,
  SettingsToggleRow,
  SettingsValue,
} from "../../components/solid/settings-ui.tsx";
import { registerPreferencesEnglish } from "../../i18n/locales/en-preferences.ts";
import { PROFILE_OPTIONS } from "../../lib/agents/tool-catalog.ts";
import { useGatewayPage } from "../../lib/reactive/gateway-page.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import {
  extractQuickSettingsSecurity,
  type ExecApprovalDefaults,
  type GatewayNetworkAccess,
} from "./security-model.ts";

registerEnglishCatalog(registerPreferencesEnglish);

export type SecurityViewProps = {
  security: ReturnType<typeof extractQuickSettingsSecurity>;
  configBusy: boolean;
  onOpenGatewaySettings?: () => void;
  onOpenDevices?: () => void;
  onBrowserEnabledToggle?: (enabled: boolean) => void;
  /** An empty profile clears the setting, returning to the Gateway default. */
  onToolProfileChange?: (profile: string) => void;
  onOpenApprovals?: () => void;
  /** Embedded schema editor; it owns autosave status and the restart banner. */
  buildEditor: (curatedSections: ConfigFormProps["curatedSections"]) => JSX.Element;
};

const GATEWAY_AUTH_VALUES = ["none", "token", "password", "trusted-proxy", "unknown"];
const EXEC_POLICY_VALUES = ["deny", "allowlist", "ask", "auto", "full", "unknown"];

/** A hand-edited config can hold any string, so an unrecognized value shows as written. */
function knownValueLabel(values: readonly string[], group: string, value: string) {
  return values.includes(value) ? t(`quickSettings.security.${group}.${value}`) : value;
}

/** Hosts can be any length, so they read under the title and the value stays one short word. */
function networkAccessDetail(access: GatewayNetworkAccess) {
  switch (access.kind) {
    case "unknown":
      return undefined;
    case "custom":
      return t("quickSettings.security.networkAccessDetail.configuredHost", { host: access.host });
    case "via":
      return t("quickSettings.security.networkAccessDetail.via", { host: access.host });
    default:
      return t("quickSettings.security.networkAccessDetail.configured");
  }
}

/** Config can raise a concern but can't vouch for the running Gateway, so nothing here reassures. */
function networkAccessWarns(access: GatewayNetworkAccess, gatewayAuth: string) {
  if (access.kind === "funnel") {
    return true;
  }
  return (
    gatewayAuth === "none" &&
    access.kind !== "unknown" &&
    access.kind !== "default" &&
    access.kind !== "loopback"
  );
}

function GatewayAccessSection(props: SecurityViewProps) {
  const gatewayAuthLabel = () =>
    knownValueLabel(GATEWAY_AUTH_VALUES, "gatewayAuthValue", props.security.gatewayAuth);
  const networkAccessLabel = () =>
    t(`quickSettings.security.networkAccessValue.${props.security.networkAccess.kind}`);
  return (
    <SettingsSection title={t("quickSettings.security.accessTitle")}>
      <SettingsNavRow
        title={t("quickSettings.security.gatewayAuth")}
        control={
          // The reported mode can miss a startup --auth, so it can raise a concern but not reassure.
          props.security.gatewayAuth === "none" ? (
            <SettingsStatus kind="warn" label={gatewayAuthLabel()} />
          ) : (
            <SettingsValue value={gatewayAuthLabel()} />
          )
        }
        onClick={() => props.onOpenGatewaySettings?.()}
      />
      <SettingsNavRow
        title={t("quickSettings.security.networkAccess")}
        description={networkAccessDetail(props.security.networkAccess)}
        control={
          networkAccessWarns(props.security.networkAccess, props.security.gatewayAuth) ? (
            <SettingsStatus kind="warn" label={networkAccessLabel()} />
          ) : (
            <SettingsValue value={networkAccessLabel()} />
          )
        }
        onClick={() => props.onOpenGatewaySettings?.()}
      />
      <SettingsNavRow
        title={t("tabs.devices")}
        description={t("quickSettings.security.devicesDescription")}
        onClick={() => props.onOpenDevices?.()}
      />
    </SettingsSection>
  );
}

function AgentCapabilitiesSection(props: SecurityViewProps) {
  const profile = () => props.security.toolProfile;
  const isKnownProfile = () => PROFILE_OPTIONS.some((option) => option.id === profile());
  const profileOptions = () => [
    { value: "", label: t("quickSettings.security.toolProfileUnset") },
    ...PROFILE_OPTIONS.map((item) => ({ value: item.id, label: t(item.labelKey) })),
    ...(profile() && !isKnownProfile() ? [{ value: profile(), label: profile() }] : []),
  ];
  const profileDescription = () =>
    t(
      `quickSettings.security.toolProfileDescription.${
        profile() === "" ? "default" : isKnownProfile() ? profile() : "custom"
      }`,
    );
  const execPolicy = () => props.security.execPolicy;
  return (
    <SettingsSection title={t("quickSettings.security.agentsTitle")}>
      <SettingsNavRow
        title={t("quickSettings.security.execPolicy")}
        description={
          EXEC_POLICY_VALUES.includes(execPolicy()) && execPolicy() !== "unknown"
            ? t(`quickSettings.security.execPolicyDescription.${execPolicy()}`)
            : undefined
        }
        control={
          <SettingsValue
            value={knownValueLabel(EXEC_POLICY_VALUES, "execPolicyValue", execPolicy())}
          />
        }
        onClick={() => props.onOpenDevices?.()}
      />
      <SettingsRow
        title={t("quickSettings.security.toolProfile")}
        description={profileDescription()}
        stackedOnNarrow
        control={
          <SettingsSelect
            aria-label={t("quickSettings.security.toolProfile")}
            value={profile()}
            options={profileOptions()}
            disabled={props.configBusy}
            onChange={(event) => props.onToolProfileChange?.(event.currentTarget.value)}
          />
        }
      />
      <SettingsToggleRow
        title={t("quickSettings.security.browserEnabled")}
        checked={props.security.browserEnabled}
        disabled={props.configBusy}
        onChange={(enabled) => props.onBrowserEnabledToggle?.(enabled)}
      />
      <SettingsNavRow
        title={t("tabs.approvals")}
        description={t("quickSettings.security.approvalsDescription")}
        onClick={() => props.onOpenApprovals?.()}
      />
    </SettingsSection>
  );
}

const SWITCHED_GROUPS = new Set(["approvals.exec", "approvals.plugin", "security.installPolicy"]);

/** Whether a group is in force is what someone checks here; the rest waits until it is opened. */
function summarizeSwitchedGroup(path: Array<string | number>, value: unknown) {
  if (!SWITCHED_GROUPS.has(path.join("."))) {
    return null;
  }
  return (
    <SettingsValue
      value={t(asNullableRecord(value)?.enabled === true ? "common.enabled" : "common.disabled")}
    />
  );
}

export function Security(props: SecurityViewProps) {
  return (
    <section class="security-page">
      <SettingsPage>
        <GatewayAccessSection {...props} />
        <AgentCapabilitiesSection {...props} />
      </SettingsPage>
      {props.buildEditor({
        approvals: {
          label: t("quickSettings.security.forwardingTitle"),
          summarizeObject: summarizeSwitchedGroup,
        },
        security: {
          label: t("quickSettings.security.policiesTitle"),
          summarizeObject: summarizeSwitchedGroup,
        },
      })}
    </section>
  );
}

function gatewayUrlHost(gatewayUrl: string | undefined): string | null {
  try {
    return gatewayUrl ? new URL(gatewayUrl).hostname : null;
  } catch {
    return null;
  }
}

export function SecurityPage(props: {
  context: ApplicationContext;
  configBusy: boolean;
  configObject: Record<string, unknown>;
  configLoaded?: boolean;
  gatewayUrl?: string;
  buildEditor: SecurityViewProps["buildEditor"];
}) {
  const [execApprovalDefaults, setExecApprovalDefaults] = createSignal<ExecApprovalDefaults | null>(
    null,
    { ownedWrite: true },
  );
  let requestedClient: unknown = null;
  // Host approvals bound the requested exec policy; the row tightens once they are known.
  useGatewayPage({
    getGateway: () => props.context.gateway,
    onSnapshot: ({ snapshot }) => {
      const client = snapshot.phase === "connected" ? snapshot.client : null;
      if (client === requestedClient) {
        return;
      }
      requestedClient = client;
      void client
        ?.request<{ resolvedDefaults?: ExecApprovalDefaults }>("exec.approvals.get", {})
        .then((result) => {
          if (requestedClient === client) {
            setExecApprovalDefaults(result.resolvedDefaults ?? null);
          }
        })
        .catch(() => undefined);
    },
  });
  return (
    <Security
      security={extractQuickSettingsSecurity(props.configObject, {
        configLoaded: props.configLoaded,
        authMode: props.context.gateway.snapshot.hello?.snapshot?.authMode,
        connectedHost: gatewayUrlHost(props.gatewayUrl),
        execApprovalDefaults: execApprovalDefaults(),
      })}
      configBusy={props.configBusy}
      onOpenGatewaySettings={() => props.context.navigate("infrastructure")}
      onOpenDevices={() => props.context.navigate("devices")}
      onOpenApprovals={() => props.context.navigate("approvals")}
      onBrowserEnabledToggle={(enabled) =>
        enabled
          ? props.context.runtimeConfig.removeFormValue(["browser", "enabled"])
          : props.context.runtimeConfig.patchForm(["browser", "enabled"], false)
      }
      onToolProfileChange={(profile) =>
        profile
          ? props.context.runtimeConfig.patchForm(["tools", "profile"], profile)
          : props.context.runtimeConfig.removeFormValue(["tools", "profile"])
      }
      buildEditor={props.buildEditor}
    />
  );
}
