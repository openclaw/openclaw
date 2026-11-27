import { createComponent, createSignal } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import {
  createApplicationGateway,
  createApplicationGatewaySnapshot,
} from "../../test-helpers/application-context-fixtures.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { meetingEntry } from "../../test-helpers/transcripts.test-support.ts";
import {
  button,
  createMeetingsPageProvider,
  meetingPage,
  mount,
} from "./meetings-page.test-support.tsx";
import { page as meetingsRoute } from "./route.tsx";

afterEach(() => {
  vi.restoreAllMocks();
});

const boundaryQuery = `${"🌱".repeat(255)}春`;

it("restores the entire saved meeting query and keeps broader results out of an invalid draft", async () => {
  const request = vi.fn(async () => ({ sessions: [meetingEntry], nextCursor: null }));
  const { page, routeSearch, unmount } = mount(
    request,
    `?query=${encodeURIComponent(boundaryQuery)}`,
  );
  try {
    await waitForSolid(() => expect(page.querySelector(".meetings-row")).not.toBeNull());
    expect(request).toHaveBeenCalledWith(
      "transcripts.list",
      expect.objectContaining({ query: boundaryQuery }),
      expect.anything(),
    );
    const field = page.querySelector<HTMLInputElement>('input[name="query"]')!;
    expect(field.value).toBe(boundaryQuery);
    expect(field.maxLength).toBe(-1);
    field.value += "秋";
    field.dispatchEvent(new Event("input", { bubbles: true }));
    button(page, "Filter").click();
    await waitForSolid(() => expect(field.getAttribute("aria-invalid")).toBe("true"));
    expect(field.value).toBe(boundaryQuery + "秋");
    expect(page.querySelector(".meetings-row")).toBeNull();
    expect(new URLSearchParams(routeSearch()).get("query")).toBe(boundaryQuery);
    expect(request).toHaveBeenCalledTimes(1);
  } finally {
    unmount();
  }
});

it("recovers an oversized saved query without loading all meetings while the route is pending", async () => {
  const request = vi.fn(async () => ({ sessions: [], nextCursor: null }));
  const { gateway } = createApplicationGateway(
    createApplicationGatewaySnapshot({
      phase: "connected",
      client: createTestGatewayClient(request),
    }),
  );
  const { provider, navigate } = createMeetingsPageProvider(gateway);
  const { renderSolid } = await meetingsRoute.component();
  const [search, setSearch] = createSignal<string>();
  const { container: page, unmount } = mountSolid(
    () =>
      createComponent(renderSolid, {
        get data() {
          return search();
        },
        get loaderPending() {
          return search() === undefined;
        },
        presented: true,
      }),
    { wrapper: provider.wrapper },
  );
  const query = "a".repeat(257);
  try {
    flush();
    expect(request).not.toHaveBeenCalled();
    setSearch(`?query=${query}&providerId=manual`);
    await waitForSolid(() =>
      expect(page.querySelector('[role="alert"]')?.textContent).toContain("256"),
    );
    const field = page.querySelector<HTMLInputElement>('input[name="query"]')!;
    expect(field.value).toBe(query);
    expect(request).not.toHaveBeenCalled();
    field.value = boundaryQuery;
    field.dispatchEvent(new Event("input", { bubbles: true }));
    button(page, "Filter").click();
    const next = navigate.mock.lastCall?.[1]?.search;
    expect(new URLSearchParams(next).get("query")).toBe(boundaryQuery);
    setSearch(undefined);
    flush();
    expect(field.isConnected).toBe(true);
    expect(field.value).toBe(boundaryQuery);
    expect(request).not.toHaveBeenCalled();
    setSearch(next);
    await waitForSolid(() =>
      expect(request).toHaveBeenCalledWith(
        "transcripts.list",
        expect.objectContaining({ query: boundaryQuery, providerId: "manual" }),
        expect.anything(),
      ),
    );
    expect(field.getAttribute("aria-invalid")).toBeNull();
    expect(request).toHaveBeenCalledTimes(1);
    setSearch("");
    await waitForSolid(() =>
      expect(request).toHaveBeenCalledWith(
        "transcripts.list",
        expect.objectContaining({ query: undefined }),
        expect.anything(),
      ),
    );
  } finally {
    unmount();
  }
});

