import type { ClawDraftReviewItem } from "@openclaw/gateway-protocol";
import {
  action,
  createMemo,
  createOptimistic,
  Errored,
  For,
  Loading,
  onSettled,
  Show,
  type Accessor,
} from "solid-js";
import type { ApplicationContext } from "../../app/context.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { projectOwner, type SourceProjection } from "../../lib/reactive/projection.ts";
import { showToast } from "../../lib/toast.ts";
import { clawCreatorFlow, type ClawCreatorFlow } from "./creator-flow.ts";
import "../../styles/claw-creator.css";

type CreatorView = SourceProjection<ClawCreatorFlow, ClawCreatorFlow>;

const sections = [
  ["file", "clawsDraft.workspaceFiles"],
  ["skill", "clawsDraft.skills"],
  ["plugin", "clawsDraft.plugins"],
  ["mcp", "clawsDraft.mcpServers"],
  ["automation", "clawsDraft.automations"],
] as const;

function OptionalSection(props: {
  flow: ClawCreatorFlow;
  view: CreatorView;
  kind: ClawDraftReviewItem["kind"];
  title: string;
  publishing: boolean;
}) {
  const items = () =>
    props.view.read().review?.items.filter((item) => item.kind === props.kind) ?? [];
  const included = (item: ClawDraftReviewItem) => {
    const excluded = props.view.read().choices?.excluded;
    return excluded ? !excluded.includes(item.id) : item.included;
  };
  return (
    <Show when={items().length > 0}>
      <section class="claw-creator__section">
        <h3>
          {props.title} <span>{items().length}</span>
        </h3>
        <For each={items()} keyed={(item) => item.id}>
          {(item) => (
            <div class="claw-creator__row">
              <label class="claw-creator__row-choice">
                <input
                  type="checkbox"
                  checked={included(item())}
                  disabled={props.publishing}
                  onChange={(event) => {
                    const choices = props.view.read().choices;
                    if (!choices) {
                      return;
                    }
                    const excluded = new Set(choices.excluded);
                    if (event.currentTarget.checked) {
                      excluded.delete(item().id);
                    } else {
                      excluded.add(item().id);
                    }
                    props.flow.updateChoices({ ...choices, excluded: [...excluded] });
                  }}
                />
                <span>{item().label}</span>
              </label>
              <details>
                <summary>{t("clawsDraft.view")}</summary>
                <pre>{item().detail}</pre>
              </details>
            </div>
          )}
        </For>
      </section>
    </Show>
  );
}

