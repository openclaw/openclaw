/* @vitest-environment jsdom */
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { SessionsSearchResult } from "../../../../packages/gateway-protocol/src/index.js";
import type { SessionsSearchParams } from "../../../../packages/gateway-protocol/src/schema/sessions-search.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import { t } from "../../i18n/index.ts";
import { sessionsResult } from "../../lib/sessions/session-capability.test-support.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import {
  createContext,
  createGateway,
  createManagedSessions,
  createRenderedPage,
} from "./sessions-page.test-support.ts";

type SearchResponse = SessionsSearchResult & { sessions: GatewaySessionRow[] };
const sessionRow = (id: string, label: string): GatewaySessionRow => ({
  key: `agent:main:${id}`,
  kind: "direct",
  label,
});
const row = sessionRow("content", "Lunar museum itinerary");
const metadata = sessionRow("metadata", "Metadata-only task");
const matches = (snippet = "needle"): SearchResponse => ({
  sessions: [row],
  results: [
    {
      sessionKey: row.key,
      sessionId: "content",
      messageId: "message",
      role: "assistant",
      timestamp: 42,
      snippet,
      score: 1,
    },
  ],
});
async function mount(
  request: ReturnType<typeof vi.fn<GatewayBrowserClient["request"]>>,
  allAgents = false,
) {
  const connection = createGateway({ request } as unknown as GatewayBrowserClient);
  connection.emit({ hello: gatewayHelloForMethods([]) });
  const managed = createManagedSessions();
  onTestFinished(() => expect(managed.sessions.list).not.toHaveBeenCalled());
  const context = createContext(connection.gateway, managed.sessions);
  context.agentSelection.state.scopeId = allAgents ? null : "main";
  const page = await createRenderedPage(context, sessionsResult([metadata], 1));
  const find = (part: string) => page.querySelector(`.sessions-transcript-search__${part}`);
  const search = async (query: string) => {
    page.updateTranscriptSearchQuery(query);
    await page.runTranscriptSearch();
    await page.updateComplete;
  };
  return { page, managed, find, search };
}
const scope = {
  agentId: "main",
  excludeDock: true,
  includeGlobal: true,
  includeUnknown: false,
  configuredAgentsOnly: true,
};
const searchCall = (query: string, searchScope: SessionsSearchParams["scope"] = scope) =>
  ["sessions.search", { query, limit: 25, scope: searchScope }] as const;
const emptySearch = () =>
  vi.fn<GatewayBrowserClient["request"]>().mockResolvedValue({ results: [], sessions: [] });
afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("Sessions transcript search", () => {
  it("submits one trimmed bounded search across agents and renders its status outside the roster", async () => {
    const response = createDeferred<SearchResponse>();
    const request = vi.fn<GatewayBrowserClient["request"]>().mockReturnValue(response.promise);
    const { page, find } = await mount(request, true);
    page.updateTranscriptSearchQuery("  launch code  ");
    const pending = page.runTranscriptSearch();
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    const { agentId: _agentId, ...allAgents } = scope;
    expect(request).toHaveBeenCalledWith(...searchCall("launch code", allAgents));
    await page.updateComplete;
    expect(find("status")?.getAttribute("aria-busy")).toBe("true");
    response.resolve({
      ...matches("launch code"),
      indexing: true,
      truncated: true,
      archivedTranscriptsExcluded: 3,
    });
    await pending;
    await page.updateComplete;
    expect(page.transcriptSearchQuery).toBe("launch code");
    expect(find("result-header strong")?.textContent).toBe(row.label);
    expect(find("snippet")?.textContent).toBe("launch code");
    expect(page.textContent).toContain(
      "3 archived transcripts excluded; open a session to restore its searchable history.",
    );
    expect(find("notice")?.textContent).toContain(t("sessionsView.transcriptSearchIndexing"));
    expect(find("summary")?.textContent).toContain(t("sessionsView.transcriptSearchTruncated"));
    expect(find("status")?.getAttribute("aria-busy")).toBe("false");
    expect(page.result?.sessions.map(({ key }) => key)).toEqual([metadata.key]);
  });

  it("skips empty queries but submits search without method advertisement", async () => {
    const request = emptySearch();
    const { page, find, search } = await mount(request);
    const submit = () => page.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    await search("   ");
    expect(request).not.toHaveBeenCalled();
    expect(find("status")).toBeNull();
    expect(submit().disabled).toBe(false);
    page.updateTranscriptSearchQuery("not advertised");
    await vi.waitFor(() => expect(submit().disabled).toBe(false));
    find("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(find("empty")).not.toBeNull());
    expect(request).toHaveBeenCalledExactlyOnceWith(...searchCall("not advertised"));
  });

  it.each(["same", "clear", "replace", "archive"])(
    "keeps only current matches after %s during a request",
    async (action) => {
      const response = createDeferred<SearchResponse>();
      const request = vi
        .fn<GatewayBrowserClient["request"]>()
        .mockResolvedValue(matches("replacement needle"))
        .mockReturnValueOnce(response.promise);
      const { page, find } = await mount(request);
      page.querySelector<HTMLButtonElement>(".sessions-transcript-search__trigger")!.click();
      page.updateTranscriptSearchQuery("needle");
      const pending = page.runTranscriptSearch();
      await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
      await page.updateComplete;
      if (action === "clear") {
        page.querySelector<HTMLButtonElement>(".sessions-transcript-search__clear")!.click();
      } else if (action === "replace") {
        page.updateTranscriptSearchQuery("replacement needle");
        await page.runTranscriptSearch();
      } else if (action === "archive") {
        page.routeData = { expandedSessionKey: null, statusFilter: "archived" };
      } else {
        page.updateTranscriptSearchQuery("needle");
      }
      await page.updateComplete;
      response.resolve(matches("original needle"));
      await pending;
      await page.updateComplete;
      expect(request).toHaveBeenCalledTimes(action === "replace" ? 2 : 1);
      expect(find("snippet")?.textContent).toBe(
        action === "same"
          ? "original needle"
          : action === "replace"
            ? "replacement needle"
            : undefined,
      );
      if (action === "archive") {
        await vi.waitFor(() => expect(find("status")).toBeNull());
      } else if (action === "clear") {
        expect(find("status")).toBeNull();
      } else {
        expect(find("status")?.getAttribute("aria-busy")).toBe("false");
      }
      if (action === "archive") {
        expect([page.statusFilter, page.transcriptSearchQuery]).toEqual(["archived", "needle"]);
        expect(find("snippet")).toBeNull();
        request.mockResolvedValueOnce({ results: [], sessions: [] });
        await page.runTranscriptSearch();
        await page.updateComplete;
        expect(find("empty")).not.toBeNull();
        expect(request).toHaveBeenLastCalledWith(
          ...searchCall("needle", { ...scope, archived: true }),
        );
      }
    },
  );

  it("shows an unavailable search RPC and retries the submitted query", async () => {
    const request = vi
      .fn<GatewayBrowserClient["request"]>()
      .mockResolvedValue({ results: [], sessions: [] })
      .mockRejectedValueOnce(new Error("search unavailable"));
    const { find, search } = await mount(request);
    await search("needle");
    expect(find("notice")?.textContent).toContain("search unavailable");
    expect(request).toHaveBeenCalledOnce();
    find("notice button")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await vi.waitFor(() => expect(find("empty")).not.toBeNull());
    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenLastCalledWith(...searchCall("needle"));
    expect(find("notice")).toBeNull();
  });

  it("searches changed membership without waiting for the metadata list", async () => {
    const refresh = createDeferred();
    const request = emptySearch();
    const { page, managed, find, search } = await mount(request);
    managed.refreshList.mockReturnValueOnce(refresh.promise);
    const unknown = page.querySelector<HTMLInputElement>('input[name="includeUnknown"]')!;
    unknown.checked = true;
    unknown.dispatchEvent(new Event("change", { bubbles: true }));
    await page.updateComplete;
    expect(page.refreshing).toBe(true);
    await search("needle");
    expect(managed.refreshList).toHaveBeenCalledWith(
      expect.objectContaining({ includeUnknown: true }),
    );
    expect(request).toHaveBeenCalledExactlyOnceWith(
      ...searchCall("needle", { ...scope, includeUnknown: true }),
    );
    expect(find("empty")).not.toBeNull();
    refresh.resolve();
    await vi.waitFor(() => expect(page.refreshing).toBe(false));
  });

  it("keeps transcript titles independent of metadata filtering", async () => {
    const request = vi.fn<GatewayBrowserClient["request"]>().mockResolvedValue(matches());
    const { page, managed, find } = await mount(request);
    page.querySelector<HTMLButtonElement>(".sessions-transcript-search__trigger")!.click();
    await vi.waitFor(() =>
      expect(page.querySelector(".sessions-transcript-search__input input")).not.toBeNull(),
    );
    const heading = () => find("result-header strong")?.textContent;
    const submit = () =>
      find("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    const input = page.querySelector<HTMLInputElement>(".sessions-transcript-search__input input")!;
    input.value = "needle";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await page.updateComplete;
    await vi.waitFor(() =>
      expect(
        find("form")?.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled,
      ).toBe(false),
    );
    submit();
    await vi.waitFor(() => expect(heading()).toBe(row.label));
    const search = page.querySelector<HTMLInputElement>(".sessions-filter-popover__search input")!;
    search.value = "metadata-only";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    await page.updateComplete;
    expect(heading()).toBe(row.label);
    await vi.waitFor(() =>
      expect(managed.refreshList).toHaveBeenCalledWith(
        expect.objectContaining({ search: "metadata-only" }),
      ),
    );
    const [query] = managed.subscribeList.mock.calls.at(-1)!;
    managed.publish(query, {
      result: sessionsResult([metadata], 2),
      agentId: "main",
      loading: false,
      error: null,
    });
    await page.updateComplete;
    expect(page.result?.sessions.map(({ key }) => key)).toEqual([metadata.key]);
    expect(heading()).toBe(row.label);
    expect(find("snippet")?.textContent).toBe("needle");
    expect(request).toHaveBeenCalledOnce();
  });
});
