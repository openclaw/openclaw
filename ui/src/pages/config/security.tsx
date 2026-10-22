// Curated policies above the schema-backed security and approvals editor.
import { asNullableRecord as asConfigRecord } from "@openclaw/normalization-core/record-coerce";
import type { JSX } from "@solidjs/web";
import { Icon } from "../../components/solid/icon.tsx";
import {
  SettingsDefaultDescription,
  SettingsPage,
  SettingsRow,
  SettingsSection,
  SettingsSegmented,
  SettingsStatus,
  SettingsToggleRow,
  SettingsValue,
} from "../../components/solid/settings-ui.tsx";
import { PROFILE_OPTIONS } from "../../lib/agents/tool-catalog.ts";
import { t } from "../../lib/reactive/i18n.ts";

type SecurityOverview = ReturnType<typeof extractQuickSettingsSecurity>;

export function extractQuickSettingsSecurity(root: Record<string, unknown>) {
  const gateway = asConfigRecord(root.gateway);
  const auth = asConfigRecord(gateway?.auth);
  const tools = asConfigRecord(root.tools);
  const exec = asConfigRecord(tools?.exec) ?? {};
  const browser = asConfigRecord(root.browser);
  let gatewayAuth = "unknown";
  if (auth) {
    const mode = typeof auth.mode === "string" ? auth.mode.trim() : "";
    gatewayAuth = mode
      ? mode
      : auth.password
        ? "password"
        : auth.token
          ? "token"
          : auth.trustedProxy
            ? "trusted-proxy"
            : "none";
  }
  const profile = tools?.profile;
  const security = exec.security;
  return {
    gatewayAuth,
    execPolicy: typeof security === "string" && security.trim() ? security.trim() : "allowlist",
    browserEnabled: browser?.enabled !== false,
    browserEnabledOverridden: browser !== null && Object.hasOwn(browser, "enabled"),
    toolProfile: typeof profile === "string" ? profile.trim() : "",
    toolProfileOverridden: tools !== null && Object.hasOwn(tools, "profile"),
  };
}

export type SecurityViewProps = {
  security: SecurityOverview;
  configBusy: boolean;
  canPairDevice: boolean;
  onPairMobile?: () => void;
  onBrowserEnabledToggle?: (enabled: boolean) => void;
  onToolProfileChange?: (profile: string) => void;
  /** Embedded schema editor; it owns autosave status and the restart banner. */
  editor: JSX.Element;
};

function SecurityOverviewSection(props: SecurityViewProps) {
  const profile = () => props.security.toolProfile.trim();
  const profileOptions = () => {
    const options: Array<{ value: string; label: string }> = PROFILE_OPTIONS.map((item) => ({
      value: item.id,
      label: t(item.labelKey),
    }));
    if (profile() && !options.some((option) => option.value === profile())) {
      options.push({ value: profile(), label: profile() });
    }
    return options;
  };
  return (
    <SettingsSection title={t("quickSettings.security.title")}>
      <SettingsRow
        title={t("quickSettings.security.gatewayAuth")}
        control={
          <SettingsStatus
            kind={
              props.security.gatewayAuth === "none"
                ? "warn"
                : props.security.gatewayAuth === "unknown"
                  ? "muted"
                  : "ok"
            }
            label={props.security.gatewayAuth}
          />
        }
      />
      <SettingsRow
        title={t("quickSettings.security.execPolicy")}
        control={<SettingsValue value={props.security.execPolicy} />}
      />
      <SettingsToggleRow
        title={t("quickSettings.security.browserEnabled")}
        description={
          <SettingsDefaultDescription
            value={t("common.enabled")}
            overridden={props.security.browserEnabledOverridden}
          />
        }
        checked={props.security.browserEnabled}
        disabled={props.configBusy}
        onChange={(enabled) => props.onBrowserEnabledToggle?.(enabled)}
      />
      <SettingsRow
        title={t("quickSettings.security.toolProfile")}
        description={
          props.security.toolProfileOverridden
            ? undefined
            : t("quickSettings.security.toolProfileDefault")
        }
        stacked
        control={
          <SettingsSegmented
            value={profile()}
            options={profileOptions()}
            ariaLabel={t("quickSettings.security.toolProfile")}
            disabled={props.configBusy}
            onChange={(value) => props.onToolProfileChange?.(value)}
          />
        }
      />
      <SettingsRow
        title={t("devices.pairing.title")}
        control={
          <button
            class="btn"
            title={props.canPairDevice ? "" : t("devices.pairing.adminRequired")}
            disabled={!props.canPairDevice}
            onClick={() => props.onPairMobile?.()}
          >
            <Icon name="smartphone" /> {t("devices.pairing.button")}
          </button>
        }
      />
    </SettingsSection>
  );
}

export function Security(props: SecurityViewProps) {
  return (
    <section class="security-page">
      <SettingsPage>
        <SecurityOverviewSection {...props} />
      </SettingsPage>
      {props.editor}
    </section>
  );
}
