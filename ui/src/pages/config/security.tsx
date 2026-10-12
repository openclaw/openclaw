// Curated policies above the schema-backed security and approvals editor.
import { createMemo } from "@solidjs/signals";
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

export type SecurityOverview = {
  gatewayAuth: string;
  execPolicy: string;
  browserEnabled: boolean;
  browserEnabledOverridden: boolean;
  toolProfile: string;
  toolProfileOverridden: boolean;
};

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
  const profileOptions = createMemo(() => {
    const options: Array<{ value: string; label: string }> = PROFILE_OPTIONS.map((item) => ({
      value: item.id,
      label: t(item.labelKey),
    }));
    if (profile() && !options.some((option) => option.value === profile())) {
      options.push({ value: profile(), label: profile() });
    }
    return options;
  });
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

export function renderSecurity(props: SecurityViewProps) {
  return <Security {...props} />;
}
