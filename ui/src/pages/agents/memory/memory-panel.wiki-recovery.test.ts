/* @vitest-environment jsdom */

import { flush } from "solid-js";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { GatewayRequestError } from "../../../api/gateway-connect-errors.ts";
import { gatewayHelloForMethods } from "../../../test-helpers/gateway-methods.ts";
import { cleanupSolid } from "../../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { click, createPage, DIARY, diary, STATUS } from "./memory-panel.test-support.ts";
import { installDreamingViewTestTranslations } from "./view.test-helpers.ts";

const restoreTranslations = installDreamingViewTestTranslations();
afterAll(() => restoreTranslations());
afterEach(() => {
  cleanupSolid();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

const WIKI_HELLO = gatewayHelloForMethods(["wiki.overview", "wiki.importInsights", "config.patch"]);

function overviewPayload(title = "Architecture synthesis") {
  return {
    totalItems: 1,
    totalPages: 10,
    pageCounts: { synthesis: 0, entity: 0, concept: 1, source: 0, report: 9 },
    totalClaims: 0,
    totalQuestions: 0,
    totalContradictions: 0,
    truncated: false,
    clusters: [
      {
        key: "concept",
        label: "Concepts",
        itemCount: 1,
        claimCount: 0,
        questionCount: 0,
        contradictionCount: 0,
        items: [
          {
            pagePath: "concepts/architecture-notes.md",
            title,
            kind: "concept",
            claimCount: 0,
            questionCount: 0,
            contradictionCount: 0,
            claims: [],
            questions: [],
            contradictions: [],
            snippet: "Compiled reference notes.",
          },
        ],
      },
    ],
  };
}

function emptyInsights() {
  return {
    sourceType: "chatgpt",
    totalItems: 0,
    totalClusters: 0,
    clusters: [],
    truncated: false,
  };
}

it("recovers Memory Wiki from a rebuilding error via its inline Retry button without reloading sibling resources", async () => {
  let rebuilding = true;
  const page = await createPage(
    {
      [DIARY]: () => diary("Nightly diary"),
      "wiki.importInsights": () => emptyInsights(),
      "wiki.overview": () => {
        if (rebuilding) {
          throw new GatewayRequestError({
            code: "UNAVAILABLE",
            message: "Memory Wiki dashboards are rebuilding. Retry shortly.",
            details: { state: "rebuilding" },
            retryable: true,
            retryAfterMs: 500,
          });
        }
        return overviewPayload();
      },
    },
    "main",
    WIKI_HELLO,
  );
  page.context.setConfig({ plugins: { entries: { "memory-wiki": { enabled: true } } } });
  page.dreaming.onViewStateChange((draft) => {
    draft.openReviewPanel = "wiki";
  });
  flush();
  await page.waitText(
    "#dreams-review-wiki .dreams-diary__error",
    "Memory Wiki dashboards are rebuilding. Retry shortly.",
  );
  expect(page.text("#dreams-review-wiki .dreams-diary__error-state button")).toBe("Retry");

  const statusCallsBefore = page.request.mock.calls.filter(([name]) => name === STATUS).length;
  const diaryCallsBefore = page.request.mock.calls.filter(([name]) => name === DIARY).length;
  const insightsCallsBefore = page.request.mock.calls.filter(
    ([name]) => name === "wiki.importInsights",
  ).length;

  rebuilding = false;
  click(page.container, "#dreams-review-wiki .dreams-diary__error-state button");
  await waitForSolid(() => {
    expect(page.query("#dreams-review-wiki .dreams-diary__error")).toBeNull();
    expect(page.container.textContent).toContain("Architecture synthesis");
  });
  expect(page.request.mock.calls.filter(([name]) => name === STATUS)).toHaveLength(
    statusCallsBefore,
  );
  expect(page.request.mock.calls.filter(([name]) => name === DIARY)).toHaveLength(diaryCallsBefore);
  expect(page.request.mock.calls.filter(([name]) => name === "wiki.importInsights")).toHaveLength(
    insightsCallsBefore,
  );
});

it.each(["insights", "diary"] as const)(
  "recovers %s via its inline Retry button without reloading wiki overview",
  async (panel) => {
    let fail = true;
    const page = await createPage(
      {
        [DIARY]: () => {
          if (panel === "diary" && fail) {
            throw new Error("Diary read failed");
          }
          return diary("Recovered diary entry");
        },
        "wiki.importInsights": () => {
          if (panel === "insights" && fail) {
            throw new GatewayRequestError({
              code: "INVALID_REQUEST",
              message:
                'Memory Wiki dashboards need a compiled snapshot. Run "openclaw wiki compile", then reload.',
              details: { state: "compile-required" },
            });
          }
          return emptyInsights();
        },
        "wiki.overview": () => overviewPayload(),
      },
      "main",
      WIKI_HELLO,
    );
    page.context.setConfig({ plugins: { entries: { "memory-wiki": { enabled: true } } } });
    if (panel === "insights") {
      page.dreaming.onViewStateChange((draft) => {
        draft.openReviewPanel = "insights";
      });
      flush();
    }
    const scopeSelector = panel === "insights" ? "#dreams-review-insights" : ".dreams-diary";
    await waitForSolid(() =>
      expect(page.text(`${scopeSelector} .dreams-diary__error-state button`)).toBe("Retry"),
    );
    const overviewCallsBefore = page.request.mock.calls.filter(
      ([name]) => name === "wiki.overview",
    ).length;

    fail = false;
    click(page.container, `${scopeSelector} .dreams-diary__error-state button`);
    await waitForSolid(() => {
      expect(page.query(`${scopeSelector} .dreams-diary__error`)).toBeNull();
    });
    expect(page.request.mock.calls.filter(([name]) => name === "wiki.overview")).toHaveLength(
      overviewCallsBefore,
    );
  },
);
