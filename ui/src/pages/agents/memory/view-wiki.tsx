import type { JSX } from "@solidjs/web";
import { createMemo, Errored, For, Loading, Show } from "solid-js";
import "../../../components/modal-dialog.tsx";
import { Icon } from "../../../components/solid/icon.tsx";
import { SettingsStatus } from "../../../components/solid/settings-ui.tsx";
import { i18n } from "../../../i18n/index.ts";
import { formatUiError } from "../../../lib/format-error.ts";
import { pathDisplayName } from "../../../lib/path-display.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import type { WikiImportInsights, WikiOverview } from "./dreaming.ts";
import { DiaryEmpty, formatCompactDateTime } from "./view-shared.tsx";
import type { DreamingProps } from "./view-types.ts";

function formatWikiCount(
  kind: "page" | "claimRow" | "openQuestion" | "contradiction",
  count: number,
): string {
  return t(`dreaming.wiki.counts.${kind}${count === 1 ? "One" : "s"}`, { count: String(count) });
}

function formatImportCount(kind: "chat" | "signal", count: number): string {
  return t(`dreaming.wiki.counts.${kind}${count === 1 ? "One" : "s"}`, { count: String(count) });
}

function formatWikiOverviewClusterSummary(cluster: WikiOverview["clusters"][number]): string {
  const parts = [
    t("dreaming.wiki.sectionPageSummary", {
      label: cluster.label,
      count: formatWikiCount("page", cluster.itemCount),
    }),
  ];
  if (cluster.claimCount > 0) {
    parts.push(formatWikiCount("claimRow", cluster.claimCount));
  }
  if (cluster.questionCount > 0) {
    const questionPageCount = cluster.items.filter((item) => item.questionCount > 0).length;
    const questionCount = formatWikiCount("openQuestion", cluster.questionCount);
    parts.push(
      questionPageCount > 0
        ? t("dreaming.wiki.questionCountOnPages", {
            questionCount,
            pageCount: formatWikiCount("page", questionPageCount),
          })
        : questionCount,
    );
  }
  if (cluster.contradictionCount > 0) {
    parts.push(formatWikiCount("contradiction", cluster.contradictionCount));
  }
  return parts.join(" · ");
}

export function WikiPreviewOverlay(props: DreamingProps) {
  const preview = createMemo(() => props.wikiPreview?.request);
  return (
    <Show when={preview()} keyed>
      {(request) => {
        const current = () => props.wikiPreview ?? request;
        const readScope = createMemo(() => props.wikiPreview?.readKey);
        const updatedAtLabel = () => {
          const updatedAt = current().page.updatedAt;
          return updatedAt ? ` · ${formatCompactDateTime(updatedAt)}` : "";
        };
        return (
          <openclaw-modal-dialog
            label={current().page.title || t("dreaming.wiki.previewFallbackTitle")}
            style="--openclaw-modal-width: 1120px"
            onModal-cancel={() => props.onCloseWikiPreview()}
          >
            <div class="dreams-diary__preview-panel">
              <div class="dreams-diary__preview-header">
                <div>
                  <div class="dreams-diary__preview-title">
                    {current().page.title || t("dreaming.wiki.previewFallbackTitle")}
                  </div>
                  <div class="dreams-diary__preview-meta">
                    {current().page.path} {updatedAtLabel()}
                  </div>
                </div>
              </div>
              <div class="dreams-diary__preview-body">
                <Errored
                  fallback={(error) => (
                    <div class="dreams-diary__error">{formatUiError(error())}</div>
                  )}
                >
                  <Loading
                    on={readScope()}
                    fallback={
                      <div class="dreams-diary__empty-text">{t("dreaming.wiki.loadingPage")}</div>
                    }
                  >
                    <Show when={props.wikiPreview?.readPage()}>
                      {(page) => (
                        <>
                          {page().truncated === true ? (
                            <div class="dreams-diary__preview-hint">
                              {page().totalLines != null
                                ? t("dreaming.wiki.previewTruncatedWithTotal", {
                                    count: String(page().totalLines),
                                  })
                                : t("dreaming.wiki.previewTruncated")}
                            </div>
                          ) : undefined}
                          <pre class="dreams-diary__preview-pre">{page().content}</pre>
                        </>
                      )}
                    </Show>
                  </Loading>
                </Errored>
              </div>
              <openclaw-modal-actions class="dreams-diary__preview-footer">
                <button
                  type="button"
                  class="btn btn--subtle btn--sm"
                  onClick={() => props.onCloseWikiPreview()}
                >
                  {t("dreaming.wiki.close")}
                </button>
              </openclaw-modal-actions>
            </div>
          </openclaw-modal-dialog>
        );
      }}
    </Show>
  );
}

type WikiInsightCard =
  | { kind: "import"; item: WikiImportInsights["clusters"][number]["items"][number] }
  | { kind: "wiki"; item: WikiOverview["clusters"][number]["items"][number] };

