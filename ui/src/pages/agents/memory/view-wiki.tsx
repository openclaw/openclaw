import type { JSX } from "@solidjs/web";
import { createMemo, For, Show, untrack } from "solid-js";
import "../../../components/modal-dialog.ts";
import { i18n } from "../../../i18n/index.ts";
import { formatUiError } from "../../../lib/format-error.ts";
import { pathDisplayName } from "../../../lib/path-display.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import type { WikiImportInsights, WikiOverview } from "./dreaming.ts";
import { DiaryEmpty, DreamingAction, formatCompactDateTime } from "./view-shared.tsx";
import type { DreamingProps, DreamingViewState } from "./view-types.ts";

function formatWikiCount(
  kind: "page" | "claimRow" | "openQuestion" | "contradiction",
  count: number,
): string {
  return t(`dreaming.wiki.counts.${kind}${count === 1 ? "One" : "s"}`, { count: String(count) });
}

const WIKI_OVERVIEW_PAGE_GROUPS = [
  ["source", "sources"],
  ["synthesis", "syntheses"],
  ["report", "reports"],
  ["entity", "entities"],
  ["concept", "concepts"],
] as const;

function formatWikiOverviewPageBreakdown(pageCounts: WikiOverview["pageCounts"]): string {
  const parts = WIKI_OVERVIEW_PAGE_GROUPS.map(([kind, group]) => {
    const count = pageCounts[kind];
    return count > 0
      ? t("dreaming.wiki.pageGroupSummary", {
          label: t(`dreaming.wiki.pageGroups.${group}`),
          count: formatWikiCount("page", count),
        })
      : null;
  }).filter((entry): entry is string => entry !== null);
  return parts.length > 0 ? parts.join("; ") : t("dreaming.wiki.noPagesYet");
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

function toggleExpandedCard(bucket: Set<string>, key: string, onChange: () => void): void {
  if (bucket.has(key)) {
    bucket.delete(key);
  } else {
    bucket.add(key);
  }
  onChange();
}

async function openWikiPreview(lookup: string, props: DreamingProps): Promise<void> {
  const state = untrack(() => props.viewState);
  const request: NonNullable<DreamingViewState["wikiPreview"]> = {
    page: { title: pathDisplayName(lookup), path: lookup, content: "" },
    loading: true,
    error: null,
  };
  state.wikiPreview = request;
  props.onViewStateChange();
  try {
    const preview = await props.onOpenWikiPage(lookup);
    if (state.wikiPreview !== request) {
      return;
    }
    if (!preview) {
      request.error = t("dreaming.wiki.pageNotFound", { lookup });
      return;
    }
    request.page = { ...preview };
  } catch (error) {
    if (state.wikiPreview === request) {
      request.error = formatUiError(error);
    }
  } finally {
    if (state.wikiPreview === request) {
      request.loading = false;
      props.onViewStateChange();
    }
  }
}

function closeWikiPreview(props: DreamingProps): void {
  props.viewState.wikiPreview = null;
  props.onViewStateChange();
}

export function renderWikiPreviewOverlay(props: DreamingProps) {
  const preview = createMemo(() => props.viewState.wikiPreview);
  return (
    <Show when={preview()} keyed>
      {(request) => {
        const current = () => props.viewState.wikiPreview ?? request;
        const updatedAtLabel = () => {
          const updatedAt = current().page.updatedAt;
          return updatedAt ? ` · ${formatCompactDateTime(updatedAt)}` : "";
        };
        return (
          <openclaw-modal-dialog
            label={current().page.title || t("dreaming.wiki.previewFallbackTitle")}
            style="--openclaw-modal-width: 1120px"
            onModal-cancel={() => closeWikiPreview(props)}
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
                <button
                  type="button"
                  class="btn btn--subtle btn--sm"
                  onClick={() => closeWikiPreview(props)}
                >
                  {t("dreaming.wiki.close")}
                </button>
              </div>
              <div class="dreams-diary__preview-body">
                {current().loading ? (
                  <div class="dreams-diary__empty-text">{t("dreaming.wiki.loadingPage")}</div>
                ) : current().error ? (
                  <div class="dreams-diary__error">{current().error}</div>
                ) : (
                  <>
                    {current().page.truncated === true ? (
                      <div class="dreams-diary__preview-hint">
                        {current().page.totalLines != null
                          ? t("dreaming.wiki.previewTruncatedWithTotal", {
                              count: String(current().page.totalLines),
                            })
                          : t("dreaming.wiki.previewTruncated")}
                      </div>
                    ) : undefined}
                    <pre class="dreams-diary__preview-pre">{current().page.content}</pre>
                  </>
                )}
              </div>
            </div>
          </openclaw-modal-dialog>
        );
      }}
    </Show>
  );
}

type ImportedInsightItem = WikiImportInsights["clusters"][number]["items"][number];

type WikiPageItem = WikiOverview["clusters"][number]["items"][number];

type WikiInsightCard =
  | { kind: "import"; item: ImportedInsightItem }
  | { kind: "wiki"; item: WikiPageItem };

function renderInsightList(labelKey: string, entries: string[]) {
  return entries.length > 0 ? (
    <div class="dreams-diary__insight-list">
      <strong>{t(labelKey)}</strong>
      <For each={entries} keyed={false}>
        {(entry) => <p class="dreams-diary__insight-line">• {entry()}</p>}
      </For>
    </div>
  ) : undefined;
}

function renderInsightDetail(labelKey: string, value: string | undefined) {
  return value ? (
    <p class="dreams-diary__insight-line">
      <strong>{t(labelKey)}</strong>
      {value}
    </p>
  ) : undefined;
}

function renderWikiInsightBody(card: WikiInsightCard, expanded: boolean) {
  if (card.kind === "import") {
    const item = card.item;
    return (
      <>
        <p class="dreams-diary__insight-line">{item.summary}</p>
        {renderInsightList("dreaming.wiki.candidateSignals", item.candidateSignals)}
        {renderInsightList("dreaming.wiki.corrections", item.correctionSignals)}
        {expanded ? (
          <div class="dreams-diary__insight-list">
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
        ) : undefined}
        {item.preferenceSignals.length > 0 ? (
          <div class="dreams-diary__insight-signals">
            <For each={item.preferenceSignals} keyed={false}>
              {(signal) => <span class="dreams-diary__insight-signal">{signal()}</span>}
            </For>
          </div>
        ) : undefined}
      </>
    );
  }

  const item = card.item;
  return (
    <>
      {item.snippet ? <p class="dreams-diary__insight-line">{item.snippet}</p> : undefined}
      {renderInsightList("dreaming.wiki.claims", item.claims)}
      {renderInsightList("dreaming.wiki.openQuestions", item.questions)}
      {renderInsightList("dreaming.wiki.contradictions", item.contradictions)}
      {expanded ? (
        <div class="dreams-diary__insight-list">
          <strong>{t("dreaming.wiki.pageDetails")}</strong>
          {renderInsightDetail("dreaming.wiki.wikiPage", item.pagePath)}
          {renderInsightDetail("dreaming.wiki.id", item.id)}
        </div>
      ) : undefined}
    </>
  );
}

function WikiInsightCard(props: { owner: DreamingProps; card: WikiInsightCard }) {
  const owner = untrack(() => props.owner);
  const state = untrack(() => owner.viewState);
  const item = () => props.card.item;
  const expandedCards = () =>
    props.card.kind === "import" ? state.expandedInsightCards : state.expandedWikiCards;
  const expanded = createMemo(() => expandedCards().has(item().pagePath));
  const badgeClass = () => {
    const card = props.card;
    return card.kind === "import" ? card.item.riskLevel : "wiki";
  };
  const badgeLabel = () => {
    const card = props.card;
    return card.kind === "import"
      ? t(
          card.item.digestStatus === "withheld"
            ? "dreaming.wiki.risk.needsReview"
            : `dreaming.wiki.risk.${card.item.riskLevel}`,
        )
      : t(`dreaming.wiki.pageTypes.${card.item.kind}`);
  };
  const metadata = () => {
    const card = props.card;
    return card.kind === "import"
      ? card.item.activeBranchMessages > 0
        ? ` · ${t("dreaming.wiki.counts.messages", { count: String(card.item.activeBranchMessages) })}`
        : ""
      : ` · ${card.item.pagePath}`;
  };
  return (
    <article
      class="dreams-diary__insight-card dreams-diary__insight-card--clickable"
      data-import-page={props.card.kind === "import" ? item().pagePath : undefined}
      data-wiki-page={props.card.kind === "wiki" ? item().pagePath : undefined}
      onClick={() => {
        const card = props.card;
        if (card.kind === "wiki" && card.item.kind === "report") {
          void openWikiPreview(card.item.pagePath, owner);
          return;
        }
        toggleExpandedCard(expandedCards(), item().pagePath, owner.onViewStateChange);
      }}
    >
      <div class="dreams-diary__insight-topline">
        <div class="dreams-diary__insight-title">{item().title}</div>
        <span class={`dreams-diary__insight-badge dreams-diary__insight-badge--${badgeClass()}`}>
          {badgeLabel()}
        </span>
      </div>
      <div class="dreams-diary__insight-meta">
        {item().updatedAt
          ? formatCompactDateTime(item().updatedAt!)
          : pathDisplayName(item().pagePath)}
        {metadata()}
      </div>
      {renderWikiInsightBody(props.card, expanded())}
      <div class="dreams-diary__insight-actions">
        <DreamingAction
          label={t(expanded() ? "dreaming.wiki.hideDetails" : "dreaming.wiki.details")}
          disabled={false}
          onClick={(event) => {
            event.stopPropagation();
            toggleExpandedCard(expandedCards(), item().pagePath, owner.onViewStateChange);
          }}
        />
        <DreamingAction
          label={t(
            props.card.kind === "import"
              ? "dreaming.wiki.openSourcePage"
              : "dreaming.wiki.openWikiPage",
          )}
          disabled={false}
          onClick={(event) => {
            event.stopPropagation();
            void openWikiPreview(item().pagePath, owner);
          }}
        />
      </div>
    </article>
  );
}

function WikiClusterArticle(props: {
  date: string;
  truncated: boolean;
  returnedItems: number;
  totalItems: number;
  prose: JSX.Element;
  children: JSX.Element;
}) {
  return (
    <article class="dreams-diary__entry">
      <div class="dreams-diary__accent" />
      <div class="dreams-diary__date">{props.date}</div>
      <Show when={props.truncated}>
        <p class="dreams-diary__para dreams-diary__bounded-result">
          {t("dreaming.wiki.boundedResults", {
            returned: props.returnedItems.toLocaleString(i18n.getLocale()),
            total: props.totalItems.toLocaleString(i18n.getLocale()),
          })}
        </p>
      </Show>
      <div class="dreams-diary__prose">{props.prose}</div>
      <div class="dreams-diary__insights">{props.children}</div>
    </article>
  );
}

export function ImportedInsightsContent(props: {
  owner: DreamingProps;
  data: WikiImportInsights | null;
  selectedPage: number;
  loading: boolean;
}) {
  const cluster = createMemo(() => props.data?.clusters[props.selectedPage]);
  const returnedItems = createMemo(
    () => props.data?.clusters.reduce((total, item) => total + item.itemCount, 0) ?? 0,
  );
  const date = (current: WikiImportInsights["clusters"][number]) => {
    const metadata = [
      t("dreaming.wiki.counts.chats", { count: String(current.itemCount) }),
      ...(current.highRiskCount > 0
        ? [t("dreaming.wiki.counts.sensitive", { count: String(current.highRiskCount) })]
        : []),
      ...(current.preferenceSignalCount > 0
        ? [t("dreaming.wiki.counts.signals", { count: String(current.preferenceSignalCount) })]
        : []),
    ];
    return `${current.label} · ${metadata.join(" · ")}`;
  };
  const summary = (current: WikiImportInsights["clusters"][number]) =>
    [
      t("dreaming.wiki.importedClusterSummary", { label: current.label.toLowerCase() }),
      ...(current.withheldCount > 0
        ? [
            t(
              current.withheldCount === 1
                ? "dreaming.wiki.withheldDigestOne"
                : "dreaming.wiki.withheldDigests",
              { count: String(current.withheldCount) },
            ),
          ]
        : []),
    ].join(" ");
  return (
    <Show
      when={cluster()}
      fallback={
        <DiaryEmpty
          message={t(props.loading ? "dreaming.wiki.loadingInsights" : "dreaming.wiki.noInsights")}
          hint={props.loading ? undefined : t("dreaming.wiki.noInsightsHint")}
        />
      }
    >
      {(current) => (
        <WikiClusterArticle
          date={date(current())}
          truncated={props.data?.truncated ?? false}
          returnedItems={returnedItems()}
          totalItems={props.data?.totalItems ?? 0}
          prose={<p class="dreams-diary__para">{summary(current())}</p>}
        >
          <For each={current().items} keyed={(item) => item.pagePath}>
            {(item) => (
              <WikiInsightCard owner={props.owner} card={{ kind: "import", item: item() }} />
            )}
          </For>
        </WikiClusterArticle>
      )}
    </Show>
  );
}

export function WikiOverviewContent(props: {
  owner: DreamingProps;
  data: WikiOverview | null;
  selectedPage: number;
  loading: boolean;
}) {
  const cluster = createMemo(() => props.data?.clusters[props.selectedPage]);
  const returnedItems = createMemo(
    () => props.data?.clusters.reduce((total, item) => total + item.itemCount, 0) ?? 0,
  );
  const date = () => {
    const metadata = (
      [
        ["page", props.data?.totalPages ?? 0],
        ["claimRow", props.data?.totalClaims ?? 0],
        ["openQuestion", props.data?.totalQuestions ?? 0],
        ["contradiction", props.data?.totalContradictions ?? 0],
      ] as const
    )
      .filter(([kind, count]) => kind === "page" || count > 0)
      .map(([kind, count]) => formatWikiCount(kind, count));
    return `${t("dreaming.wiki.vault")} · ${metadata.join(" · ")}`;
  };
  return (
    <Show
      when={cluster()}
      fallback={
        <DiaryEmpty
          message={t(props.loading ? "dreaming.wiki.loadingWiki" : "dreaming.wiki.emptyWiki")}
          hint={props.loading ? undefined : t("dreaming.wiki.emptyWikiHint")}
        />
      }
    >
      {(current) => (
        <WikiClusterArticle
          date={date()}
          truncated={props.data?.truncated ?? false}
          returnedItems={returnedItems()}
          totalItems={props.data?.totalItems ?? 0}
          prose={
            <>
              <p class="dreams-diary__para">
                {t("dreaming.wiki.fullVaultBreakdown", {
                  breakdown: props.data
                    ? formatWikiOverviewPageBreakdown(props.data.pageCounts)
                    : t("dreaming.wiki.noPagesYet"),
                })}
              </p>
              <p class="dreams-diary__para">
                {t("dreaming.wiki.selectedSection", {
                  summary: formatWikiOverviewClusterSummary(current()),
                })}
                {current().updatedAt
                  ? ` ${t("dreaming.wiki.latestUpdate", { date: formatCompactDateTime(current().updatedAt!) })}`
                  : ""}
              </p>
            </>
          }
        >
          <For each={current().items} keyed={(item) => item.pagePath}>
            {(item) => (
              <WikiInsightCard owner={props.owner} card={{ kind: "wiki", item: item() }} />
            )}
          </For>
        </WikiClusterArticle>
      )}
    </Show>
  );
}
