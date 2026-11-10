import { createMemo, createSignal, Errored, For, Loading, Show } from "solid-js";
import {
  FilePreviewDocument,
  filePreviewDocumentLink,
} from "../../components/file-preview-document.tsx";
import { Icon, type IconName } from "../../components/solid/icon.tsx";
import { InlineAlert } from "../../components/solid/inline-alert.tsx";
import { formatUiError } from "../../lib/format-error.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { createPendingFocus } from "../../lib/reactive/pending-focus.ts";
import { TemplateArtwork } from "./template-artwork.tsx";
import type { TemplatesCatalogViewProps } from "./templates-catalog-view-props.ts";
import { TemplateAddFeedback } from "./templates-detail-view.tsx";
import "../../styles/template-preview.css";
import { TemplateWorkspaceFiles } from "./templates-workspace-files.tsx";

type Category = "instructions" | "skills" | "integrations" | "automations";
const categories: Array<{ key: Category; labelKey: string; icon: IconName }> = [
  { key: "instructions", labelKey: "workspaceFiles", icon: "fileText" },
  { key: "skills", labelKey: "skillsSection", icon: "book" },
  { key: "integrations", labelKey: "integrations", icon: "plug" },
  { key: "automations", labelKey: "automations", icon: "clock" },
];

/** Presentation-only navigation over the catalog's existing read, consent and Add owner. */
export function TemplatePreviewView(props: { view: TemplatesCatalogViewProps }) {
  const [category, setCategory] = createSignal<Category | null>(null);
  const [selectedName, setSelectedName] = createSignal<string | null>(null);
  const [allFiles, setAllFiles] = createSignal(false);
  const identity = () => props.view.detail ?? props.view.selected;
  const contents = () => props.view.readDetail()?.contents;
  const items = (key: Category) => contents()?.[key] ?? [];
  const categoryLabel = () =>
    t("templatesCatalog." + categories.find((item) => item.key === category())?.labelKey);
  const selected = createMemo(() => {
    const key = category();
    return key
      ? props.view.detail?.contents[key].find((item) => item.name === selectedName())
      : undefined;
  });
  const title = () =>
    selectedName() ??
    (category()
      ? categoryLabel()
      : (props.view.detail?.agentName ?? identity()?.displayName ?? t("templatesCatalog.review")));
  let heading: HTMLHeadingElement | undefined;
  let body: HTMLDivElement | undefined;
  createPendingFocus(() => [category(), selectedName(), allFiles()], {
    requested: (_next, previous) => Boolean(previous),
    focus: () => {
      body?.scrollTo(0, 0);
      heading?.focus({ preventScroll: true });
    },
  });
  function back() {
    if (selectedName()) {
      props.view.onClosePreview?.();
      setSelectedName(null);
    } else if (allFiles()) {
      setAllFiles(false);
    } else {
      setCategory(null);
    }
  }
  function open(name: string) {
    setSelectedName(name);
    if (category() === "instructions" || category() === "skills") {
      props.view.onOpenPreview(category() === "instructions" ? "instruction" : "skill", name);
    }
  }
  const description = () => {
    const item = selected();
    return item && "excerpt" in item ? item.excerpt : undefined;
  };
  const metadata = () => {
    const item = selected();
    if (!item) {
      return "";
    }
    if ("schedule" in item) {
      return item.schedule + " · " + item.timezone;
    }
    if ("kind" in item) {
      return (
        (item.kind === "plugin" ? t("tabs.plugin") : t("tabs.mcp")) +
        (item.version ? " · " + item.version : "")
      );
    }
    return "";
  };
  return (
    <section class="template-preview">
      <header
        class={[
          "template-preview__header",
          { "template-preview__header--detail": Boolean(category()) },
        ]}
      >
        <Show
          when={category()}
          fallback={
            <span class="template-preview__art">
              <TemplateArtwork src={identity()?.iconUrl} />
            </span>
          }
        >
          <button
            type="button"
            class="btn btn--icon"
            aria-label={
              selectedName() || allFiles()
                ? t("templatesCatalog.backToCategory", { category: categoryLabel() })
                : t("templatesCatalog.backToTemplate")
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
            <Show when={identity()}>
              <p class="muted">
                {t("templatesCatalog.byCreator", { creator: "@" + identity()!.ownerHandle })}
              </p>
            </Show>
            <p>{props.view.detail?.agentDescription ?? identity()?.summary}</p>
          </Show>
        </div>
        <button
          type="button"
          class="btn btn--icon"
          aria-label={t("common.close")}
          disabled={props.view.applying}
          onClick={() => props.view.onBack()}
        >
          <Icon name="x" />
        </button>
      </header>
      <div ref={(element) => (body = element)} class="template-preview__body">
        <For each={[props.view.detailRequest ?? props.view.catalogRequest]}>
          {() => (
            <Errored
              fallback={(error) => (
                <InlineAlert tone="danger" role="alert">
                  {formatUiError(error())}
                  <button
                    type="button"
                    class="btn"
                    onClick={() =>
                      props.view.selected ? props.view.onRetryDetail() : props.view.onRetryCatalog()
                    }
                  >
                    {t("common.retry")}
                  </button>
                </InlineAlert>
              )}
            >
              <Loading
                fallback={
                  <p class="template-preview__loading" role="status">
                    {t("templatesCatalog.contentsLoading")}
                  </p>
                }
              >
                <Show when={props.view.readEntries().length === 0}>
                  <span />
                </Show>
                <Show when={contents()}>
                  <Show
                    when={category()}
                    fallback={
                      <div class="template-preview__contents">
                        <For each={categories}>
                          {(item) => (
                            <button
                              type="button"
                              class="template-preview__row"
                              onClick={() => setCategory(item.key)}
                            >
                              <Icon name={item.icon} />
                              <span>
                                <strong>{t("templatesCatalog." + item.labelKey)}</strong>
                                <small>
                                  {items(item.key)
                                    .map((entry) => entry.name)
                                    .join(", ") || t("templatesCatalog.noneIncluded")}
                                </small>
                              </span>
                              <span class="template-preview__count">
                                {contents()![item.key].length}
                              </span>
                              <Icon name="chevronRight" />
                            </button>
                          )}
                        </For>
                      </div>
                    }
                  >
                    <Show
                      when={selectedName()}
                      fallback={
                        <Show
                          when={category() === "instructions" && !allFiles()}
                          fallback={
                            <div class="template-preview__list">
                              <For
                                each={category() ? contents()![category()!] : []}
                                fallback={<p class="muted">{t("templatesCatalog.noneIncluded")}</p>}
                              >
                                {(item) => (
                                  <button
                                    type="button"
                                    class="template-preview__row"
                                    onClick={() => open(item.name)}
                                  >
                                    <span>
                                      <strong>{item.name}</strong>
                                      <small>
                                        {"excerpt" in item
                                          ? item.excerpt
                                          : "schedule" in item
                                            ? item.schedule + " · " + item.timezone
                                            : "version" in item
                                              ? item.version
                                              : ""}
                                      </small>
                                    </span>
                                    <Icon name="chevronRight" />
                                  </button>
                                )}
                              </For>
                            </div>
                          }
                        >
                          <Show
                            when={contents()!.instructions.length}
                            fallback={<p class="muted">{t("templatesCatalog.noneIncluded")}</p>}
                          >
                            <TemplateWorkspaceFiles
                              files={contents()!.instructions}
                              onOpen={(name) => (name ? open(name) : setAllFiles(true))}
                            />
                          </Show>
                        </Show>
                      }
                    >
                      <div class="template-preview__detail">
                        <h3>{t("templatesCatalog.description")}</h3>
                        <p>{description() || "—"}</p>
                        <h3>{t("templatesCatalog.content")}</h3>
                        <Show
                          when={props.view.preview}
                          fallback={<p>{metadata() || t("templatesCatalog.noneIncluded")}</p>}
                        >
                          <For each={[props.view.preview?.request]}>
                            {() => (
                              <Errored
                                fallback={(error) => (
                                  <InlineAlert tone="danger" role="alert">
                                    {formatUiError(error())}
                                    <button
                                      type="button"
                                      class="btn"
                                      onClick={() => open(selectedName()!)}
                                    >
                                      {t("common.retry")}
                                    </button>
                                  </InlineAlert>
                                )}
                              >
                                <Loading fallback={<p role="status">{t("common.loading")}</p>}>
                                  {props.view.readPreview?.()}
                                  <FilePreviewDocument
                                    path={category() === "skills" ? "SKILL.md" : selectedName()!}
                                    content={props.view.preview?.content ?? ""}
                                    markdown
                                    onClick={(event) => {
                                      const path = filePreviewDocumentLink(event, selectedName()!);
                                      if (
                                        category() === "instructions" &&
                                        items("instructions").some((file) => file.name === path)
                                      ) {
                                        open(path!);
                                      }
                                    }}
                                  />
                                </Loading>
                              </Errored>
                            )}
                          </For>
                        </Show>
                      </div>
                    </Show>
                  </Show>
                </Show>
              </Loading>
            </Errored>
          )}
        </For>
        <TemplateAddFeedback view={props.view} />
      </div>
      <footer class="template-preview__footer">
        <openclaw-modal-actions>
          <button
            type="button"
            class="btn primary"
            data-templates-confirm
            disabled={
              !props.view.canAdd ||
              !props.view.detail ||
              props.view.applying ||
              Boolean(props.view.consentWarning || props.view.reviewPlan)
            }
            onClick={() => void props.view.onConfirm()}
          >
            {t(props.view.applying ? "templatesCatalog.adding" : "templatesCatalog.add")}
          </button>
        </openclaw-modal-actions>
      </footer>
    </section>
  );
}
