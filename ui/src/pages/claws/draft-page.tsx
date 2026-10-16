import { createEffect, For, onCleanup, Show } from "solid-js";
import {
  SettingsPage,
  SettingsPageHeader,
  SettingsSection,
} from "../../components/solid/settings-ui.tsx";
import { projectGateway } from "../../lib/reactive/application.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { projectRuntimeConfig } from "../../lib/reactive/domain-capabilities.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { projectOwner } from "../../lib/reactive/projection.ts";
import "../../styles/claw-draft.css";
import type { ClawDraftTarget } from "./draft-navigation.ts";
import { ClawDraftPageState } from "./draft-state.ts";

const scopeFields = ["input", "job", "output", "authority"] as const;

export function ClawDraftPage(props: { target: ClawDraftTarget }) {
  const context = useApplication();
  const state = new ClawDraftPageState(context);
  const gateway = projectGateway(context.gateway);
  const config = projectRuntimeConfig(context.runtimeConfig);
  const view = projectOwner(state, (owner) => owner);
  createEffect(
    () => [props.target, gateway.revision(), config.revision()] as const,
    ([target]) => state.sync(target),
  );
  void context.runtimeConfig.ensureLoaded();
  onCleanup(() => state.dispose());
  return (
    <>
      <SettingsPageHeader
        title={t(props.target.draftId ? "clawsDraft.reviewTitle" : "clawsDraft.title")}
        subtitle={t("clawsDraft.subtitle")}
      />
      <SettingsPage wide carapace>
        <div class="claw-draft">
          <Show
            when={view.read().available}
            fallback={<p role="status">{t("clawsDraft.unavailable")}</p>}
          >
            <Show
              when={props.target.draftId}
              fallback={
                <SettingsSection title={t("clawsDraft.generateTitle")} carapace>
                  <p>
                    {t(
                      props.target.sourceSessionKey
                        ? "clawsDraft.fromSession"
                        : "clawsDraft.fromAgent",
                      { agent: props.target.agentId },
                    )}
                  </p>
                  <p class="muted">{t("clawsDraft.privateNotice")}</p>
                  <div class="claw-draft__actions">
                    <button
                      class="btn primary"
                      disabled={view.read().busy !== null}
                      onClick={() => void state.generate()}
                    >
                      {t(
                        view.read().busy === "generate"
                          ? "clawsDraft.generating"
                          : "clawsDraft.generate",
                      )}
                    </button>
                    <Show when={view.read().createdReviewUrl}>
                      {(url) => <a href={url()}>{t("clawsDraft.openDraft")}</a>}
                    </Show>
                  </div>
                </SettingsSection>
              }
            >
              <SettingsSection
                title={t("clawsDraft.editTitle")}
                description={t("clawsDraft.editDescription")}
                carapace
                actions={
                  <button
                    class="btn btn--sm"
                    disabled={view.read().busy !== null}
                    onClick={() => void state.load()}
                  >
                    {t("clawsDraft.reload")}
                  </button>
                }
              >
                <Show
                  when={view.read().saved}
                  fallback={
                    <p role="status">
                      {t(
                        view.read().busy === "load"
                          ? "clawsDraft.loading"
                          : "clawsDraft.loadFailed",
                      )}
                    </p>
                  }
                >
                  <label class="claw-draft__editor-label">
                    <span>{t("clawsDraft.document")}</span>
                    <textarea
                      class="settings-input claw-draft__editor"
                      spellcheck="false"
                      value={view.read().content}
                      disabled={view.read().busy !== null}
                      onInput={(event) => state.edit(event.currentTarget.value)}
                    />
                  </label>
                  <div class="claw-draft__actions">
                    <button
                      class="btn"
                      disabled={!view.read().dirty || view.read().busy !== null}
                      onClick={() => void state.save()}
                    >
                      {t(view.read().busy === "save" ? "clawsDraft.saving" : "clawsDraft.save")}
                    </button>
                    <button
                      class="btn primary"
                      disabled={
                        view.read().dirty ||
                        view.read().busy !== null ||
                        view.read().publication !== null
                      }
                      onClick={() => void state.prepareReview()}
                    >
                      {t(
                        view.read().busy === "review"
                          ? "clawsDraft.preparing"
                          : "clawsDraft.review",
                      )}
                    </button>
                    <Show when={view.read().dirty}>
                      <span class="muted">{t("clawsDraft.unsaved")}</span>
                    </Show>
                  </div>
                </Show>
              </SettingsSection>
              <Show when={view.read().review}>
                {(review) => (
                  <SettingsSection
                    title={t("clawsDraft.packageTitle")}
                    description={t("clawsDraft.packageDescription")}
                    carapace
                  >
                    <div class="claw-draft__identity">
                      <strong>{review().name}</strong>
                      <span class="muted">{review().version}</span>
                      <span>
                        {t("clawsDraft.publisher", {
                          publisher: review().publisher.replace(/^@/, ""),
                        })}
                      </span>
                    </div>
                    <dl class="claw-draft__scope">
                      <For each={scopeFields}>
                        {(field) => (
                          <div>
                            <dt>{t(`clawsDraft.scope.${field}`)}</dt>
                            <dd>{review().scope[field]}</dd>
                          </div>
                        )}
                      </For>
                    </dl>
                    <div class="claw-draft__files">
                      <For each={review().files} keyed={(file) => file.path}>
                        {(file) => (
                          <details class="claw-draft__file">
                            <summary>{file().path}</summary>
                            <pre>{file().content}</pre>
                          </details>
                        )}
                      </For>
                    </div>
                    <p class="muted">{t("clawsDraft.publishNotice")}</p>
                    <div class="claw-draft__actions">
                      <button
                        class="btn primary"
                        disabled={view.read().busy !== null}
                        onClick={() => void state.publish()}
                      >
                        {t("clawsDraft.publish")}
                      </button>
                    </div>
                  </SettingsSection>
                )}
              </Show>
              <Show when={view.read().busy === "publish"}>
                <p role="status">{t("clawsDraft.publishing")}</p>
              </Show>
              <Show when={view.read().publication}>
                {(result) => (
                  <div class="callout" role="status">
                    <strong>
                      {t(
                        result().publicationStatus === "published"
                          ? "clawsDraft.published"
                          : "clawsDraft.scanning",
                      )}
                    </strong>
                    <p>
                      {t(
                        result().publicationStatus === "published"
                          ? "clawsDraft.publishedDescription"
                          : "clawsDraft.scanningDescription",
                      )}
                    </p>
                    <a href={result().url} target="_blank" rel="noopener noreferrer">
                      {t("clawsDraft.viewPublication")}
                    </a>
                  </div>
                )}
              </Show>
            </Show>
          </Show>
          <Show when={view.read().error}>
            {(error) => (
              <div class="callout danger" role="alert">
                {error()}
              </div>
            )}
          </Show>
        </div>
      </SettingsPage>
    </>
  );
}
