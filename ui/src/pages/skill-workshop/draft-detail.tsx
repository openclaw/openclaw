import type { JSX } from "@solidjs/web";
import { createMemo, Errored, For, Loading, Show } from "solid-js";
import { Icon } from "../../components/solid/icon.tsx";
import { MarkdownHtml } from "../../components/solid/markdown-html.tsx";
import { formatRelativeTimestamp } from "../../lib/format.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { WorkshopDetailShell } from "./detail.tsx";
import { Diff, LoadState, splitFrontmatter } from "./diff.tsx";
import {
  MutationButton,
  renderUses,
  type WorkshopPage,
  type WorkshopReads,
  type WorkshopView,
} from "./view-shared.tsx";

/** A waiting draft: why it was proposed, what it would change, and Apply or Discard. */
export function DraftDetail(props: {
  view: WorkshopView;
  reads: WorkshopReads;
  page: WorkshopPage;
  errors: JSX.Element;
}) {
  const target = () => props.view().viewer!.target;
  const snapshot = () => props.view().snapshot!;
  const draft = createMemo(() =>
    snapshot().list.drafts?.find((entry) => entry.id === target().draftId),
  );
  const liveSkill = createMemo(() =>
    snapshot().list.skills.find((skill) => skill.name === target().name),
  );
  // The draft's files come with each read of it.
  const files = () => props.view().viewer?.result?.files ?? [];
  // The queue reads newest first, like the Drafts list.
  const queue = createMemo(() => (snapshot().list.drafts ?? []).toReversed());
  const position = () => queue().findIndex((entry) => entry.id === target().draftId);
  const step = (offset: number) => {
    const next = queue()[position() + offset];
    if (next) {
      props.view().onSelectDraft(next.id);
    }
  };
  const mutation = (method: "skills.workshop.applyDraft" | "skills.workshop.discardDraft") => ({
    method,
    name: target().name,
    draftId: target().draftId!,
  });
  return (
    <Show when={draft()}>
      {(current) => (
        <WorkshopDetailShell
          kind="draft"
          view={props.view}
          page={props.page}
          name={target().name}
          summary={current().summary}
          byline={t(
            liveSkill() ? "skillWorkshop.drafts.updatesSkill" : "skillWorkshop.drafts.createsSkill",
          )}
          actions={
            <>
              <MutationButton
                view={props.view}
                label={t("skillWorkshop.drafts.discard")}
                title={t("skillWorkshop.drafts.discardTitle")}
                mutation={mutation("skills.workshop.discardDraft")}
                actionKey={`discard:${current().id}`}
              />
              <MutationButton
                view={props.view}
                label={t("skillWorkshop.drafts.apply")}
                title={t(
                  liveSkill()
                    ? "skillWorkshop.drafts.applyUpdateTitle"
                    : "skillWorkshop.drafts.applyNewTitle",
                )}
                mutation={mutation("skills.workshop.applyDraft")}
                actionKey={`apply:${current().id}`}
                variant="primary"
              />
            </>
          }
          panel={
            <>
              {props.errors}
              <div class="sw-notice">
                {t("skillWorkshop.drafts.chatHint", { skill: target().name })}
              </div>
              <div class="sw-section">
                <Show when={files().length > 1}>
                  <div
                    class="sw-file-chips"
                    role="group"
                    aria-label={t("skillWorkshop.drafts.filesLabel")}
                  >
                    <For each={files()} keyed>
                      {(file) => (
                        <button
                          type="button"
                          class={[
                            "sw-file-chip",
                            { "sw-file-chip--active": file === target().filePath },
                          ]}
                          aria-current={file === target().filePath ? "true" : undefined}
                          onClick={() => props.view().onOpen({ ...target(), filePath: file })}
                        >
                          {file}
                        </button>
                      )}
                    </For>
                  </div>
                </Show>
                <DraftContent reads={props.reads} />
                <Show when={queue().length > 1 && position() >= 0}>
                  <nav class="sw-pager" aria-label={t("skillWorkshop.skills.drafts")}>
                    <button
                      type="button"
                      class="btn btn--sm btn--icon oc-action"
                      aria-label={t("common.previous")}
                      title={t("common.previous")}
                      disabled={position() <= 0}
                      onClick={() => step(-1)}
                    >
                      <Icon name="chevronLeft" />
                    </button>
                    <span class="sw-pager__count">
                      {t("skillWorkshop.drafts.position", {
                        current: String(position() + 1),
                        total: String(queue().length),
                      })}
                    </span>
                    <button
                      type="button"
                      class="btn btn--sm btn--icon oc-action"
                      aria-label={t("common.next")}
                      title={t("common.next")}
                      disabled={position() >= queue().length - 1}
                      onClick={() => step(1)}
                    >
                      <Icon name="chevronRight" />
                    </button>
                  </nav>
                </Show>
              </div>
            </>
          }
          facts={
            <>
              <div>
                <dt>{t("skillWorkshop.drafts.proposedLabel")}</dt>
                <dd>{formatRelativeTimestamp(current().createdAtMs)}</dd>
              </div>
              <Show when={liveSkill()}>
                {(skill) => (
                  <div>
                    <dt>{t("skillWorkshop.drafts.diffLive")}</dt>
                    <dd>{renderUses(skill().useCount)}</dd>
                  </div>
                )}
              </Show>
              <Show when={files().length > 0}>
                <div>
                  <dt>{t("skillWorkshop.drafts.filesLabel")}</dt>
                  <dd>{String(files().length)}</dd>
                </div>
              </Show>
            </>
          }
        />
      )}
    </Show>
  );
}

export function DraftContent(props: { reads: WorkshopReads }) {
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
                  tooLargeText={t("skillWorkshop.drafts.tooLarge")}
                  fallbackSide="after"
                />
              ) : viewer().target.filePath.endsWith(".md") ? (
                <div class="sw-well">
                  <MarkdownHtml
                    class="sw-markdown chat-text"
                    markdown={
                      viewer().target.filePath === "SKILL.md"
                        ? splitFrontmatter(viewer().result.content).body
                        : viewer().result.content
                    }
                    options={{ mode: "document" }}
                  />
                </div>
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
