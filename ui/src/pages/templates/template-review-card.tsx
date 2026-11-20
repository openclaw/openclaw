import type {
  TemplatesDraftsReviewResult,
  TemplateDraftReviewItem,
} from "@openclaw/gateway-protocol";
import type { JSX } from "@solidjs/web";
import { createMemo, createSignal, For, Loading, Show } from "solid-js";
import { Icon, type IconName } from "../../components/solid/icon.tsx";
import { t } from "../../lib/reactive/i18n.ts";
import { createPendingFocus } from "../../lib/reactive/pending-focus.ts";
import { TemplateArtwork } from "../agents-home/template-artwork.tsx";
import { agentDocuments, fileRole } from "../agents-home/template-workspace-file-roles.ts";
import "../../styles/templates-catalog.css";
import { createSessionAutomationSchedule } from "../chat/components/session-automation-schedule-loader.ts";
import { TemplateItemDetails } from "./creator-item-details.tsx";
import type { TemplatePackagePreview } from "./creator-publication.ts";
import "../../components/tooltip.ts";

export type TemplateReviewData = Pick<
  TemplatesDraftsReviewResult,
  "displayName" | "description" | "items"
> & {
  files: Array<{ path: string; content?: string; workspacePaths?: string[] }>;
  iconUrl?: string;
};
type Kind = TemplateDraftReviewItem["kind"];
type ReviewEntry = TemplateDraftReviewItem & { fileIcon?: IconName; contentUnavailable?: boolean };
const sections: Array<{ kind: Kind; key: string; icon: IconName }> = [
  { kind: "file", key: "workspaceFiles", icon: "fileText" },
  { kind: "skill", key: "skills", icon: "sparkles" },
  { kind: "plugin", key: "plugins", icon: "plug" },
  { kind: "mcp", key: "mcpServers", icon: "server" },
  { kind: "automation", key: "automations", icon: "clock" },
];

/** Navigation is local presentation over the exact reviewed archive. It never edits the package. */
export function TemplateReviewCard(props: {
  review: TemplateReviewData;
  byline?: string;
  status?: JSX.Element;
  footer?: JSX.Element;
  itemDetails?: (item: TemplateDraftReviewItem) => JSX.Element;
  readPackagePreview: (item: TemplateDraftReviewItem) => Promise<TemplatePackagePreview | null>;
}) {
  const review = () => props.review;
  const [category, setCategory] = createSignal<Kind | null>(null);
  const [allFiles, setAllFiles] = createSignal(false);
  const [selectedId, setSelectedId] = createSignal<string | null>(null);
  const schedule = createSessionAutomationSchedule();
  const fileEntries = (archive: boolean): ReviewEntry[] =>
    review().files.flatMap((file) =>
      (archive ? [file.path] : (file.workspacePaths ?? [])).map((label) => ({
        id: label,
        kind: "file",
        included: true,
        label,
        detail: file.content ?? "",
        contentUnavailable: file.content === undefined,
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
            <span class="template-art template-package-art template-creator__art">
              <TemplateArtwork src={review().iconUrl} />
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
          <Show when={!category()}>{props.status}</Show>
          <h2 ref={(element) => (heading = element)} tabindex={-1}>
            {title()}
          </h2>
          <Show when={!category()}>
            <Show when={props.byline}>
              <p class="template-creator__byline">{props.byline}</p>
            </Show>
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
                      class="row template-package-row template-creator__row"
                      onClick={() => setCategory(section.kind)}
                    >
                      <span class="template-art template-creator__row-icon">
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
            </div>
          }
        >
          <Show
            when={selected()}
            fallback={
              <div class="template-creator__category">
                <span class="template-art template-creator__category-icon">
                  <Icon name={currentSection().icon} />
                </span>
                <p class="template-creator__hint">{hint()}</p>
                <div class="template-creator__contents stack">
                  <For each={categoryEntries()} keyed={(item) => item.id}>
                    {(item) => (
                      <button
                        type="button"
                        class="row template-package-row template-creator__row"
                        aria-label={item().label}
                        onClick={() => setSelectedId(item().id)}
                      >
                        <Show when={category() === "file"}>
                          <span class="template-art template-creator__row-icon">
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
                      class="row template-package-row template-creator__row"
                      onClick={() => setAllFiles(true)}
                    >
                      <span class="template-art template-creator__row-icon">
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
                <TemplateItemDetails readPackagePreview={props.readPackagePreview} item={item()} />
                {props.itemDetails?.(item())}
              </div>
            )}
          </Show>
        </Show>
      </div>
      <Show when={props.footer}>
        <footer class="template-creator__footer">{props.footer}</footer>
      </Show>
    </section>
  );
}