it("does not reformat unchanged rows on refresh and still presents changed meeting fields", async () => {
  const date = vi.spyOn(Date.prototype, "toLocaleDateString");
  const time = vi.spyOn(Date.prototype, "toLocaleTimeString");
  const sessions = Array.from({ length: 3 }, (_, index) => ({
    ...meetingEntry,
    selector: `meeting-${index}`,
    title: `Meeting ${index}`,
  }));
  const request = vi.fn(async () => ({ sessions: structuredClone(sessions), nextCursor: null }));
  const { page } = mount(request);
  await waitForSolid(() => expect(page.querySelectorAll(".meetings-row")).toHaveLength(3));
  const row = page.querySelector(".meetings-row");
  expect(date).toHaveBeenCalled();
  expect(time).toHaveBeenCalledTimes(3);
  date.mockClear();
  time.mockClear();

  button(page, "Refresh").click();
  await waitForSolid(() => {
    expect(request).toHaveBeenCalledTimes(2);
    expect(page.querySelector('[aria-busy="true"]')).toBeNull();
  });
  expect(page.querySelector(".meetings-row")).toBe(row);
  expect(date).not.toHaveBeenCalled();
  expect(time).not.toHaveBeenCalled();

  sessions[0] = {
    ...sessions[0]!,
    title: "Updated meeting",
    startedAt: "2026-08-28T10:00:00.000Z",
  };
  button(page, "Refresh").click();
  await waitForSolid(() => expect(page.textContent).toContain("Updated meeting"));
  expect(date).toHaveBeenCalled();
  expect(time).toHaveBeenCalledTimes(1);
  expect(page.querySelector(".meetings-row time")?.getAttribute("datetime")).toBe(
    "2026-08-28T10:00:00.000Z",
  );
});

it("loads beyond five speech pages and refreshes the last without losing or duplicating earlier pages", async () => {
  vi.useFakeTimers();
  let appended = false;
  const request = vi.fn(async (method: string, params: { cursor?: string }) => {
    if (method === "transcripts.list") {
      return { sessions: [], nextCursor: null };
    }
    const pageNumber = Number(params.cursor ?? 0);
    return {
      ...meetingPage,
      session: { ...meetingEntry, active: true },
      utterances: [
        {
          sequence: pageNumber,
          text: `Utterance ${pageNumber}`,
          startedAt: `2026-08-20T10:00:0${pageNumber}Z`,
        },
        ...(appended && pageNumber === 6
          ? [{ sequence: 7, text: "Late transcription", startedAt: "2026-08-20T10:00:01.500Z" }]
          : []),
      ],
      nextCursor: pageNumber < 6 ? String(pageNumber + 1) : null,
    };
  });
  const { page, unmount } = mount(request, "?selector=meeting&tab=transcript");
  try {
    await waitForSolid(() => expect(page.textContent).toContain("Utterance 6"));
    const speech = () =>
      [...page.querySelectorAll(".transcripts-utterances p")].map((el) => el.textContent);
    const initialSpeech = Array.from({ length: 7 }, (_, index) => `Utterance ${index}`);
    expect(speech()).toEqual(initialSpeech);
    expect(page.textContent).not.toContain("Load more");
    appended = true;
    await vi.advanceTimersByTimeAsync(6_000);
    expect(speech()).toEqual([
      ...initialSpeech.slice(0, 2),
      "Late transcription",
      ...initialSpeech.slice(2),
    ]);
    expect(request).toHaveBeenLastCalledWith(
      "transcripts.get",
      expect.objectContaining({ cursor: "6" }),
      expect.anything(),
    );
  } finally {
    unmount();
    vi.useRealTimers();
  }
});