function ClawReviewDialog(props: {
  flow: ClawCreatorFlow;
  view: CreatorView;
  reviewRead: Accessor<null>;
  reviewReceipt: ClawCreatorFlow["reviewRead"];
}) {
  const state = () => props.view.read();
  const review = () => state().review!;
  const choices = () => state().choices;
  const [publishing, setPublishing] = createOptimistic(false);
  const busy = () => publishing() || state().busy === "publishing";
  const presentPublish = action(function* (pending: Promise<void>, retired: Promise<void>) {
    setPublishing(true);
    try {
      // Closing or leaving releases presentation; the owner still records the write outcome.
      yield Promise.race([pending, retired]);
    } catch (error) {
      showToast({ message: formatUiError(error) });
    }
  });
  async function publish() {
    const retired = props.flow.presentationLifetime.promise;
    const pending = props.flow.publish();
    // Let the owner's synchronous admission land before the action joins the transition.
    await Promise.resolve();
    await presentPublish(pending, retired);
  }
  return (
    <openclaw-modal-dialog
      label={t("clawsDraft.reviewTitle")}
      style={{ "--openclaw-modal-width": "720px" }}
      onModal-cancel={(event: Event) => {
        event.preventDefault();
        props.flow.close();
      }}
    >
      <div class="exec-approval-card claw-creator">
        <h2>{t("clawsDraft.reviewTitle")}</h2>
        <p class="claw-creator__intro">{t("clawsDraft.intro")}</p>
        <div class="claw-creator__identity">
          <label>
            <span>{t("clawsDraft.name")}</span>
            <input
              class="settings-input"
              value={choices()?.displayName ?? ""}
              onInput={(event) => {
                const current = choices();
                if (current) {
                  props.flow.updateChoices({ ...current, displayName: event.currentTarget.value });
                }
              }}
            />
          </label>
          <label>
            <span>{t("clawsDraft.description")}</span>
            <textarea
              class="settings-input"
              rows={2}
              value={choices()?.description ?? ""}
              onInput={(event) => {
                const current = choices();
                if (current) {
                  props.flow.updateChoices({ ...current, description: event.currentTarget.value });
                }
              }}
            />
          </label>
        </div>
        <section class="claw-creator__section">
          <h3>{t("clawsDraft.behavior")}</h3>
          <details class="claw-creator__summary">
            <summary>{review().scope.job}</summary>
            <dl>
              <dt>{t("clawsDraft.input")}</dt>
              <dd>{review().scope.input}</dd>
              <dt>{t("clawsDraft.output")}</dt>
              <dd>{review().scope.output}</dd>
              <dt>{t("clawsDraft.authority")}</dt>
              <dd>{review().scope.authority}</dd>
            </dl>
          </details>
        </section>
        <For each={sections}>
          {([kind, titleKey]) => (
            <OptionalSection
              flow={props.flow}
              view={props.view}
              kind={kind}
              title={t(titleKey)}
              publishing={busy()}
            />
          )}
        </For>
        <section class="claw-creator__section">
          <h3>
            {t("clawsDraft.packageContents")} <span>{review().files.length}</span>
          </h3>
          <p>{t("clawsDraft.packageNote")}</p>
          <Show when={state().reviewCurrent}>
            <For each={review().files} keyed={(file) => file.path}>
              {(file) => (
                <details class="claw-creator__archive-file">
                  <summary>{file().path}</summary>
                  <pre>{file().content}</pre>
                </details>
              )}
            </For>
          </Show>
        </section>
        <Show when={state().error}>
          {(error) => (
            <p class="callout danger" role="alert">
              {error()}
            </p>
          )}
        </Show>
        <Show when={!state().reviewCurrent}>
          <Loading
            on={props.reviewReceipt}
            fallback={
              <p role="status" class="claw-creator__status">
                {t("clawsDraft.updating")}
              </p>
            }
          >
            <Errored
              fallback={
                <p role="status" class="claw-creator__status">
                  {t("clawsDraft.reviewNeeded")}
                </p>
              }
            >
              {props.reviewRead()}
              <p role="status" class="claw-creator__status">
                {t("clawsDraft.reviewNeeded")}
              </p>
            </Errored>
          </Loading>
        </Show>
        <openclaw-modal-actions>
          <button type="button" class="btn" onClick={() => props.flow.close()}>
            {t("clawsDraft.askChanges")}
          </button>
          <Show when={!state().reviewCurrent && state().busy === null}>
            <button type="button" class="btn" onClick={() => props.flow.retryReview()}>
              {t("clawsDraft.refreshReview")}
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
            {t(busy() ? "clawsDraft.publishing" : "clawsDraft.publish")}
          </button>
        </openclaw-modal-actions>
      </div>
    </openclaw-modal-dialog>
  );
}

export function ClawCreatorReview(props: { context: ApplicationContext }) {
  const current = createMemo(() => {
    const flow = clawCreatorFlow(props.context);
    return { flow, view: projectOwner(flow, (owner) => owner) };
  });
  const flow = () => current().flow;
  const view = () => current().view;
  const reviewReceipt = createMemo(() => view().read().reviewRead);
  const reviewRead = createMemo(async () => {
    await reviewReceipt()?.result;
    return null;
  });
  onSettled(() => {
    const context = props.context;
    const owner = clawCreatorFlow(context);
    const pathname = context.router.getState().location.pathname;
    return context.router.subscribe(() => {
      if (context.router.getState().location.pathname !== pathname) {
        owner.retirePresentation();
      }
    });
  });
  return (
    <>
      <Show when={view().read().modalOpen && view().read().review}>
        <ClawReviewDialog
          flow={flow()}
          view={view()}
          reviewRead={reviewRead}
          reviewReceipt={reviewReceipt()}
        />
      </Show>
      <Show
        when={
          view().read().hasActiveDraft &&
          !view().read().modalOpen &&
          !view().read().publication &&
          view().read().error
        }
      >
        {(error) => (
          <div class="claw-creator__notice claw-creator__notice--error" role="alert">
            {error()}
            <button class="btn btn--sm" onClick={() => flow().retryReview()}>
              {t("clawsDraft.retryReview")}
            </button>
          </div>
        )}
      </Show>
      <Show
        when={
          view().read().review &&
          !view().read().modalOpen &&
          !view().read().publication &&
          !view().read().error
        }
      >
        <button class="claw-creator__reopen btn btn--sm" onClick={() => flow().reopen()}>
          {t("clawsDraft.reopen")}
        </button>
      </Show>
    </>
  );
}
