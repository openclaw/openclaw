/* @vitest-environment jsdom */

import { createSignal, flush } from "solid-js";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupSolid, mountSolid } from "../../../test-helpers/mount-solid.ts";
import { createDreamingViewState, type DreamingViewState } from "./dreaming.ts";
import {
  renderDreamingView,
  createDreamingViewProps,
  installDreamingViewTestTranslations,
} from "./view.test-helpers.ts";
import { renderDreaming } from "./view.tsx";

type DreamingProps = Parameters<typeof renderDreaming>[0];

let viewState = createDreamingViewState();
const restoreTranslations = installDreamingViewTestTranslations();

afterAll(() => restoreTranslations());
afterEach(() => {
  cleanupSolid();
  vi.restoreAllMocks();
});

const openReviewPanel = (panel: DreamingViewState["openReviewPanel"]) =>
  (viewState.openReviewPanel = panel);

const setDreamAdvancedWaitingSort = (sort: DreamingViewState["advancedWaitingSort"]) =>
  (viewState.advancedWaitingSort = sort);

const baseEntry = {
  path: "memory/2026-04-05.md",
  startLine: 1,
  endLine: 1,
  recallCount: 1,
  dailyCount: 0,
  groundedCount: 0,
  totalSignalCount: 1,
  lightHits: 0,
  remHits: 0,
  phaseHitCount: 0,
};

