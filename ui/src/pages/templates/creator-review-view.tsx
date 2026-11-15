import type { TemplateDraftReviewItem } from "@openclaw/gateway-protocol";
import { createMemo, createSignal, For, Loading, Show } from "solid-js";
import { handleCopyButton } from "../../components/copy-button-state.ts";
import { Icon, type IconName } from "../../components/solid/icon.tsx";
import { InlineAlert } from "../../components/solid/inline-alert.tsx";
import { t } from "../../lib/reactive/i18n.ts";
import { createPendingFocus } from "../../lib/reactive/pending-focus.ts";
import type { SourceProjection } from "../../lib/reactive/projection.ts";
import { agentDocuments, fileRole } from "../agents-home/template-workspace-file-roles.ts";
import { createSessionAutomationSchedule } from "../chat/components/session-automation-schedule-loader.ts";
import "../../styles/templates-catalog.css";
import { TemplateItemDetails } from "./creator-item-details.tsx";
import type { TemplateCreator } from "./creator-publication.ts";
import "../../components/tooltip.ts";

type CreatorView = SourceProjection<TemplateCreator, TemplateCreator>;
type Kind = TemplateDraftReviewItem["kind"];
type ReviewEntry = TemplateDraftReviewItem & { fileIcon?: IconName };
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
  const [allFiles, setAllFiles] = createSignal(false);
  const [selectedId, setSelectedId] = createSignal<string | null>(null);
  const busy = () => state().busy === "publishing";
  const publicationStatus = () =>
    state().publicationIssue
      ? undefined
      : (state().publication?.publicationStatus ?? "unpublished");
  const schedule = createSessionAutomationSchedule();
  const fileEntries = (archive: boolean): ReviewEntry[] =>
    review().files.flatMap((file) =>
      (archive ? [file.path] : (file.workspacePaths ?? [])).map((label) => ({
        id: label,
        kind: "file",
        included: true,
        label,
        detail: file.content,
        fileIcon: fileRole(
          archive ? (file.workspacePaths?.find((name) => agentDocuments.has(name)) ?? "") : label,
        )[0],
      })),
    );
  const entries = (kind: Kind): ReviewEntry[] =>
    kind === "file"
      ? fileEntries(true)
      : review().items.filter((item) => item.kind === kind && item.included);
  const label = () =>
    t("templatesDraft." + sections.find((section) => section.kind === category())?.key);
  const currentSection = () => sections.find((entry) => entry.kind === category())!;
  const hint = () => t("templatesDraft." + currentSection().key + "Hint");
  const summary = (item: TemplateDraftReviewItem) => {
    if (item.automation) {
      return (
        schedule({
          kind: "cron",
          expr: item.automation.schedule.cron,
          tz: item.automation.schedule.timezone,
        }) +
        " · " +
        item.automation.schedule.timezone
      );
    }
    if (item.kind === "mcp") {
      const server: { url?: string; command?: string } = JSON.parse(item.detail);
      return server.url ?? server.command;
    }
    return item.detail
      .trim()
      .split("\n")
      .find((line) => line && line !== "---")
      ?.replace(/^#+\s*/, "");
  };
  const categoryEntries = createMemo(() => {
    const items = category() === "file" && !allFiles() ? fileEntries(false) : entries(category()!);
    return category() === "file" && !allFiles()
      ? [
          "SOUL.md",
          "AGENTS.md",
          ...items
            .map((item) => item.label)
            .filter((name) => name !== "SOUL.md" && name !== "AGENTS.md"),
        ].flatMap((name) => items.filter((item) => item.label === name && agentDocuments.has(name)))
      : items;
  });
  const selected = createMemo(() => categoryEntries().find((item) => item.id === selectedId()));
  const title = () =>
    selected()?.label ??
    (category()
      ? allFiles()
        ? t("templatesDraft.fileNavigation")
        : label()
      : review().displayName);
  let heading: HTMLHeadingElement | undefined;
  let body: HTMLDivElement | undefined;
  createPendingFocus(() => [category(), selectedId(), allFiles()], {
    requested: (_next, previous) => Boolean(previous),
    focus: () => {
      body?.scrollTo?.(0, 0);
      heading?.focus({ preventScroll: true });
    },
  });
  // Native transcript roots can retire independently of an issued write. The plain
  // owner admits synchronously and presents busy/error/receipt facts; an action
  // here would hold row removal or navigation until the network settles.
  const publish = () => props.flow.publish();
  function back() {
    if (selectedId()) {
      setSelectedId(null);
    } else if (allFiles()) {
      setAllFiles(false);
    } else {
      setCategory(null);
    }
  }
  return (
    <section
      class={[
        "template-package-preview",
        "template-creator",
        { "template-creator--detail": Boolean(category()) },
      ]}
      aria-label={t("templatesDraft.reviewTitle")}
    >
      <header
        class={[
          "template-creator__header",
          { "template-creator__header--detail": Boolean(category()) },
        ]}
      >
        <Show
          when={category()}
          fallback={
            <span class="template-package-art template-creator__art">
              <Icon name="box" />
            </span>
          }
        >
          <button
            type="button"
            class="btn btn--icon"
            aria-label={
              selectedId() || allFiles()
                ? t("templatesDraft.backToContents")
                : t("templatesDraft.backToTemplate")
            }
            onClick={back}
          >
            <Icon name="arrowLeft" />
          </button>
        </Show>
        <div>
          <Show when={!category() && publicationStatus()}>
            <span class="template-creator__status-anchor">
              <openclaw-tooltip
                prop:content={
                  publicationStatus() === "pending" ? t("templatesDraft.awaitingReview") : ""
                }
                prop:disabled={publicationStatus() !== "pending"}
              >
                <span
                  class="template-creator__status"
                  data-state={publicationStatus()}
                  role="status"
                  tabindex={publicationStatus() === "pending" ? 0 : undefined}
                >
                  {t("templatesDraft." + publicationStatus())}
                </span>
              </openclaw-tooltip>
            </span>
          </Show>
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
                      class="template-package-row template-creator__row"
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
                      <span class="template-package-count template-creator__count">
                        {entries(section.kind).length}
                      </span>
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
              <div class="template-creator__category">
                <span class="template-creator__category-icon">
                  <Icon name={currentSection().icon} />
                </span>
                <p class="template-creator__hint">{hint()}</p>
                <div class="template-creator__contents">
                  <For each={categoryEntries()} keyed={(item) => item.id}>
                    {(item) => (
                      <button
                        type="button"
                        class="template-package-row template-creator__row"
                        aria-label={item().label}
                        onClick={() => setSelectedId(item().id)}
                      >
                        <Show when={category() === "file"}>
                          <span class="template-creator__row-icon">
                            <Icon name={item().fileIcon!} />
                          </span>
                        </Show>
                        <span>
                          <strong>{item().label}</strong>
                          <Loading fallback={<small>{t("common.loading")}</small>}>
                            <small>{summary(item())}</small>
                          </Loading>
                        </span>
                        <Icon name="chevronRight" />
                      </button>
                    )}
                  </For>
                  <Show when={category() === "file" && !allFiles()}>
                    <button
                      type="button"
                      class="template-package-row template-creator__row"
                      onClick={() => setAllFiles(true)}
                    >
                      <span class="template-creator__row-icon">
                        <Icon name="folder" />
                      </span>
                      <span>
                        <strong>{t("templatesDraft.viewAll")}</strong>
                      </span>
                      <Icon name="chevronRight" />
                    </button>
                  </Show>
                </div>
              </div>
            }
          >
            {(item) => (
              <div class="template-creator__preview">
                <TemplateItemDetails flow={props.flow} item={item()} />
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
                    <Show
                      when={publication().publicationStatus === "published"}
                      fallback={
                        <a
                          class="btn primary"
                          href={publication().url}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          {t("templatesDraft.viewSubmission")}
                        </a>
                      }
                    >
                      <For each={[publication().url]}>
                        {(url) => {
                          let copyLabel!: HTMLSpanElement;
                          return (
                            <button
                              type="button"
                              class="btn primary"
                              onClick={(event) =>
                                void handleCopyButton(event, url, t("templatesDraft.copyLink"), {
                                  label: copyLabel,
                                })
                              }
                            >
                              <span ref={(element) => (copyLabel = element)}>
                                {t("templatesDraft.copyLink")}
                              </span>
                            </button>
                          );
                        }}
                      </For>
                    </Show>
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
