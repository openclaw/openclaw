import { createMemo, Errored, For, Loading, Show } from "solid-js";
import { Icon } from "../../components/solid/icon.tsx";
import { MarkdownHtml } from "../../components/solid/markdown-html.tsx";
import { formatRelativeTimestamp } from "../../lib/format.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { Diff, LoadState, splitFrontmatter } from "./detail.tsx";
import { MutationButton, type WorkshopReads, type WorkshopView } from "./view-shared.tsx";

/** A waiting draft: why it was proposed, what it would change, and Apply or Discard. */
export function DraftDetail(props: { view: WorkshopView; reads: WorkshopReads }) {
  const target = () => props.view().viewer!.target;
  const snapshot = () => props.view().snapshot!;
  const draft = createMemo(() =>
    snapshot().list.drafts?.find((entry) => entry.id === target().draftId),
  );
  const live = createMemo(() =>
    snapshot().list.skills.some((skill) => skill.name === target().name),
  );
  // The draft's files come with each read of it.
  const files = () => props.view().viewer?.result?.files ?? [];
  const meta = () => {
    const current = draft();
    if (!current) {
      return "";
    }
    return [
      t("skillWorkshop.drafts.proposed", { time: formatRelativeTimestamp(current.createdAtMs) }),
      t(live() ? "skillWorkshop.drafts.updatesSkill" : "skillWorkshop.drafts.createsSkill"),
      files().length > 1
        ? t("skillWorkshop.drafts.files", { count: String(files().length) })
        : null,
    ]
      .filter(Boolean)
      .join(" · ");
  };
  const mutation = (method: "skills.workshop.applyDraft" | "skills.workshop.discardDraft") => ({
    method,
    name: target().name,
    draftId: target().draftId!,
  });
  return (
    <Show when={draft()}>
      {(current) => (
        <>
          <header class="sw-detail__head">
            <div class="sw-detail__identity">
              <h2 class="sw-detail__title">{target().name}</h2>
              {current().summary && <p class="sw-detail__desc">{current().summary}</p>}
              <p class="sw-detail__meta">{meta()}</p>
            </div>
            <div class="sw-detail__actions">
              <MutationButton
                view={props.view}
                label={t("skillWorkshop.drafts.discard")}
                title={t("skillWorkshop.drafts.discardTitle")}
                mutation={mutation("skills.workshop.discardDraft")}
                actionKey={`discard:${current().id}`}
                icon="x"
              />
              <MutationButton
                view={props.view}
                label={t("skillWorkshop.drafts.apply")}
                title={t(
                  live()
                    ? "skillWorkshop.drafts.applyUpdateTitle"
                    : "skillWorkshop.drafts.applyNewTitle",
                )}
                mutation={mutation("skills.workshop.applyDraft")}
                actionKey={`apply:${current().id}`}
                variant="primary"
                icon="check"
              />
            </div>
          </header>
          <div class="sw-notice">
            {t("skillWorkshop.drafts.chatHint", { skill: target().name })}
          </div>
          <div class="sw-detail__body">
            <Show when={files().length > 1} fallback={<DraftContent reads={props.reads} />}>
              {/* The same two-column file view as a live skill's Files tab. */}
              <div class="sw-files">
                <ul class="sw-files__list" aria-label={t("skillWorkshop.drafts.filesLabel")}>
                  <For each={files()} keyed>
                    {(file) => (
                      <li>
                        <button
                          type="button"
                          class={[
                            "sw-files__item",
                            { "sw-files__item--active": file === target().filePath },
                          ]}
                          aria-current={file === target().filePath ? "true" : undefined}
                          onClick={() => props.view().onOpen({ ...target(), filePath: file })}
                        >
                          <span aria-hidden="true">
                            <Icon name="fileText" />
                          </span>
                          <span>{file}</span>
                        </button>
                      </li>
                    )}
                  </For>
                </ul>
                <div class="sw-files__content">
                  <DraftContent reads={props.reads} />
                </div>
              </div>
            </Show>
          </div>
        </>
      )}
    </Show>
  );
}

function DraftContent(props: { reads: WorkshopReads }) {
  return (
    <Loading on={props.reads.viewerRequest()} fallback={<LoadState />}>
      <Errored fallback={(error) => <LoadState error={error()} />}>
        <Show when={props.reads.viewer()}>
          {(viewer) => (
            <>
              {viewer().current !== undefined ? (
                <Diff
                  before={viewer().current!}
                  after={viewer().result.content}
                  beforeLabel={t("skillWorkshop.drafts.diffLive")}
                  afterLabel={t("skillWorkshop.drafts.diffDraft")}
                  sameText={t("skillWorkshop.drafts.same")}
                  tooLargeText={t("skillWorkshop.drafts.tooLarge")}
                  fallbackSide="after"
                />
              ) : viewer().target.filePath.endsWith(".md") ? (
                <MarkdownHtml
                  class="sw-markdown chat-text"
                  markdown={splitFrontmatter(viewer().result.content).body}
                  options={{ mode: "document" }}
                />
              ) : (
                <pre class="sw-file">{viewer().result.content}</pre>
              )}
            </>
          )}
        </Show>
      </Errored>
    </Loading>
  );
}
