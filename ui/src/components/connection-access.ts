import { html } from "lit";
import { t } from "../i18n/index.ts";
import { registerProfileEnglish } from "../i18n/locales/en-profile.ts";
import { renderSettingsRow, renderSettingsSection, renderSettingsValue } from "./settings-ui.ts";

registerProfileEnglish();

export function renderConnectionAccess(options: {
  scopes: readonly string[] | null;
  busy?: boolean;
  reconnect: () => void;
}) {
  const scopes = options.scopes;
  const summary =
    scopes === null
      ? "unknown"
      : scopes.length === 0
        ? "none"
        : ((
            [
              ["operator.admin", "admin"],
              ["operator.write", "write"],
              ["operator.sessions.write", "sessionWrite"],
              ["operator.read", "read"],
              ["operator.sessions.read", "sessionRead"],
            ] as const
          ).find(([scope]) => scopes.includes(scope))?.[1] ?? "limited");
  return html`<div id="settings-profile-access">
    ${renderSettingsSection(
      { title: t("profilePage.access.title") },
      html`
        ${renderSettingsRow({
          title: t(`profilePage.access.${summary}`),
          description: t("profilePage.access.limits"),
        })}
        ${renderSettingsRow({
          title: t("profilePage.access.help"),
          description: t("profilePage.access.nextStep"),
          stackedOnNarrow: true,
          control: html`<button
            type="button"
            class="btn"
            ?disabled=${options.busy === true}
            @click=${options.reconnect}
          >
            ${t("profilePage.access.reconnect")}
          </button>`,
        })}
        <details class="settings-row settings-row--stacked">
          <summary>${t("profilePage.access.details")}</summary>
          ${renderSettingsRow({
            title: t("profilePage.access.scopes"),
            description: t("profilePage.access.description"),
            stacked: true,
            control: renderSettingsValue(
              scopes === null
                ? t("profilePage.access.unknown")
                : scopes.length === 0
                  ? t("profilePage.access.none")
                  : scopes.join(", "),
              { mono: scopes !== null && scopes.length > 0 },
            ),
          })}
        </details>
      `,
    )}
  </div>`;
}
