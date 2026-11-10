import type { TemplateDraftReviewItem } from "@openclaw/gateway-protocol";
import { action, createMemo, createOptimistic, createSignal, For, Show } from "solid-js";
import { CopyButton } from "../../components/solid/copy-button.tsx";
import { Icon, type IconName } from "../../components/solid/icon.tsx";
import { InlineAlert } from "../../components/solid/inline-alert.tsx";
import { t } from "../../lib/reactive/i18n.ts";
import { createPendingFocus } from "../../lib/reactive/pending-focus.ts";
import type { SourceProjection } from "../../lib/reactive/projection.ts";
import { TemplateArtwork } from "../agents-home/template-artwork.tsx";
import type { TemplateCreator } from "./creator-publication.ts";
import "../../styles/template-creator.css";

type CreatorView = SourceProjection<TemplateCreator, TemplateCreator>;
type Kind = TemplateDraftReviewItem["kind"];
const sections: Array<{ kind: Kind; key: string; icon: IconName }> = [
  { kind: "file", key: "workspaceFiles", icon: "fileText" },
  { kind: "skill", key: "skills", icon: "book" },
  { kind: "plugin", key: "plugins", icon: "plug" },
  { kind: "mcp", key: "mcpServers", icon: "server" },
  { kind: "automation", key: "automations", icon: "clock" },
];