function renderInsightList(labelKey: string, entries: string[]) {
  return entries.length > 0 ? (
    <div class="dreams-review__wiki-list">
      <strong>{t(labelKey)}</strong>
      <ul>
        <For each={entries} keyed={false}>
          {(entry) => <li>{entry()}</li>}
        </For>
      </ul>
    </div>
  ) : undefined;
}

function renderInsightDetail(labelKey: string, value: string | undefined) {
  return value ? (
    <p class="dreams-review__wiki-line">
      <strong>{t(labelKey)}</strong> {value}
    </p>
  ) : undefined;
}

function renderWikiInsightBody(card: WikiInsightCard) {
  if (card.kind === "import") {
    const item = card.item;
    return (
      <>
        {renderInsightList("dreaming.wiki.candidateSignals", item.candidateSignals)}
        {renderInsightList("dreaming.wiki.corrections", item.correctionSignals)}
        {item.preferenceSignals.length > 0 ? (
          <p class="dreams-review__wiki-line">{item.preferenceSignals.join(" · ")}</p>
        ) : undefined}
        <div class="dreams-review__wiki-list">
          <strong>{t("dreaming.wiki.importDetails")}</strong>
          {renderInsightDetail("dreaming.wiki.startedWith", item.firstUserLine)}
          {renderInsightDetail(
            "dreaming.wiki.endedOn",
            item.lastUserLine !== item.firstUserLine ? item.lastUserLine : undefined,
          )}
          {renderInsightDetail(
            "dreaming.wiki.messages",
            `${t("dreaming.wiki.counts.userMessages", {
              count: String(item.userMessageCount),
            })} · ${t("dreaming.wiki.counts.assistantMessages", {
              count: String(item.assistantMessageCount),
            })}`,
          )}
          {renderInsightDetail("dreaming.wiki.riskReasons", item.riskReasons.join(", "))}
          {renderInsightDetail("dreaming.wiki.labels", item.labels.join(", "))}
        </div>
      </>
    );
  }

  const item = card.item;
  return (
    <>
      {renderInsightList("dreaming.wiki.claims", item.claims)}
      {renderInsightList("dreaming.wiki.openQuestions", item.questions)}
      {renderInsightList("dreaming.wiki.contradictions", item.contradictions)}
      <div class="dreams-review__wiki-list">
        <strong>{t("dreaming.wiki.pageDetails")}</strong>
        {renderInsightDetail("dreaming.wiki.wikiPage", item.pagePath)}
        {renderInsightDetail("dreaming.wiki.id", item.id)}
      </div>
    </>
  );
}

/** Title, one-line gist and what needs a look; everything else is one press away. */
function WikiInsightRow(props: { owner: DreamingProps; card: WikiInsightCard }) {
  const owner = () => props.owner;
  const item = () => props.card.item;
  const expandedBucket = () =>
    props.card.kind === "import" ? "expandedInsightCards" : "expandedWikiCards";
  const expanded = createMemo(() => owner().viewState[expandedBucket()][item().pagePath] === true);
  const opensDirectly = () => props.card.kind === "wiki" && props.card.item.kind === "report";
  const gist = () => {
    const card = props.card;
    return card.kind === "import" ? card.item.summary : card.item.snippet;
  };
  const status = () => {
    const card = props.card;
    if (card.kind !== "import") {
      return null;
    }
    return card.item.digestStatus === "withheld"
      ? { kind: "warn" as const, key: "dreaming.wiki.risk.needsReview" }
      : card.item.riskLevel === "high"
        ? { kind: "danger" as const, key: "dreaming.wiki.risk.high" }
        : { kind: "muted" as const, key: `dreaming.wiki.risk.${card.item.riskLevel}` };
  };
  const metadata = () => {
    const card = props.card;
    return [
      item().updatedAt
        ? formatCompactDateTime(item().updatedAt!)
        : pathDisplayName(item().pagePath),
      card.kind === "import" && card.item.activeBranchMessages > 0
        ? t("dreaming.wiki.counts.messages", { count: String(card.item.activeBranchMessages) })
        : null,
    ]
      .filter(Boolean)
      .join(" · ");
  };
  return (
    <article
      class="dreams-review__wiki-item"
      data-import-page={props.card.kind === "import" ? item().pagePath : undefined}
      data-wiki-page={props.card.kind === "wiki" ? item().pagePath : undefined}
    >
      <button
        type="button"
        class="settings-row settings-row--nav dreams-review__row"
        aria-expanded={opensDirectly() ? undefined : expanded() ? "true" : "false"}
        onClick={() => {
          if (opensDirectly()) {
            void owner().onOpenWikiPage(item().pagePath);
            return;
          }
          const bucket = expandedBucket();
          const key = item().pagePath;
          owner().onViewStateChange((draft) => {
            draft[bucket][key] = !draft[bucket][key];
          });
        }}
      >
        <span class="settings-row__text">
          <span class="settings-row__title">{item().title}</span>
          <Show when={gist()}>
            <span class={["settings-row__desc", { "dreams-review__gist": !expanded() }]}>
              {gist()}
            </span>
          </Show>
        </span>
        <span class="settings-row__control">
          <Show when={status()}>
            {(current) => <SettingsStatus kind={current().kind} label={t(current().key)} />}
          </Show>
          <span class="settings-row__chevron">
            <Icon name="chevronRight" />
          </span>
        </span>
      </button>
      <Show when={expanded() && !opensDirectly()}>
        <div class="dreams-review__wiki-detail">
          <p class="dreams-review__meta">{metadata()}</p>
          {renderWikiInsightBody(props.card)}
          <div>
            <button
              type="button"
              class="btn btn--sm"
              onClick={() => void owner().onOpenWikiPage(item().pagePath)}
            >
              {t(
                props.card.kind === "import"
                  ? "dreaming.wiki.openSourcePage"
                  : "dreaming.wiki.openWikiPage",
              )}
            </button>
          </div>
        </div>
      </Show>
    </article>
  );
}

