import { expect, it } from "vitest";
import {
  classifyMediaErrors,
  type MediaConsoleError,
  type MediaFetchAttempt,
} from "../../scripts/lib/control-ui-media-errors.ts";

const url = "http://127.0.0.1:9000/__openclaw__/assistant-media/image.png";
const consoleError: MediaConsoleError = {
  type: "error",
  message: "Failed to load resource: resource unavailable",
  url,
  lineNumber: 0,
  columnNumber: 0,
};
const attempt: MediaFetchAttempt = {
  url,
  method: "GET",
  mode: "same-origin",
  cache: "only-if-cached",
  credentials: "same-origin",
  authorizationContext: 1,
  outcome: "rejected",
};
const input = {
  engine: "webkit",
  origin: "http://127.0.0.1:9000",
  pageErrors: [] as string[],
  httpErrors: [] as string[],
  consoleErrors: [consoleError, consoleError],
  failedRequests: [1, 2].map(() => ({ url, method: "GET", resourceType: "fetch", errorText: "" })),
  fetchAttempts: [attempt, attempt],
};

it("classifies only complete matching WebKit cache-miss URL multisets", () => {
  expect(classifyMediaErrors(input)).toEqual({
    expectedCacheMisses: [consoleError, consoleError],
    unexpectedErrors: [],
  });
  expect(
    classifyMediaErrors({
      ...input,
      fetchAttempts: [
        ...input.fetchAttempts,
        { ...attempt, cache: "default", outcome: "fulfilled", status: 200 },
        { ...attempt, outcome: "fulfilled", status: 200 },
      ],
    }),
  ).toEqual({ expectedCacheMisses: [consoleError, consoleError], unexpectedErrors: [] });
  for (const override of [
    { engine: "chromium" },
    { origin: "http://other.test" },
    { fetchAttempts: [attempt] },
    { fetchAttempts: [attempt, { ...attempt, cache: "default" as const }] },
    { fetchAttempts: [attempt, { ...attempt, mode: "cors" as const }] },
    { fetchAttempts: [attempt, { ...attempt, outcome: "fulfilled" as const }] },
    { failedRequests: input.failedRequests.slice(0, 1) },
    { consoleErrors: [consoleError, { ...consoleError, message: "Other failure" }] },
  ]) {
    const result = classifyMediaErrors({ ...input, ...override });
    expect(result.expectedCacheMisses).toEqual([]);
    expect(result.unexpectedErrors.length).toBeGreaterThan(0);
  }
});

it("retains page and HTTP errors even when their text matches a classified console error", () => {
  const result = classifyMediaErrors({
    ...input,
    pageErrors: [
      consoleError.message,
      "ResizeObserver loop completed with undelivered notifications.",
    ],
    httpErrors: [`HTTP 500 ${url}`],
  });
  expect(result.expectedCacheMisses).toHaveLength(2);
  expect(result.unexpectedErrors).toEqual([
    consoleError.message,
    "ResizeObserver loop completed with undelivered notifications.",
    `HTTP 500 ${url}`,
  ]);
});