/** Navigation is local presentation over the exact reviewed archive. It never edits the package. */
function TemplateReviewCard(props: { flow: TemplateCreator; view: CreatorView }) {
  const state = () => props.view.read();
  const review = () => state().review!;
  const [category, setCategory] = createSignal<Kind | null>(null);
  const [selectedId, setSelectedId] = createSignal<string | null>(null);
  const [publishing, setPublishing] = createOptimistic(false);
  const busy = () => publishing() || state().busy === "publishing";
  const entries = (kind: Kind) =>
    kind === "file"
      ? review().files.map((file) => ({ id: file.path, label: file.path, detail: file.content }))
      : review().items.filter((item) => item.kind === kind && item.included);
  const selected = createMemo(() =>
    category() ? entries(category()!).find((item) => item.id === selectedId()) : undefined,
  );
  const label = () =>
    t("templatesDraft." + sections.find((section) => section.kind === category())?.key);
  const title = () => selected()?.label ?? (category() ? label() : review().displayName);
  let heading: HTMLHeadingElement | undefined;
  let body: HTMLDivElement | undefined;
  createPendingFocus(() => [category(), selectedId()], {
    requested: (_next, previous) => Boolean(previous),
    focus: () => {
      body?.scrollTo?.(0, 0);
      heading?.focus({ preventScroll: true });
    },
  });
  const publish = action(function* () {
    setPublishing(true);
    yield props.flow.publish();
  });
  function back() {
    if (selectedId()) {
      setSelectedId(null);
    } else {
      setCategory(null);
    }
  }
  return (
    <section class="template-creator" aria-label={t("templatesDraft.reviewTitle")}>
      <header
        class={[
          "template-creator__header",
          { "template-creator__header--detail": Boolean(category()) },
        ]}
      >
        <Show
          when={category()}
          fallback={
            <span class="template-creator__art">
              <TemplateArtwork />
            </span>
          }
        >
          <button
            type="button"
            class="btn btn--icon"
            aria-label={
              selectedId() ? t("templatesDraft.backToContents") : t("templatesDraft.backToTemplate")
            }
            onClick={back}
          >
            <Icon name="arrowLeft" />
          </button>
        </Show>
        <div>
          <h2 ref={(element) => (heading = element)} tabindex={-1}>
            {title()}
          </h2>
          <Show when={!category()}>
            <p class="template-creator__byline">
              {t("templatesDraft.byCreator", { creator: "@" + review().publisher })}
            </p>
            <p class="template-creator__description">{review().description}</p>
          </Show>
        </div>
      </header>
      <div class="template-creator__body" ref={(element) => (body = element)}>
        <Show
          when={category()}
          fallback={
            <div class="template-creator__contents">
              <For each={sections}>
                {(section) => (
                  <Show when={section.kind === "file" || entries(section.kind).length > 0}>
                    <button
                      type="button"
                      class="template-creator__row"
                      onClick={() => setCategory(section.kind)}
                    >
                      <span class="template-creator__row-icon">
                        <Icon name={section.icon} />
                      </span>
                      <span>
                        <strong>{t("templatesDraft." + section.key)}</strong>
                        <small>
                          {entries(section.kind)
                            .map((item) => item.label)
                            .join(", ") || t("templatesDraft.emptyContents")}
                        </small>
                      </span>
                      <span class="template-creator__count">{entries(section.kind).length}</span>
                      <Icon name="chevronRight" />
                    </button>
                  </Show>
                )}
              </For>
              <details class="template-creator__scope">
                <summary>{t("templatesDraft.behavior")}</summary>
                <dl>
                  <dt>{t("templatesDraft.input")}</dt>
                  <dd>{review().scope.input}</dd>
                  <dt>{t("templatesDraft.job")}</dt>
                  <dd>{review().scope.job}</dd>
                  <dt>{t("templatesDraft.output")}</dt>
                  <dd>{review().scope.output}</dd>
                  <dt>{t("templatesDraft.authority")}</dt>
                  <dd>{review().scope.authority}</dd>
                </dl>
              </details>
            </div>
          }
        >
          <Show
            when={selected()}
            fallback={
              <div class="template-creator__contents">
                <For each={entries(category()!)} keyed={(item) => item.id}>
                  {(item) => (
                    <button
                      type="button"
                      class="template-creator__row"
                      onClick={() => setSelectedId(item().id)}
                    >
                      <Icon name={sections.find((section) => section.kind === category())!.icon} />
                      <span>
                        <strong>{item().label}</strong>
                      </span>
                      <Icon name="chevronRight" />
                    </button>
                  )}
                </For>
              </div>
            }
          >
            {(item) => (
              <div class="template-creator__preview">
                <Show when={category() === "file"}>
                  <nav aria-label={t("templatesDraft.fileNavigation")}>
                    <For each={entries("file")} keyed={(file) => file.id}>
                      {(file) => (
                        <button
                          type="button"
                          class="btn btn--sm"
                          aria-current={file().id === selectedId() ? "true" : undefined}
                          onClick={() => setSelectedId(file().id)}
                        >
                          {file().label}
                        </button>
                      )}
                    </For>
                  </nav>
                </Show>
                <pre>{item().detail}</pre>
              </div>
            )}
          </Show>
        </Show>
      </div>
      <footer class="template-creator__footer">
        <Show when={state().error}>
          <InlineAlert tone="danger" role="alert">
            {state().error}
          </InlineAlert>
        </Show>
        <div class="template-creator__actions">
          <Show
            when={state().publicationIssue}
            fallback={
              <Show
                when={state().publication}
                fallback={
                  <>
                    <Show when={!state().reviewCurrent && !busy()}>
                      <span role="status">
                        {t(
                          state().busy === "reviewing"
                            ? "templatesDraft.updating"
                            : "templatesDraft.reviewNeeded",
                        )}
                      </span>
                      <button
                        type="button"
                        class="btn"
                        disabled={state().busy !== null}
                        onClick={() => props.flow.retryReview()}
                      >
                        {t("templatesDraft.refreshReview")}
                      </button>
                    </Show>
                    <button
                      type="button"
                      class="btn primary"
                      disabled={busy() || !state().reviewCurrent || state().busy !== null}
                      aria-busy={busy() ? "true" : undefined}
                      onClick={() => void publish()}
                    >
                      <Show when={busy()}>
                        <span class="btn__spinner" aria-hidden="true" />
                      </Show>
                      {t(busy() ? "templatesDraft.publishing" : "templatesDraft.publish")}
                    </button>
                  </>
                }
              >
                {(publication) => (
                  <>
                    <span role="status">
                      {t(
                        publication().publicationStatus === "published"
                          ? "templatesDraft.published"
                          : "templatesDraft.pending",
                      )}
                    </span>
                    <Show when={publication().publicationStatus === "published"}>
                      <CopyButton
                        text={publication().url}
                        idleLabel={t("templatesDraft.copyLink")}
                      />
                    </Show>
                    <a
                      class="btn"
                      href={publication().url}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {t(
                        publication().publicationStatus === "published"
                          ? "templatesDraft.viewPublication"
                          : "templatesDraft.viewSubmission",
                      )}
                    </a>
                  </>
                )}
              </Show>
            }
          >
            {(issue) => (
              <>
                <span role="status">
                  {t(
                    issue() === "failed"
                      ? "templatesDraft.notPublished"
                      : "templatesDraft.unconfirmed",
                  )}
                </span>
                <button
                  type="button"
                  class="btn"
                  disabled={state().busy !== null}
                  aria-busy={state().busy === "reviewing" ? "true" : undefined}
                  onClick={() =>
                    issue() === "failed"
                      ? props.flow.retryReview()
                      : void props.flow.checkPublication()
                  }
                >
                  <Show when={state().busy === "reviewing"}>
                    <span class="btn__spinner" aria-hidden="true" />
                  </Show>
                  {t(issue() === "failed" ? "common.retry" : "templatesDraft.checkStatus")}
                </button>
              </>
            )}
          </Show>
        </div>
      </footer>
    </section>
  );
}

export function TemplateCreatorReviewView(props: { flow: TemplateCreator; view: CreatorView }) {
  return (
    <Show
      when={props.view.read().review}
      fallback={
        <Show when={props.view.read().error}>
          <InlineAlert tone="danger" role="alert">
            {props.view.read().error}
            <button type="button" class="btn" onClick={() => props.flow.retryReview()}>
              {t("templatesDraft.retryReview")}
            </button>
          </InlineAlert>
        </Show>
      }
    >
      <TemplateReviewCard flow={props.flow} view={props.view} />
    </Show>
  );
}
