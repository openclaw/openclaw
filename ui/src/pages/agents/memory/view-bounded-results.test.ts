/* @vitest-environment jsdom */

import { render } from "lit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  fullDreamingViewAccess,
  installDreamingViewTestTranslations,
} from "./view.test-helpers.ts";
import { createDreamingViewState, renderDreaming } from "./view.ts";

type DreamingProps = Parameters<typeof renderDreaming>[0];

let restoreTranslations = () => {};

beforeAll(() => {
  restoreTranslations = installDreamingViewTestTranslations();
});

afterAll(() => {
  restoreTranslations();
});

function buildBoundedDashboardProps(tab: "insights" | "wiki"): DreamingProps {
  const viewState = createDreamingViewState();
  viewState.activeSubTab = "diary";
  viewState.activeDiarySubTab = tab;
  // Count every returned item while rendering only the small selected cluster.
  viewState.diaryPage = 1;
  const clusterSizes = [2_499, 1];
  return {
    access: fullDreamingViewAccess,
    viewState,
    active: true,
    selectedAgentId: "main",
    shortTermCount: 0,
    promotedCount: 0,
    shortTermEntries: [],
    promotedEntries: [],
    dreamingOf: null,
    nextCycle: null,
    timezone: null,
    statusError: null,
    modeSaving: false,
    dreamDiaryLoading: false,
    dreamDiaryActionLoading: false,
    dreamDiaryActionMessage: null,
    dreamDiaryActionArchivePath: null,
    dreamDiaryError: null,
    dreamDiaryContent: null,
    memoryWikiEnabled: true,
    wikiImportInsightsLoading: false,
    wikiImportInsightsError: null,
    wikiImportInsights:
      tab === "insights"
        ? {
            sourceType: "chatgpt",
            totalItems: 2_501,
            totalClusters: 2,
            truncated: true,
            clusters: clusterSizes.map((itemCount, clusterIndex) => ({
              key: `topic/example-${clusterIndex}`,
              label: `Example ${clusterIndex}`,
              itemCount,
              highRiskCount: 0,
              withheldCount: 0,
              preferenceSignalCount: 0,
              items: Array.from({ length: itemCount }, (_, index) => ({
                pagePath: `sources/import-${clusterIndex}-${index}.md`,
                title: `Imported chat ${clusterIndex}-${index}`,
                riskLevel: "low" as const,
                riskReasons: [],
                labels: [],
                topicKey: `topic/example-${clusterIndex}`,
                topicLabel: `Example ${clusterIndex}`,
                digestStatus: "available" as const,
                activeBranchMessages: 1,
                userMessageCount: 1,
                assistantMessageCount: 1,
                summary: "Imported summary",
                candidateSignals: [],
                correctionSignals: [],
                preferenceSignals: [],
              })),
            })),
          }
        : null,
    wikiOverviewLoading: false,
    wikiOverviewError: null,
    wikiOverview:
      tab === "wiki"
        ? {
            totalItems: 2_501,
            totalPages: 2_501,
            pageCounts: { synthesis: 2_500, entity: 1, concept: 0, source: 0, report: 0 },
            totalClaims: 0,
            totalQuestions: 0,
            totalContradictions: 0,
            truncated: true,
            clusters: clusterSizes.map((itemCount, clusterIndex) => ({
              key: clusterIndex === 0 ? "synthesis" : "entity",
              label: clusterIndex === 0 ? "Syntheses" : "Entities",
              itemCount,
              claimCount: 0,
              questionCount: 0,
              contradictionCount: 0,
              items: Array.from({ length: itemCount }, (_, index) => ({
                pagePath: `${clusterIndex === 0 ? "syntheses" : "entities"}/page-${index}.md`,
                title: `Memory page ${index}`,
                kind: clusterIndex === 0 ? ("synthesis" as const) : ("entity" as const),
                claimCount: 0,
                questionCount: 0,
                contradictionCount: 0,
                claims: [],
                questions: [],
                contradictions: [],
              })),
            })),
          }
        : null,
    onRefreshDiary: () => {},
    onRefreshImports: () => {},
    onRefreshWikiOverview: () => {},
    onOpenConfig: () => {},
    onOpenWikiPage: async () => null,
    onBackfillDiary: () => {},
    onCopyDreamingArchivePath: () => {},
    onDedupeDreamDiary: () => {},
    onResetDiary: () => {},
    onResetGroundedShortTerm: () => {},
    onRepairDreamingArtifacts: () => {},
    onViewStateChange: () => {},
  };
}

describe("bounded Memory Wiki dashboard results", () => {
  it.each(["insights", "wiki"] as const)("discloses returned and total %s item counts", (tab) => {
    const container = document.createElement("div");
    render(renderDreaming(buildBoundedDashboardProps(tab)), container);

    expect(container.querySelector(".dreams-diary__bounded-result")?.textContent?.trim()).toBe(
      "Showing the newest 2,500 of 2,501 items.",
    );
  });
});
