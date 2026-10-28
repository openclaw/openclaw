import type { JSX } from "@solidjs/web";
import { createSignal, Show } from "solid-js";
import { SettingsRow, SettingsSection } from "../../components/solid/settings-ui.tsx";
import { registerProfileEnglish } from "../../i18n/locales/en-profile.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";

registerEnglishCatalog(registerProfileEnglish);

export type GitProvider = "github" | "gitlab";

/** Chooses a provider; each mounted connection owner still runs its native setup. */
export function GitProviderChooser(props: {
  githubAvailable: boolean;
  gitlabAvailable: boolean;
  onSelect: (provider: GitProvider) => void;
  children: JSX.Element;
}) {
  const [open, setOpen] = createSignal(false);
  const choose = (provider: GitProvider) => {
    if (!(provider === "github" ? props.githubAvailable : props.gitlabAvailable)) {
      return;
    }
    setOpen(false);
    props.onSelect(provider);
  };
  return (
    <section class="settings-section" data-git-connections>
      <div class="settings-section__header">
        <div class="settings-section__copy">
          <h2 class="settings-section__heading">{t("profilePage.gitConnections.title")}</h2>
          <p class="settings-section__desc">{t("profilePage.gitConnections.description")}</p>
        </div>
        <div class="settings-section__actions">
          <button
            type="button"
            class="btn btn--sm"
            disabled={!props.githubAvailable && !props.gitlabAvailable}
            onClick={() => setOpen(true)}
          >
            {t("profilePage.gitConnections.addProvider")}
          </button>
        </div>
      </div>
      <div class="settings-stack">{props.children}</div>
      <Show when={open()}>
        <openclaw-modal-dialog
          label={t("profilePage.gitConnections.addProviderLabel")}
          onModal-cancel={(event: Event) => {
            event.preventDefault();
            setOpen(false);
          }}
        >
          <div class="settings-page" data-git-provider-chooser>
            <SettingsSection
              title={t("profilePage.gitConnections.addProviderLabel")}
              description={t("profilePage.gitConnections.chooseProvider")}
            >
              <Show when={props.githubAvailable}>
                <SettingsRow
                  title={t("profilePage.gitConnections.github")}
                  description={t("profilePage.gitConnections.githubDescription")}
                  control={
                    <button type="button" class="btn btn--sm" onClick={() => choose("github")}>
                      {t("profilePage.gitConnections.connectGithub")}
                    </button>
                  }
                />
              </Show>
              <Show when={props.gitlabAvailable}>
                <SettingsRow
                  title={t("profilePage.gitConnections.gitlab")}
                  description={t("profilePage.gitConnections.gitlabDescription")}
                  control={
                    <button type="button" class="btn btn--sm" onClick={() => choose("gitlab")}>
                      {t("profilePage.gitConnections.connectGitlab")}
                    </button>
                  }
                />
              </Show>
            </SettingsSection>
            <openclaw-modal-actions>
              <button type="button" class="btn" onClick={() => setOpen(false)}>
                {t("profilePage.gitConnections.cancel")}
              </button>
            </openclaw-modal-actions>
          </div>
        </openclaw-modal-dialog>
      </Show>
    </section>
  );
}
