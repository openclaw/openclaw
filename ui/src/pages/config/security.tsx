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
import type { GatewayConnectionScope } from "../../lib/gateway-connection-lifecycle.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
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
    case "reportedTailnet":
    case "reportedHost":
      return t("quickSettings.security.networkAccessDetail.listening", { host: access.host });
    case "reportedLoopback":
    case "reportedAllInterfaces":
      return undefined;
    case "reportedServe":
    case "reportedFunnel":
      return t(`quickSettings.security.networkAccessDetail.${access.kind}`);
    default:
      return t("quickSettings.security.networkAccessDetail.configured");
  }
}

/** Config can raise a concern but can't vouch for the running Gateway; only a report reassures. */
function networkAccessStatus(access: GatewayNetworkAccess, gatewayAuth: string) {
  if (access.kind === "funnel" || access.kind === "reportedFunnel") {
    return "warn";
  }
  if (access.kind === "reportedLoopback") {
    return "ok";
  }
  if (access.kind === "unknown" || access.kind === "default" || access.kind === "loopback") {
    return null;
  }
  if (gatewayAuth === "none") {
    return "warn";
  }
  return access.kind === "reportedServe" || access.kind === "reportedTailnet" ? "ok" : null;
}

function GatewayAccessSection(props: SecurityViewProps) {
  const gatewayAuthLabel = () =>
    knownValueLabel(GATEWAY_AUTH_VALUES, "gatewayAuthValue", props.security.gatewayAuth);
  const networkAccessLabel = () =>
    props.security.tailscaleExposure?.status === "preserved"
      ? t("quickSettings.security.tailscaleExposure.externalFunnel")
      : t(`quickSettings.security.networkAccessValue.${props.security.networkAccess.kind}`);
  const networkStatus = () =>
    props.security.tailscaleExposure &&
    ["failed", "recovering", "preserved"].includes(props.security.tailscaleExposure.status)
      ? "warn"
      : networkAccessStatus(props.security.networkAccess, props.security.gatewayAuth);
  const exposureDetail = () => {
    const exposure = props.security.tailscaleExposure;
    if (!exposure || exposure.requestedMode === exposure.activeMode) {
      return networkAccessDetail(props.security.networkAccess);
    }
    if (exposure.status === "preserved" && exposure.reason) {
      return exposure.reason;
    }
    const summary = t("quickSettings.security.tailscaleExposure.inactive");
    return exposure.reason ? `${summary} ${exposure.reason}` : summary;
  };
  return (
    <SettingsSection title={t("quickSettings.security.accessTitle")}>
      <SettingsNavRow
        title={t("quickSettings.security.gatewayAuth")}
        control={
          // Older Gateways' reported mode can miss a startup --auth, so only a real report reassures.
          props.security.gatewayAuth === "none" ? (
            <SettingsStatus kind="warn" label={gatewayAuthLabel()} />
          ) : props.security.gatewayAuthReported ? (
            <SettingsStatus kind="ok" label={gatewayAuthLabel()} />
          ) : (
            <SettingsValue value={gatewayAuthLabel()} />
          )
        }
        onClick={() => props.onOpenGatewaySettings?.()}
      />
      <SettingsNavRow
        title={t("quickSettings.security.networkAccess")}
        description={exposureDetail()}
        control={
          networkStatus() ? (
            <SettingsStatus kind={networkStatus() ?? "muted"} label={networkAccessLabel()} />
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
  let requestedScope: GatewayConnectionScope | null = null;
  const clearHostPolicy = () => {
    requestedScope = null;
    setExecApprovalDefaults(null);
  };
  const connection = useGatewayPage({
    getGateway: () => props.context.gateway,
    invalidateRequests: clearHostPolicy,
    onSnapshot: ({ snapshot }) => {
      if (!canCallGatewayMethod(snapshot, "exec.approvals.get", "operator.admin")) {
        clearHostPolicy();
        return;
      }
      if (requestedScope && connection.isCurrent(requestedScope)) {
        return;
      }
      const scope = connection.capture();
      if (!scope) {
        return;
      }
      requestedScope = scope;
      void scope.client
        .request<{ resolvedDefaults?: ExecApprovalDefaults }>("exec.approvals.get", {})
        .then((result) => {
          if (
            requestedScope === scope &&
            connection.isCurrent(scope) &&
            canCallGatewayMethod(connection.snapshot, "exec.approvals.get", "operator.admin")
          ) {
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
        bindHost: props.context.gateway.snapshot.hello?.snapshot?.bindHost,
        tailscaleMode: props.context.gateway.snapshot.hello?.snapshot?.tailscaleMode,
        tailscaleExposure: props.context.gateway.snapshot.hello?.snapshot?.tailscaleExposure,
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
