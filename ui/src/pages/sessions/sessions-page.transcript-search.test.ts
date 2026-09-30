/* @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionsSearchResult } from "../../../../packages/gateway-protocol/src/index.js";
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
const row = {
  key: "agent:main:content",
  kind: "direct",
  label: "Lunar museum itinerary",
} satisfies GatewaySessionRow;
const metadata = {
  key: "agent:main:metadata",
  kind: "direct",
  label: "Metadata-only task",
} satisfies GatewaySessionRow;
function matches(snippet = "needle"): SearchResponse {
  return {
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
  };
}
async function mount(
  request: ReturnType<typeof vi.fn<GatewayBrowserClient["request"]>>,
  allAgents = false,
) {
  const connection = createGateway({ request } as unknown as GatewayBrowserClient);
  connection.emit({ hello: gatewayHelloForMethods([]) });
  const managed = createManagedSessions();
  const context = createContext(connection.gateway, managed.sessions);
  context.agentSelection.state.scopeId = allAgents ? null : "main";
  const page = await createRenderedPage(context, sessionsResult([metadata], 1));
  const find = (part: string) => page.querySelector(`.sessions-transcript-search__${part}`);
  return { page, managed, find };
}
const scope = {
  agentId: "main",
  includeGlobal: true,
  includeUnknown: false,
  configuredAgentsOnly: true,
};
afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("Sessions transcript search", () => {
  it("submits one trimmed bounded search across agents and renders its status outside the roster", async () => {
    const response = createDeferred<SearchResponse>();
    const request = vi.fn<GatewayBrowserClient["request"]>().mockReturnValue(response.promise);
    const { page, managed, find } = await mount(request, true);
    page.updateTranscriptSearchQuery("  launch code  ");
    const pending = page.runTranscriptSearch();
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    expect(request).toHaveBeenCalledWith("sessions.search", {
      query: "launch code",
      limit: 25,
      scope: { includeGlobal: true, includeUnknown: false, configuredAgentsOnly: true },
    });
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
    expect(managed.sessions.list).not.toHaveBeenCalled();
  });

  it("skips empty queries but submits search without method advertisement", async () => {
    const request = vi
      .fn<GatewayBrowserClient["request"]>()
      .mockResolvedValue({ results: [], sessions: [] });
    const { page, find } = await mount(request);
    const submit = () => page.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    page.updateTranscriptSearchQuery("   ");
    await page.runTranscriptSearch();
    await page.updateComplete;
    expect(request).not.toHaveBeenCalled();
    expect(find("status")?.textContent?.trim()).toBe("");
    expect(submit().disabled).toBe(true);
    page.updateTranscriptSearchQuery("not advertised");
    await vi.waitFor(() => expect(submit().disabled).toBe(false));
    find("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(find("empty")).not.toBeNull());
    expect(request).toHaveBeenCalledExactlyOnceWith("sessions.search", {
      query: "not advertised",
      limit: 25,
      scope,
    });
  });

  it.each(["same", "clear", "replace"])(
    "keeps only current matches after %s during a request",
    async (action) => {
      const response = createDeferred<SearchResponse>();
      const request = vi
        .fn<GatewayBrowserClient["request"]>()
        .mockResolvedValue(matches("replacement needle"))
        .mockReturnValueOnce(response.promise);
      const { page, managed, find } = await mount(request);
      page.updateTranscriptSearchQuery("needle");
      const pending = page.runTranscriptSearch();
      await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
      await page.updateComplete;
      if (action === "clear") {
        page
          .querySelector<HTMLButtonElement>('.sessions-transcript-search button[type="button"]')!
          .click();
      } else if (action === "replace") {
        page.updateTranscriptSearchQuery("replacement needle");
        await page.runTranscriptSearch();
      } else {
        page.updateTranscriptSearchQuery("needle");
      }
      await page.updateComplete;
      response.resolve(matches("original needle"));
      await pending;
      await page.updateComplete;
      expect(request).toHaveBeenCalledTimes(action === "replace" ? 2 : 1);
      expect(managed.sessions.list).not.toHaveBeenCalled();
      expect(find("snippet")?.textContent).toBe(
        action === "same"
          ? "original needle"
          : action === "replace"
            ? "replacement needle"
            : undefined,
      );
      expect(find("status")?.getAttribute("aria-busy")).toBe("false");
    },
  );

  it("shows an unavailable search RPC and retries the submitted query", async () => {
    const request = vi
      .fn<GatewayBrowserClient["request"]>()
      .mockResolvedValue({ results: [], sessions: [] })
      .mockRejectedValueOnce(new Error("search unavailable"));
    const { page, find, managed } = await mount(request);
    page.updateTranscriptSearchQuery("needle");
    await page.runTranscriptSearch();
    await page.updateComplete;
    expect(find("notice")?.textContent).toContain("search unavailable");
    expect(request).toHaveBeenCalledOnce();
    find("notice button")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await vi.waitFor(() => expect(find("empty")).not.toBeNull());
    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenLastCalledWith("sessions.search", {
      query: "needle",
      limit: 25,
      scope,
    });
    expect(managed.sessions.list).not.toHaveBeenCalled();
    expect(find("notice")).toBeNull();
  });

  it("searches changed membership without waiting for the metadata list", async () => {
    const refresh = createDeferred();
    const request = vi
      .fn<GatewayBrowserClient["request"]>()
      .mockResolvedValue({ results: [], sessions: [] });
    const { page, managed, find } = await mount(request);
    managed.refreshList.mockReturnValueOnce(refresh.promise);
    const unknown = page.querySelector<HTMLInputElement>('input[name="includeUnknown"]')!;
    unknown.checked = true;
    unknown.dispatchEvent(new Event("change", { bubbles: true }));
    await page.updateComplete;
    expect(page.refreshing).toBe(true);
    page.updateTranscriptSearchQuery("needle");
    await page.runTranscriptSearch();
    await page.updateComplete;
    expect(managed.refreshList).toHaveBeenCalledWith(
      expect.objectContaining({ includeUnknown: true }),
    );
    expect(managed.sessions.list).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledExactlyOnceWith("sessions.search", {
      query: "needle",
      limit: 25,
      scope: { ...scope, includeUnknown: true },
    });
    expect(find("empty")).not.toBeNull();
    refresh.resolve();
    await vi.waitFor(() => expect(page.refreshing).toBe(false));
  });

  it("keeps transcript titles independent of metadata filtering", async () => {
    const request = vi.fn<GatewayBrowserClient["request"]>().mockResolvedValue(matches());
    const { page, managed, find } = await mount(request);
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
    const search = page.querySelector<HTMLInputElement>(".sessions-toolbar__search input")!;
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
    expect(managed.sessions.list).not.toHaveBeenCalled();
  });

  it("retires pending active matches when the route changes to archived", async () => {
    const response = createDeferred<SearchResponse>();
    const request = vi.fn<GatewayBrowserClient["request"]>().mockReturnValueOnce(response.promise);
    const { page, find } = await mount(request);
    page.updateTranscriptSearchQuery("release notes");
    const pending = page.runTranscriptSearch();
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    page.routeData = { expandedSessionKey: null, statusFilter: "archived" };
    await page.updateComplete;
    response.resolve(matches("release notes"));
    await pending;
    await page.updateComplete;
    expect(page.statusFilter).toBe("archived");
    expect(find("snippet")).toBeNull();
    expect(page.transcriptSearchQuery).toBe("release notes");
    await vi.waitFor(() => expect(find("status")?.textContent?.trim()).toBe(""));
    request.mockResolvedValueOnce({ results: [], sessions: [] });
    await page.runTranscriptSearch();
    await page.updateComplete;
    expect(find("empty")).not.toBeNull();
    expect(request).toHaveBeenLastCalledWith("sessions.search", {
      query: "release notes",
      limit: 25,
      scope: { ...scope, archived: true },
    });
  });
});
