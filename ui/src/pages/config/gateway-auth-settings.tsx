import type { JSX } from "@solidjs/web";
import { createMemo, createSignal, Show } from "solid-js";
import { SettingsSelect } from "../../components/solid/settings-select.tsx";
import {
  SettingsRow,
  SettingsSecretInput,
  SettingsSection,
  SettingsStatus,
} from "../../components/solid/settings-ui.tsx";
import { REDACTED_SENTINEL } from "../../lib/config-form-utils.ts";
import { t } from "../../lib/reactive/i18n.ts";
import {
  GATEWAY_AUTH_MODES,
  gatewayAuthMode,
  type GatewayAuthCard,
  type GatewayAuthMode,
} from "./gateway-auth-draft.ts";

const AUTH_PATH = ["gateway", "auth"];

function modeLabel(mode: GatewayAuthMode): string {
  return t(`quickSettings.security.gatewayAuthValue.${mode}`);
}

/** Gateway sign-in settings; edits stay staged until Apply writes them together. */
export function GatewayAuthSettings(props: {
  auth: GatewayAuthCard;
  disabled: boolean;
  onPatch: (path: Array<string | number>, value: unknown) => void;
}): JSX.Element {
  const [secretVisible, setSecretVisible] = createSignal(false);
  const auth = createMemo(() => props.auth.staged ?? props.auth.current);
  const mode = createMemo(() => gatewayAuthMode(auth()));
  const issue = () => props.auth.issue;
  const locked = () => props.disabled || props.auth.applying;
  const secretField = (field: "token" | "password") => {
    const value = auth()[field];
    // A saved secret arrives redacted; typing replaces it, an empty field keeps it.
    return {
      value: typeof value === "string" && value !== REDACTED_SENTINEL ? value : "",
      saved: value !== undefined && (typeof value !== "string" || value === REDACTED_SENTINEL),
    };
  };
  const secretRow = (field: "token" | "password") => (
    <SettingsRow
      title={t(`configPage.gatewayAuth.${field}`)}
      description={t(`configPage.gatewayAuth.${field}Description`)}
      stackedOnNarrow
      control={
        <SettingsSecretInput
          ariaLabel={t(`configPage.gatewayAuth.${field}`)}
          value={secretField(field).value}
          placeholder={t(
            secretField(field).saved
              ? "configPage.gatewayAuth.savedSecretPlaceholder"
              : `configPage.gatewayAuth.${field}Placeholder`,
          )}
          visible={secretVisible()}
          disabled={locked()}
          showLabel={t("configPage.gatewayAuth.showSecret")}
          hideLabel={t("configPage.gatewayAuth.hideSecret")}
          toggleLabel={t("configPage.gatewayAuth.toggleSecret")}
          onInput={(next) => props.onPatch([...AUTH_PATH, field], next)}
          onToggle={() => setSecretVisible((visible) => !visible)}
        />
      }
    />
  );
  return (
    <SettingsSection
      title={t("configPage.gatewayAuth.title")}
      description={t("configPage.gatewayAuth.description")}
      actions={
        <Show when={props.auth.staged}>
          <SettingsStatus kind="warn" label={t("configPage.gatewayAuth.unsaved")} />
          <button
            type="button"
            class="btn btn--sm"
            disabled={props.auth.applying}
            onClick={() => props.auth.onCancel()}
          >
            {t("configPage.gatewayAuth.cancel")}
          </button>
          <button
            type="button"
            class="btn btn--sm primary"
            disabled={locked() || issue() !== null}
            onClick={() => props.auth.onApply()}
          >
            {props.auth.applying
              ? t("configPage.gatewayAuth.applying")
              : t("configPage.gatewayAuth.apply")}
          </button>
        </Show>
      }
      notice={
        <Show when={props.auth.error ?? (issue() && t(`configPage.gatewayAuth.issues.${issue()}`))}>
          {(message) => (
            <p class="settings-section__desc" role={props.auth.error ? "alert" : "status"}>
              {message()}
            </p>
          )}
        </Show>
      }
    >
      <SettingsRow
        title={t("configPage.gatewayAuth.mode")}
        description={props.auth.staged ? t("configPage.gatewayAuth.pendingDescription") : undefined}
        control={
          <SettingsSelect
            aria-label={t("configPage.gatewayAuth.mode")}
            value={mode()}
            options={GATEWAY_AUTH_MODES.map((value) => ({ value, label: modeLabel(value) }))}
            disabled={locked()}
            onChange={(event) => props.onPatch([...AUTH_PATH, "mode"], event.currentTarget.value)}
          />
        }
      />
      <Show when={mode() === "token"}>{secretRow("token")}</Show>
      <Show when={mode() === "password"}>{secretRow("password")}</Show>
      <Show when={mode() === "trusted-proxy"}>
        <SettingsRow
          title={t("configPage.gatewayAuth.userHeader")}
          description={t("configPage.gatewayAuth.userHeaderDescription")}
          stackedOnNarrow
          control={
            <input
              class="settings-input"
              aria-label={t("configPage.gatewayAuth.userHeader")}
              placeholder={t("configPage.gatewayAuth.userHeaderPlaceholder")}
              autocomplete="off"
              spellcheck="false"
              value={String(
                (auth().trustedProxy as { userHeader?: unknown } | undefined)?.userHeader ?? "",
              )}
              disabled={locked()}
              onInput={(event) =>
                props.onPatch(
                  [...AUTH_PATH, "trustedProxy", "userHeader"],
                  event.currentTarget.value,
                )
              }
            />
          }
        />
      </Show>
      <Show when={mode() === "none"}>
        <SettingsRow
          title={t("configPage.gatewayAuth.noneTitle")}
          description={t("configPage.gatewayAuth.noneDescription")}
        />
      </Show>
    </SettingsSection>
  );
}