function buildProps(
  overrides?: Partial<DreamingProps>,
  statusOverrides?: Partial<ReturnType<DreamingProps["readStatusData"]>>,
): DreamingProps {
  const status: ReturnType<DreamingProps["readStatusData"]> = {
    shortTermCount: 47,
    promotedCount: 12,
    phases: {
      light: {
        enabled: true,
        cron: "0 * * * *",
        limit: 20,
        managedCronPresent: true,
        lookbackDays: 2,
        nextRunAtMs: Date.parse("2026-04-05T11:30:00Z"),
      },
      deep: {
        enabled: true,
        cron: "30 * * * *",
        limit: 10,
        managedCronPresent: true,
        minScore: 0,
        minRecallCount: 3,
        minUniqueQueries: 3,
        recencyHalfLifeDays: 14,
        nextRunAtMs: Date.parse("2026-04-05T12:00:00Z"),
      },
      rem: {
        enabled: false,
        cron: "0 4 * * *",
        limit: 10,
        managedCronPresent: false,
        lookbackDays: 7,
        minPatternStrength: 0.75,
      },
    },
    shortTermEntries: [
      {
        key: "memory:memory/2026-04-05.md:1:2",
        path: "memory/2026-04-05.md",
        startLine: 1,
        endLine: 2,
        snippet: "Emma prefers shorter, lower-pressure check-ins.",
        recallCount: 2,
        dailyCount: 1,
        groundedCount: 1,
        totalSignalCount: 3,
        lightHits: 1,
        remHits: 1,
        phaseHitCount: 2,
      },
    ],
    promotedEntries: [
      {
        key: "memory:memory/2026-04-04.md:4:5",
        path: "memory/2026-04-04.md",
        startLine: 4,
        endLine: 5,
        snippet: "Use the Happy Together calendar for flights.",
        recallCount: 3,
        dailyCount: 2,
        groundedCount: 4,
        totalSignalCount: 9,
        lightHits: 0,
        remHits: 0,
        phaseHitCount: 0,
        promotedAt: "2026-04-05T04:00:00.000Z",
      },
    ],
    nextCycle: "4:00 AM",
    timezone: "America/Los_Angeles",
    ...statusOverrides,
  };
  return createDreamingViewProps(viewState, {
    readStatusData: () => status,
    dreamDiaryContent:
      "# Dream Diary\n\n<!-- openclaw:dreaming:diary:start -->\n\n---\n\n*April 5, 2026, 3:00 AM*\n\nThe repository whispered of forgotten endpoints tonight.\n\n<!-- openclaw:dreaming:diary:end -->",
    wikiImportInsights: {
      sourceType: "chatgpt",
      totalItems: 2,
      totalClusters: 2,
      truncated: false,
      clusters: [
        {
          key: "topic/travel",
          label: "Travel",
          itemCount: 1,
          highRiskCount: 0,
          withheldCount: 0,
          preferenceSignalCount: 1,
          items: [
            {
              pagePath: "sources/chatgpt-2026-04-10-alpha.md",
              title: "BA flight receipts process",
              riskLevel: "low",
              riskReasons: [],
              labels: ["domain/personal", "area/travel", "topic/travel"],
              topicKey: "topic/travel",
              topicLabel: "Travel",
              digestStatus: "available",
              activeBranchMessages: 4,
              userMessageCount: 2,
              assistantMessageCount: 2,
              firstUserLine: "how do i get receipts?",
              lastUserLine: "that option does not exist",
              assistantOpener: "Use the BA request-a-receipt flow first.",
              summary: "Use the BA request-a-receipt flow first.",
              candidateSignals: ["prefers direct airline receipts"],
              correctionSignals: [],
              preferenceSignals: ["prefers direct airline receipts"],
              updatedAt: "2026-04-10T10:00:00.000Z",
            },
          ],
        },
        {
          key: "topic/health",
          label: "Health",
          itemCount: 1,
          highRiskCount: 1,
          withheldCount: 1,
          preferenceSignalCount: 0,
          items: [
            {
              pagePath: "sources/chatgpt-2026-04-10-health.md",
              title: "Migraine Medication Advice",
              riskLevel: "high",
              riskReasons: ["health"],
              labels: ["domain/personal", "area/health", "topic/health"],
              topicKey: "topic/health",
              topicLabel: "Health",
              digestStatus: "withheld",
              activeBranchMessages: 2,
              userMessageCount: 1,
              assistantMessageCount: 1,
              summary:
                "Sensitive health chat withheld from durable-memory extraction because it touches health.",
              candidateSignals: [],
              correctionSignals: [],
              preferenceSignals: [],
              updatedAt: "2026-04-11T10:00:00.000Z",
            },
          ],
        },
      ],
    },
    wikiOverview: {
      totalItems: 1,
      totalPages: 2,
      truncated: false,
      pageCounts: {
        synthesis: 1,
        entity: 0,
        concept: 0,
        source: 1,
        report: 0,
      },
      totalClaims: 2,
      totalQuestions: 1,
      totalContradictions: 1,
      clusters: [
        {
          key: "synthesis",
          label: "Syntheses",
          itemCount: 1,
          claimCount: 2,
          questionCount: 1,
          contradictionCount: 1,
          items: [
            {
              pagePath: "syntheses/travel-system.md",
              title: "Travel system",
              kind: "synthesis",
              claimCount: 2,
              questionCount: 1,
              contradictionCount: 1,
              claims: [
                "Mariano prefers direct receipts from airlines when possible.",
                "Travel admin friction keeps showing up across chats.",
              ],
              questions: ["Should flight receipts be standardized into one process?"],
              contradictions: ["Old BA receipts guidance may now be stale."],
              snippet: "Recurring travel admin friction across imported chats.",
              updatedAt: "2026-04-10T10:00:00.000Z",
            },
          ],
        },
      ],
    },
    onCloseWikiPreview: vi.fn(),
    ...overrides,
    onViewStateChange: vi.fn((update) => {
      update(viewState);
      overrides?.onViewStateChange?.(update);
    }),
  });
}

function renderInto(props: DreamingProps): HTMLDivElement {
  const container = document.createElement("div");
  renderDreamingView(props, container);
  return container;
}

function expectElement(container: Element, selector: string): Element {
  const element = container.querySelector(selector);
  expect(element).toBeInstanceOf(Element);
  if (!(element instanceof Element)) {
    throw new Error(`Expected element matching ${selector}`);
  }
  return element;
}

function compactText(node: Element | null): string | undefined {
  return node?.textContent?.trim().replace(/\s+/g, " ");
}

function textItems(container: Element, selector: string): Array<string | undefined> {
  return [...container.querySelectorAll(selector)].map((node) => node.textContent?.trim());
}

