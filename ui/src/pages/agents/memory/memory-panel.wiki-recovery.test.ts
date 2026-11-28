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
  vi.useRealTimers();
  cleanupSolid();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

const WIKI_HELLO = gatewayHelloForMethods(["wiki.overview", "wiki.importInsights", "config.patch"]);

function rebuildingError(retryAfterMs = 500) {
  return new GatewayRequestError({
    code: "UNAVAILABLE",
    message: "Memory Wiki dashboards are rebuilding. Retry shortly.",
    details: { state: "rebuilding" },
    retryable: true,
    retryAfterMs,
  });
}

function overviewPayload(title = "Repro Page") {
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
            pagePath: "concepts/repro-page.md",
            title,
            kind: "concept",
            claimCount: 0,
            questionCount: 0,
            contradictionCount: 0,
            claims: [],
            questions: [],
            contradictions: [],
            snippet: "Repro page content.",
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

it("automatically retries rebuilding wiki dashboards and renders recovered cards", async () => {
  vi.useFakeTimers();
  let rebuilding = true;
  const page = await createPage(
    {
      [DIARY]: () => diary("Nightly diary"),
      "wiki.importInsights": () => {
        if (rebuilding) {
          throw rebuildingError(500);
        }
        return emptyInsights();
      },
      "wiki.overview": () => {
        if (rebuilding) {
          throw rebuildingError(500);
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
    ".dreams-diary__error",
    "Memory Wiki dashboards are rebuilding. Retry shortly.",
  );
  expect(page.text(".dreams-diary__error-state button")).toBe("Retry");

  rebuilding = false;
  const statusCallsBefore = page.request.mock.calls.filter(([name]) => name === STATUS).length;
  const diaryCallsBefore = page.request.mock.calls.filter(([name]) => name === DIARY).length;
  await vi.advanceTimersByTimeAsync(500);
  await waitForSolid(() => {
    expect(page.query(".dreams-diary__error")).toBeNull();
    expect(page.container.textContent).toContain("Repro Page");
  });
  expect(page.request.mock.calls.filter(([name]) => name === STATUS)).toHaveLength(
    statusCallsBefore,
  );
  expect(page.request.mock.calls.filter(([name]) => name === DIARY)).toHaveLength(diaryCallsBefore);
});

it("bounds automatic rebuilding retries and recovers via inline Retry button", async () => {
  vi.useFakeTimers();
  let overviewCalls = 0;
  let failOverview = true;
  const page = await createPage(
    {
      [DIARY]: () => diary("Nightly diary"),
      "wiki.importInsights": () => emptyInsights(),
      "wiki.overview": () => {
        overviewCalls += 1;
        if (failOverview) {
          throw rebuildingError(500);
        }
        return overviewPayload("Recovered After Retry Click");
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

  await vi.advanceTimersByTimeAsync(10_000);
  await page.waitText(
    ".dreams-diary__error",
    "Memory Wiki dashboards are rebuilding. Retry shortly.",
  );
  const boundedCalls = overviewCalls;
  expect(boundedCalls).toBeGreaterThan(1);
  expect(boundedCalls).toBeLessThanOrEqual(5);

  await vi.advanceTimersByTimeAsync(5_000);
  expect(overviewCalls).toBe(boundedCalls);

  failOverview = false;
  click(page.container, ".dreams-diary__error-state button");
  await waitForSolid(() => {
    expect(page.query(".dreams-diary__error")).toBeNull();
    expect(page.container.textContent).toContain("Recovered After Retry Click");
  });
});

it.each(["agent", "disconnect", "unmount"] as const)(
  "cancels pending rebuilding retries on %s retirement",
  async (retirement) => {
    vi.useFakeTimers();
    const page = await createPage(
      {
        "wiki.importInsights": () => emptyInsights(),
        "wiki.overview": () => {
          throw rebuildingError(500);
        },
      },
      "main",
      WIKI_HELLO,
    );
    await waitForSolid(() =>
      expect(
        page.request.mock.calls.filter(
          ([name, params]) =>
            name === "wiki.overview" && (params as { agentId?: string })?.agentId === "main",
        ),
      ).toHaveLength(1),
    );
    if (retirement === "agent") {
      page.setAgentId("support");
    } else if (retirement === "disconnect") {
      page.context.emit({ phase: "reconnecting", hello: null });
    } else {
      page.unmount();
    }
    await vi.advanceTimersByTimeAsync(2_000);
    expect(
      page.request.mock.calls.filter(
        ([name, params]) =>
          name === "wiki.overview" && (params as { agentId?: string })?.agentId === "main",
      ),
    ).toHaveLength(1);
  },
);

it("does not auto-retry non-rebuilding wiki errors while still offering inline Retry", async () => {
  vi.useFakeTimers();
  let calls = 0;
  let fail = true;
  const page = await createPage(
    {
      "wiki.importInsights": () => {
        calls += 1;
        if (fail) {
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
  page.dreaming.onViewStateChange((draft) => {
    draft.openReviewPanel = "insights";
  });
  flush();
  await waitForSolid(() => expect(calls).toBe(1));
  await vi.advanceTimersByTimeAsync(2_000);
  expect(calls).toBe(1);
  expect(page.text(".dreams-diary__error-state button")).toBe("Retry");
  fail = false;
  click(page.container, ".dreams-diary__error-state button");
  await waitForSolid(() => expect(page.query(".dreams-diary__error")).toBeNull());
  expect(calls).toBe(2);
});