function WikiCluster(props: { heading: string; note?: string; children: JSX.Element }) {
  return (
    <section class="dreams-review__cluster">
      <h3 class="dreams-review__cluster-heading">{props.heading}</h3>
      <Show when={props.note}>
        <p class="dreams-review__meta">{props.note}</p>
      </Show>
      {props.children}
    </section>
  );
}

function BoundedResults(props: { truncated: boolean; returned: number; total: number }) {
  return (
    <Show when={props.truncated}>
      <p class="dreams-review__meta dreams-review__bounded">
        {t("dreaming.wiki.boundedResults", {
          returned: props.returned.toLocaleString(i18n.getLocale()),
          total: props.total.toLocaleString(i18n.getLocale()),
        })}
      </p>
    </Show>
  );
}

export function ImportedInsightsContent(props: {
  owner: DreamingProps;
  data: WikiImportInsights | null;
}) {
  const clusters = () => props.data?.clusters ?? [];
  const returnedItems = createMemo(() =>
    clusters().reduce((total, item) => total + item.itemCount, 0),
  );
  const heading = (current: WikiImportInsights["clusters"][number]) =>
    [
      current.label,
      formatImportCount("chat", current.itemCount),
      ...(current.highRiskCount > 0
        ? [t("dreaming.wiki.counts.sensitive", { count: String(current.highRiskCount) })]
        : []),
      ...(current.preferenceSignalCount > 0
        ? [formatImportCount("signal", current.preferenceSignalCount)]
        : []),
    ].join(" · ");
  const note = (current: WikiImportInsights["clusters"][number]) =>
    current.withheldCount > 0
      ? t(
          current.withheldCount === 1
            ? "dreaming.wiki.withheldDigestOne"
            : "dreaming.wiki.withheldDigests",
          { count: String(current.withheldCount) },
        )
      : undefined;
  return (
    <Show
      when={clusters().length > 0}
      fallback={
        <DiaryEmpty
          message={t("dreaming.wiki.noInsights")}
          hint={t("dreaming.wiki.noInsightsHint")}
        />
      }
    >
      <BoundedResults
        truncated={props.data?.truncated ?? false}
        returned={returnedItems()}
        total={props.data?.totalItems ?? 0}
      />
      <For each={clusters()} keyed={(cluster) => cluster.key}>
        {(cluster) => (
          <WikiCluster heading={heading(cluster())} note={note(cluster())}>
            <For each={cluster().items} keyed={(item) => item.pagePath}>
              {(item) => (
                <WikiInsightRow owner={props.owner} card={{ kind: "import", item: item() }} />
              )}
            </For>
          </WikiCluster>
        )}
      </For>
    </Show>
  );
}

export function WikiOverviewContent(props: { owner: DreamingProps; data: WikiOverview | null }) {
  const clusters = () => props.data?.clusters ?? [];
  const returnedItems = createMemo(() =>
    clusters().reduce((total, item) => total + item.itemCount, 0),
  );
  const vault = () =>
    (
      [
        ["page", props.data?.totalPages ?? 0],
        ["claimRow", props.data?.totalClaims ?? 0],
        ["openQuestion", props.data?.totalQuestions ?? 0],
        ["contradiction", props.data?.totalContradictions ?? 0],
      ] as const
    )
      .filter(([kind, count]) => kind === "page" || count > 0)
      .map(([kind, count]) => formatWikiCount(kind, count))
      .join(" · ");
  return (
    <Show
      when={clusters().length > 0}
      fallback={
        <DiaryEmpty
          message={t("dreaming.wiki.emptyWiki")}
          hint={t("dreaming.wiki.emptyWikiHint")}
        />
      }
    >
      <p class="dreams-review__meta dreams-review__bounded">{vault()}</p>
      <BoundedResults
        truncated={props.data?.truncated ?? false}
        returned={returnedItems()}
        total={props.data?.totalItems ?? 0}
      />
      <For each={clusters()} keyed={(cluster) => cluster.key}>
        {(cluster) => (
          <WikiCluster heading={formatWikiOverviewClusterSummary(cluster())}>
            <For each={cluster().items} keyed={(item) => item.pagePath}>
              {(item) => (
                <WikiInsightRow owner={props.owner} card={{ kind: "wiki", item: item() }} />
              )}
            </For>
          </WikiCluster>
        )}
      </For>
    </Show>
  );
}
