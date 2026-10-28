import { createMemo, createSignal } from "solid-js";
import { SettingsRow } from "../../components/solid/settings-ui.tsx";
import { registerProfileEnglish } from "../../i18n/locales/en-profile.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";

registerEnglishCatalog(registerProfileEnglish);

/** The draft resets when the configured server changes; owners admit authorization. */
export function GitLabServerAuthorization(props: {
  issuer?: string;
  disabled: boolean;
  title: string;
  description: string;
  onContinue: (serverUrl: string) => void;
}) {
  const configuredIssuer = createMemo(() => props.issuer ?? "");
  const [serverUrl, setServerUrl] = createSignal(() => configuredIssuer());
  return (
    <>
      <SettingsRow
        title={t("profilePage.gitConnections.gitlabServerUrl")}
        description={t("profilePage.gitConnections.gitlabServerSetup")}
        control={
          <input
            type="url"
            aria-label={t("profilePage.gitConnections.gitlabServerUrl")}
            placeholder="https://gitlab.example.com"
            value={serverUrl()}
            disabled={props.disabled}
            onInput={(event) => setServerUrl(event.currentTarget.value)}
          />
        }
      />
      <SettingsRow
        title={props.title}
        description={props.description}
        control={
          <button
            type="button"
            class="btn btn--sm"
            disabled={props.disabled || !serverUrl().trim()}
            onClick={() => props.onContinue(serverUrl())}
          >
            {t("profilePage.gitConnections.gitlabContinue")}
          </button>
        }
      />
    </>
  );
}