describe("dreaming view", () => {
  beforeEach(() => {
    viewState = createDreamingViewState();
  });

  it("retains diary controls and focus across snapshot refreshes", () => {
    const twoEntries =
      "# Dream Diary\n\n---\n\n*April 4, 2026, 3:00 AM*\n\nAn earlier dream.\n\n---\n\n*April 5, 2026, 3:00 AM*\n\nThe repository whispered of forgotten endpoints tonight.";
    const initial = buildProps({ dreamDiaryContent: twoEntries });
    let update!: (next: DreamingProps) => void;
    const { container } = mountSolid(() => {
      const [props, setProps] = createSignal(initial);
      update = setProps;
      return renderDreaming({
        ...initial,
        get viewState() {
          return props().viewState;
        },
        get dreamDiaryContent() {
          return props().dreamDiaryContent;
        },
        readDiary: () => props().dreamDiaryContent,
      });
    });
    flush();
    const diary = expectElement(container, ".dreams-diary");
    const dates = container.querySelector<HTMLSelectElement>(".dreams-diary__dates");
    expect(dates).toBeInstanceOf(HTMLSelectElement);
    dates?.focus();
    expect(document.activeElement).toBe(dates);

    update({
      ...initial,
      viewState: { ...initial.viewState },
      dreamDiaryContent: twoEntries.replace(
        "The repository whispered of forgotten endpoints tonight.",
        "A refreshed dream is still on the same diary day.",
      ),
    });
    flush();

    expect(container.querySelector(".dreams-diary")).toBe(diary);
    expect(container.querySelector(".dreams-diary__dates")).toBe(dates);
    expect(document.activeElement).toBe(dates);
    expect(container.textContent).toContain("A refreshed dream is still on the same diary day.");
  });

  it("renders the dream scene with one control row and no second tab system", () => {
    vi.spyOn(Date, "now").mockReturnValue(0);
    viewState.dreamIndex = 0;
    const onSetEnabled = vi.fn();
    const onRefresh = vi.fn();
    const container = renderInto(buildProps({ onSetEnabled, onRefresh }));

    expectElement(container, ".dreams__lobster svg");

    // The sleeper is the seeded pet cameo: eyes closed, pupils hidden.
    const closedEyes = container.querySelector<SVGGElement>(".dreams__lobster .lob-eye-closed");
    expect(closedEyes?.style.opacity).toBe("1");
    const openEyes = container.querySelector<SVGGElement>(".dreams__lobster .lob-eye-open");
    expect(openEyes?.style.display).toBe("none");
    expect(
      container.querySelector<HTMLElement>(".dreams__lobster")?.getAttribute("style"),
    ).toContain("--lob-shell:");

    expect(textItems(container, ".dreams__z")).toEqual(["z", "z", "Z"]);
    expectElement(container, ".dreams__moon");
    expectElement(container, ".dreams__bubble");
    expect(container.querySelector(".dreams__bubble-text")?.textContent).toBe(
      "consolidating memories…",
    );
    expect(container.querySelector(".hub-tab")).toBeNull();

    // The sweep's order, as words with a state: one next-run time covers all three.
    const phases = [...container.querySelectorAll(".dreams-controls__phase")].map((phase) => ({
      name: compactText(phase),
      off: phase.classList.contains("dreams-controls__phase--off"),
    }));
    expect(phases).toEqual([
      { name: "Light", off: false },
      { name: "REM", off: true },
      { name: "Deep", off: false },
    ]);
    expect(compactText(container.querySelector(".dreams-controls__status"))).toBe(
      "Next sweep 4:00 AM · America/Los_Angeles · 12 promoted today",
    );

    const toggle = container.querySelector<HTMLInputElement>('input[role="switch"]')!;
    expect(toggle.checked).toBe(true);
    toggle.checked = false;
    toggle.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onSetEnabled).toHaveBeenCalledWith(false);
    // The switch waits for the confirmation instead of claiming the change.
    expect(toggle.checked).toBe(true);

    container
      .querySelector(".refresh-button")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onRefresh).toHaveBeenCalledOnce();
  });

  it("renders idle, engine-off, and failed scene states", () => {
    const idleContainer = renderInto(buildProps({ active: false }));
    expect(idleContainer.querySelector(".dreams__bubble")).toBeNull();
    expectElement(idleContainer, ".dreams--idle");
    expect(compactText(idleContainer.querySelector(".dreams-controls__status"))).toBe(
      "Dreaming applies to all agents.",
    );

    const engineOff = renderInto(
      buildProps({
        active: false,
        header: {
          configuredDreaming: {
            pluginId: "memory-core",
            enabled: false,
            overridden: false,
            engineOff: true,
          },
          dreamingOn: false,
          loading: false,
          canUpdateConfig: true,
          refreshLoading: false,
        },
      }),
    );
    expect(compactText(engineOff.querySelector(".dreams-controls__status"))).toBe(
      "Memory engine is off. Choose an engine in Settings to turn on Dreaming.",
    );
    expect(engineOff.querySelector<HTMLInputElement>('input[role="switch"]')?.disabled).toBe(true);

    const unknownPhases = renderInto(buildProps(undefined, { phases: undefined }));
    expect(
      [...unknownPhases.querySelectorAll(".dreams-controls__phase")].map((phase) =>
        phase.classList.contains("dreams-controls__phase--off"),
      ),
    ).toEqual([false, false, false]);

    const errorContainer = renderInto(buildProps({ statusError: "patch failed" }));
    expect(errorContainer.querySelector(".dreams__controls-error")?.textContent?.trim()).toBe(
      "patch failed",
    );
  });

  it("opens one review list at a time from its row", () => {
    const onViewStateChange = vi.fn();
    const container = renderInto(buildProps({ onViewStateChange }));
    const titles = [...container.querySelectorAll(".dreams-review__row .settings-row__title")].map(
      (node) => node.textContent?.trim(),
    );
    expect(titles).toEqual([
      "Waiting for promotion",
      "Recent promotions",
      "From the daily log",
      "Imported insights",
      "Memory wiki",
    ]);
    expect(container.querySelector(".dreams-review__panel")).toBeNull();
    const rows = container.querySelectorAll<HTMLButtonElement>(".dreams-review__row");
    rows[0]?.click();
    expect(viewState.openReviewPanel).toBe("waiting");
    rows[0]?.click();
    expect(viewState.openReviewPanel).toBeNull();
    expect(onViewStateChange).toHaveBeenCalledTimes(2);
  });

  it("lists every imported topic with its rows and what needs a look", () => {
    openReviewPanel("insights");
    const container = renderInto(buildProps());
    expect(textItems(container, ".dreams-review__cluster-heading")).toEqual([
      "Travel · 1 conversation · 1 signal",
      "Health · 1 conversation · 1 sensitive",
    ]);
    const items = container.querySelectorAll("[data-import-page]");
    expect(items[0]?.querySelector(".settings-row__title")?.textContent).toBe(
      "BA flight receipts process",
    );
    expect(compactText(items[0]?.querySelector(".settings-status") ?? null)).toBe("low risk");
    expect(items[0]?.querySelector(".settings-row__desc")?.textContent).toBe(
      "Use the BA request-a-receipt flow first.",
    );
    expect(compactText(items[1]?.querySelector(".settings-status") ?? null)).toBe("needs review");
    expect(container.textContent).toContain("1 digest was withheld pending review.");
    expect(container.textContent).not.toContain("Potentially useful signals");
  });

  it("expands an imported chat into its signals and page action", () => {
    openReviewPanel("insights");
    viewState.expandedInsightCards = { "sources/chatgpt-2026-04-10-alpha.md": true };
    const onOpenWikiPage = vi.fn(async () => {});
    const container = renderInto(buildProps({ onOpenWikiPage }));
    const detail = expectElement(container, ".dreams-review__wiki-detail");
    expect(detail.textContent).toContain("Potentially useful signals");
    expect(detail.textContent).toContain("prefers direct airline receipts");
    expect(detail.textContent).toContain("Import details");
    detail.querySelector<HTMLButtonElement>(".btn")?.click();
    expect(onOpenWikiPage).toHaveBeenCalledWith("sources/chatgpt-2026-04-10-alpha.md");
  });

  it("shows a truncation hint when the wiki preview only contains the first chunk", async () => {
    openReviewPanel("insights");
    viewState.expandedInsightCards = { "sources/chatgpt-2026-04-10-alpha.md": true };
    const container = document.createElement("div");
    const previewPage = {
      title: "BA flight receipts process",
      path: "sources/chatgpt-2026-04-10-alpha.md",
      content: "# ChatGPT Export: BA flight receipts process",
      totalLines: 6001,
      truncated: true,
    };
    const onOpenWikiPage = vi.fn(async () => {});
    const rerender = () => renderDreamingView(props, container);
    const props: DreamingProps = buildProps({
      onOpenWikiPage,
      onViewStateChange: rerender,
    });
    rerender();

    const openSourceButton = container.querySelector<HTMLButtonElement>(
      ".dreams-review__wiki-detail .btn",
    );
    expect(openSourceButton).toBeInstanceOf(HTMLButtonElement);
    if (!(openSourceButton instanceof HTMLButtonElement)) {
      throw new Error("Expected imported source button");
    }
    openSourceButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();

    expect(onOpenWikiPage).toHaveBeenCalledWith("sources/chatgpt-2026-04-10-alpha.md");
    const request = { page: previewPage, source: { read: previewPage } };
    props.wikiPreview = {
      request,
      page: previewPage,
      readKey: request.source,
      readPage: () => previewPage,
    };
    rerender();
    expect(compactText(container.querySelector(".dreams-diary__preview-hint"))).toBe(
      "Showing the first chunk of this page (6001 total lines).",
    );
    expect(container.querySelector("openclaw-modal-dialog")).not.toBeNull();
    expect(container.querySelector(".dreams-diary__preview-backdrop")).toBeNull();

    const closePreviewButton = container.querySelector<HTMLButtonElement>(
      ".dreams-diary__preview-footer .btn",
    );
    expect(closePreviewButton).toBeInstanceOf(HTMLButtonElement);
    expect(container.querySelector(".dreams-diary__preview-header button")).toBeNull();
    expect(
      closePreviewButton?.closest("openclaw-modal-actions")?.parentElement?.lastElementChild,
    ).toBe(closePreviewButton?.closest("openclaw-modal-actions"));
    closePreviewButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(props.onCloseWikiPreview).toHaveBeenCalledOnce();
  });

  it("renders the wiki overview as one vault line and section rows", () => {
    openReviewPanel("wiki");
    const container = renderInto(buildProps());
    expect(compactText(container.querySelector(".dreams-review__bounded"))).toBe(
      "2 pages · 2 claim rows · 1 open question · 1 contradiction",
    );
    expect(compactText(container.querySelector(".dreams-review__cluster-heading"))).toBe(
      "Syntheses: 1 page · 2 claim rows · 1 open question on 1 page · 1 contradiction",
    );
    const item = expectElement(container, "[data-wiki-page='syntheses/travel-system.md']");
    expect(item.querySelector(".settings-row__title")?.textContent).toBe("Travel system");
    expect(item.querySelector(".settings-row__desc")?.textContent).toBe(
      "Recurring travel admin friction across imported chats.",
    );
  });

  it("keeps non-report wiki overview rows on details", () => {
    openReviewPanel("wiki");
    const container = document.createElement("div");
    const rerender = () => renderDreamingView(props, container);
    const props: DreamingProps = buildProps({ onViewStateChange: rerender });
    rerender();

    expectElement(container, "[data-wiki-page='syntheses/travel-system.md'] button").dispatchEvent(
      new MouseEvent("click", { bubbles: true }),
    );

    expect(textItems(container, ".dreams-review__wiki-list > strong")).toContain("Page details");
    expect(textItems(container, ".dreams-review__wiki-list > strong")).toContain("Claims");
  });

  it("opens report wiki overview rows on primary click", async () => {
    openReviewPanel("wiki");
    const previewPage = {
      title: "Weekly stock report",
      path: "reports/weekly-stock.md",
      content: "# Weekly stock report\n\nSummary content.",
      totalLines: 2,
      truncated: false,
    };
    const onOpenWikiPage = vi.fn(async () => {});
    const container = document.createElement("div");
    const rerender = () => renderDreamingView(props, container);
    const props: DreamingProps = buildProps({
      onOpenWikiPage,
      onViewStateChange: rerender,
      wikiOverview: {
        totalItems: 1,
        totalPages: 1,
        truncated: false,
        pageCounts: {
          synthesis: 0,
          entity: 0,
          concept: 0,
          source: 1,
          report: 0,
        },
        totalClaims: 0,
        totalQuestions: 0,
        totalContradictions: 0,
        clusters: [
          {
            key: "report",
            label: "Reports",
            itemCount: 1,
            claimCount: 0,
            questionCount: 0,
            contradictionCount: 0,
            items: [
              {
                pagePath: "reports/weekly-stock.md",
                title: "Weekly stock report",
                kind: "report",
                claimCount: 0,
                questionCount: 0,
                contradictionCount: 0,
                claims: [],
                questions: [],
                contradictions: [],
                snippet: "Weekly stock summary.",
                updatedAt: "2026-04-12T10:00:00.000Z",
              },
            ],
          },
        ],
      },
    });
    rerender();

    expectElement(container, "[data-wiki-page='reports/weekly-stock.md'] button").dispatchEvent(
      new MouseEvent("click", { bubbles: true }),
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(onOpenWikiPage).toHaveBeenCalledWith("reports/weekly-stock.md");
    const request = { page: previewPage, source: { read: previewPage } };
    props.wikiPreview = {
      request,
      page: previewPage,
      readKey: request.source,
      readPage: () => previewPage,
    };
    rerender();
    expect(textItems(container, ".dreams-review__wiki-list > strong")).not.toContain(
      "Page details",
    );
    expect(compactText(container.querySelector(".dreams-diary__preview-title"))).toBe(
      "Weekly stock report",
    );
    expect(compactText(container.querySelector(".dreams-diary__preview-body"))).toBe(
      "# Weekly stock report Summary content.",
    );

    const closePreviewButton = container.querySelector<HTMLButtonElement>(
      ".dreams-diary__preview-footer .btn",
    );
    expect(closePreviewButton).toBeInstanceOf(HTMLButtonElement);
    expect(container.querySelector(".dreams-diary__preview-header button")).toBeNull();
    expect(
      closePreviewButton?.closest("openclaw-modal-actions")?.parentElement?.lastElementChild,
    ).toBe(closePreviewButton?.closest("openclaw-modal-actions"));
    closePreviewButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(props.onCloseWikiPreview).toHaveBeenCalledOnce();
  });

  it("shows one memory-wiki enablement row when the plugin is disabled", () => {
    const onOpenConfig = vi.fn();
    const container = renderInto(
      buildProps({
        memoryWikiEnabled: false,
        onOpenConfig,
      }),
    );
    const row = [...container.querySelectorAll(".settings-row")].find((node) =>
      node.textContent?.includes("Memory wiki is not enabled"),
    );
    expect(compactText(row?.querySelector(".settings-row__desc") ?? null)).toBe(
      "Imported insights and the memory wiki come from the bundled memory-wiki plugin. Enable plugins.entries.memory-wiki.enabled = true, then refresh.",
    );
    expect(container.querySelector("[aria-controls='dreams-review-wiki']")).toBeNull();
    row?.querySelector<HTMLButtonElement>(".btn")?.click();
    expect(onOpenConfig).toHaveBeenCalledTimes(1);
  });

  it("renders the newest diary entry under the scene", () => {
    const container = renderInto(buildProps());
    expect(compactText(container.querySelector(".dreams-diary .settings-section__heading"))).toBe(
      "Dream diary",
    );
    expectElement(container, ".dreams-diary__entry");
    const date = container.querySelector(".dreams-diary__date");
    expect(date?.textContent).toBe("April 5, 2026, 3:00 AM");
    const body = container.querySelector(".dreams-diary__para");
    expect(body?.textContent?.trim()).toBe(
      "The repository whispered of forgotten endpoints tonight.",
    );
  });

  it("renders dream diary markdown through the sanitized markdown pipeline", () => {
    const container = renderInto(
      buildProps({
        dreamDiaryContent: [
          "# Dream Diary",
          "",
          "---",
          "",
          "*April 8, 2026*",
          "",
          "**Bold** and *italic*",
        ].join("\n"),
      }),
    );

    const body = container.querySelector(".dreams-diary__para");
    expect(body?.querySelector("strong")?.textContent).toBe("Bold");
    expect(body?.querySelector("em")?.textContent).toBe("italic");
  });

  it("flattens structured backfill diary entries into plain prose", () => {
    const container = renderInto(
      buildProps({
        dreamDiaryContent: [
          "# Dream Diary",
          "",
          "<!-- openclaw:dreaming:diary:start -->",
          "",
          "---",
          "",
          "*January 1, 2026*",
          "",
          "<!-- openclaw:dreaming:backfill-entry day=2026-01-01 source=memory/2026-01-01.md -->",
          "",
          "What Happened",
          "1. Always use Happy Together for flights.",
          "",
          "Reflections",
          "1. Stable preferences were made explicit.",
          "",
          "Candidates",
          "- likely_durable: Happy Together rule",
          "",
          "Possible Lasting Updates",
          "- Use Happy Together for flights.",
          "",
          "<!-- openclaw:dreaming:diary:end -->",
        ].join("\n"),
      }),
    );
    const prose = [...container.querySelectorAll(".dreams-diary__para")].map((node) =>
      node.textContent?.trim(),
    );
    expect(prose).toEqual([
      "Always use Happy Together for flights.",
      "Stable preferences were made explicit.",
      "Happy Together rule",
      "Use Happy Together for flights.",
    ]);
    expect(container.querySelector(".dreams-diary__panel-title")).toBeNull();
  });

  it("turns diary pages from the date select and the older and newer steps", () => {
    const container = document.createElement("div");
    const rerender = () => renderDreamingView(props, container);
    const props: DreamingProps = buildProps({
      dreamDiaryContent: [
        "# Dream Diary",
        "---",
        "*January 1, 2020*",
        "An earlier dream.",
        "---",
        "*January 2, 2020*",
        "The newest dream.",
      ].join("\n\n"),
      onViewStateChange: rerender,
    });
    rerender();
    const prose = () => compactText(container.querySelector(".dreams-diary__prose"));
    const dates = () => container.querySelector<HTMLSelectElement>(".dreams-diary__dates")!;
    expect([...dates().options].map((option) => option.textContent)).toEqual([
      new Date(2020, 0, 2).toLocaleString([], {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
      }),
      new Date(2020, 0, 1).toLocaleString([], {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
      }),
    ]);
    expect(prose()).toBe("The newest dream.");
    const newer = container.querySelector<HTMLButtonElement>('[aria-label="Newer entry"]')!;
    expect(newer.disabled).toBe(true);
    container.querySelector<HTMLButtonElement>('[aria-label="Older entry"]')?.click();
    expect(viewState.diaryPage).toBe(1);
    expect(prose()).toBe("An earlier dream.");
    expect(container.querySelector<HTMLButtonElement>('[aria-label="Older entry"]')?.disabled).toBe(
      true,
    );
    dates().value = "0";
    dates().dispatchEvent(new Event("change", { bubbles: true }));
    expect(viewState.diaryPage).toBe(0);
    expect(prose()).toBe("The newest dream.");
  });

  it("renders diary empty and error states", () => {
    const emptyContainer = renderInto(buildProps({ dreamDiaryContent: null }));
    expect(emptyContainer.querySelectorAll(".dreams-diary__empty")).toHaveLength(1);
    expect(emptyContainer.querySelector(".dreams-diary__empty-text")?.textContent).toBe(
      "No dreams yet",
    );
    expect(emptyContainer.querySelector(".dreams-diary__empty-hint")?.textContent).toBe(
      "Dreams will appear here after the first dreaming cycle runs.",
    );

    const errorContainer = renderInto(
      buildProps({
        readDiary: () => {
          throw new Error("read failed");
        },
      }),
    );
    expect(errorContainer.querySelector(".dreams-diary__error")?.textContent).toBe("read failed");
  });

  it("keeps maintenance in one menu and the list action with its list", () => {
    openReviewPanel("dailyLog");
    const onResetGroundedShortTerm = vi.fn();
    const container = renderInto(buildProps({ onResetGroundedShortTerm }));
    expect(container.querySelectorAll(".settings-section__actions .btn")).toHaveLength(1);
    expect(
      container.querySelector(".dreams-review__entry .dreams-review__snippet")?.textContent,
    ).toBe("Emma prefers shorter, lower-pressure check-ins.");
    const clear = container.querySelector<HTMLButtonElement>(".dreams-review__tools .btn")!;
    expect(clear.textContent?.trim()).toBe("Clear replayed");
    clear.click();
    expect(onResetGroundedShortTerm).toHaveBeenCalledOnce();
  });

  it("offers the sort only for the waiting list", () => {
    openReviewPanel("waiting");
    const container = renderInto(
      buildProps(undefined, {
        shortTermEntries: [
          { ...baseEntry, key: "a", snippet: "First" },
          { ...baseEntry, key: "b", snippet: "Second" },
        ],
      }),
    );
    expect(textItems(container, ".dreams-review__tools .settings-segmented__btn")).toEqual([
      "Most recent",
      "Strongest support",
    ]);
  });

  it("sorts waiting entries by strongest support without swapping datasets", () => {
    openReviewPanel("waiting");
    const shortTermEntries = [
      {
        key: "memory:recent-low-signal",
        path: "memory/2026-04-05.md",
        startLine: 1,
        endLine: 1,
        snippet: "Recent but low signal",
        recallCount: 1,
        dailyCount: 0,
        groundedCount: 0,
        totalSignalCount: 1,
        lightHits: 0,
        remHits: 0,
        phaseHitCount: 0,
        lastRecalledAt: "2026-04-06T12:00:00.000Z",
      },
      {
        key: "memory:older-high-signal",
        path: "memory/2026-04-01.md",
        startLine: 1,
        endLine: 1,
        snippet: "Older but strongly supported",
        recallCount: 5,
        dailyCount: 4,
        groundedCount: 0,
        totalSignalCount: 9,
        lightHits: 2,
        remHits: 1,
        phaseHitCount: 3,
        lastRecalledAt: "2026-04-01T12:00:00.000Z",
      },
    ];

    setDreamAdvancedWaitingSort("recent");
    let container = renderInto(
      buildProps(undefined, {
        shortTermEntries,
        promotedEntries: [],
      }),
    );
    const recentOrder = [...container.querySelectorAll("[data-entry-key]")].map((node) =>
      node.getAttribute("data-entry-key"),
    );
    expect(recentOrder).toEqual(["memory:recent-low-signal", "memory:older-high-signal"]);

    setDreamAdvancedWaitingSort("signals");
    container = renderInto(
      buildProps(undefined, {
        shortTermEntries,
        promotedEntries: [],
      }),
    );
    const signalOrder = [...container.querySelectorAll("[data-entry-key]")].map((node) =>
      node.getAttribute("data-entry-key"),
    );
    expect(signalOrder).toEqual(["memory:older-high-signal", "memory:recent-low-signal"]);
    expect(new Set(signalOrder)).toEqual(new Set(recentOrder));

    setDreamAdvancedWaitingSort("recent");
  });

  it("treats malformed waiting-entry timestamps as oldest in both sort modes", () => {
    openReviewPanel("waiting");
    const shortTermEntries = [
      {
        key: "memory:valid-recent",
        path: "memory/2026-04-06.md",
        startLine: 1,
        endLine: 1,
        snippet: "Valid recent timestamp",
        recallCount: 1,
        dailyCount: 0,
        groundedCount: 0,
        totalSignalCount: 3,
        lightHits: 1,
        remHits: 0,
        phaseHitCount: 1,
        lastRecalledAt: "2026-04-06T12:00:00.000Z",
      },
      {
        key: "memory:malformed-time",
        path: "memory/2026-04-05.md",
        startLine: 1,
        endLine: 1,
        snippet: "Malformed timestamp",
        recallCount: 1,
        dailyCount: 0,
        groundedCount: 0,
        totalSignalCount: 3,
        lightHits: 1,
        remHits: 0,
        phaseHitCount: 1,
        lastRecalledAt: "not-a-timestamp",
      },
    ];

    setDreamAdvancedWaitingSort("recent");
    let container = renderInto(
      buildProps(undefined, {
        shortTermEntries,
        promotedEntries: [],
      }),
    );
    const recentOrder = [...container.querySelectorAll("[data-entry-key]")].map((node) =>
      node.getAttribute("data-entry-key"),
    );
    expect(recentOrder).toEqual(["memory:valid-recent", "memory:malformed-time"]);

    setDreamAdvancedWaitingSort("signals");
    container = renderInto(
      buildProps(undefined, {
        shortTermEntries,
        promotedEntries: [],
      }),
    );
    const signalOrder = [...container.querySelectorAll("[data-entry-key]")].map((node) =>
      node.getAttribute("data-entry-key"),
    );
    expect(signalOrder).toEqual(["memory:valid-recent", "memory:malformed-time"]);

    setDreamAdvancedWaitingSort("recent");
  });
});
