/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionsSearchResult } from "../../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { t } from "../../i18n/index.ts";
import { sessionsResult } from "../../lib/sessions/session-capability.test-support.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import {
  createContext,
  createGateway,
  createManagedSessions,
  createRenderedPage,
  createSessions,
} from "./sessions-page.test-support.ts";

type TranscriptSearchResponse = SessionsSearchResult & { sessions: GatewaySessionRow[] };

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("Sessions transcript search scope", () => {
  it("submits one trimmed bounded transcript search and adopts its status", async () => {
    const response = createDeferred<TranscriptSearchResponse>();
    const request = vi.fn(() => response.promise);
    const mutableGateway = createGateway({ request } as unknown as GatewayBrowserClient);
    mutableGateway.emit({
      hello: { features: { methods: ["sessions.search"] } } as ApplicationGatewaySnapshot["hello"],
    });
    const page = await createRenderedPage(
      createContext(mutableGateway.gateway, createSessions()),
      sessionsResult([{ key: "agent:main:launch", kind: "direct", updatedAt: 1 }], 1),
    );

    page.updateTranscriptSearchQuery("  launch code  ");
    const pending = page.runTranscriptSearch();
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    expect(request).toHaveBeenCalledWith("sessions.search", {
      scope: {
        agentId: "main",
        includeGlobal: true,
        includeUnknown: false,
        configuredAgentsOnly: true,
      },
      query: "launch code",
      limit: 25,
    });
    await page.updateComplete;
    expect(
      page.querySelector(".sessions-transcript-search__status")?.getAttribute("aria-busy"),
    ).toBe("true");

    const result: TranscriptSearchResponse = {
      sessions: [{ key: "agent:main:launch", kind: "direct", label: "Launch planning" }],
      results: [
        {
          sessionKey: "agent:main:launch",
          sessionId: "launch",
          messageId: "message-1",
          role: "user",
          timestamp: 42,
          snippet: "launch code",
          score: 1,
        },
      ],
      indexing: true,
      truncated: true,
      archivedTranscriptsExcluded: 3,
    };
    response.resolve(result);
    await pending;
    await page.updateComplete;

    expect(page.textContent).toContain(
      "3 archived transcripts excluded; open a session to restore its searchable history.",
    );
    expect(page.context.sessions.list).not.toHaveBeenCalled();
    expect(page.transcriptSearchQuery).toBe("launch code");
    expect(
      page.querySelector(".sessions-transcript-search__result-header strong")?.textContent,
    ).toBe("Launch planning");
    expect(page.querySelector(".sessions-transcript-search__snippet")?.textContent).toBe(
      "launch code",
    );
    expect(page.querySelector(".sessions-transcript-search__notice")?.textContent).toContain(
      t("sessionsView.transcriptSearchIndexing"),
    );
    expect(page.querySelector(".sessions-transcript-search__summary")?.textContent).toContain(
      t("sessionsView.transcriptSearchTruncated"),
    );
    expect(
      page.querySelector(".sessions-transcript-search__status")?.getAttribute("aria-busy"),
    ).toBe("false");
  });

  it("searches across agents once and renders bounded Gateway-ranked matches beyond the table", async () => {
    const matches = Array.from({ length: 25 }, (_, index) => ({
      sessionKey: `agent:${index % 2 === 0 ? "writer" : "main"}:match-${index}`,
      sessionId: `session-${index}`,
      messageId: `message-${index}`,
      role: "assistant" as const,
      timestamp: 25 - index,
      snippet: `needle match ${index}`,
      score: 25 - index,
    }));
    const request = vi.fn(async () => ({
      archivedTranscriptsExcluded: 3,
      truncated: true,
      sessions: matches.map((match, index) => ({
        key: match.sessionKey,
        kind: "direct" as const,
        label: `Matched task ${index}`,
      })),
      results: matches,
    }));
    const mutableGateway = createGateway({ request } as unknown as GatewayBrowserClient);
    mutableGateway.emit({
      hello: { features: { methods: ["sessions.search"] } } as ApplicationGatewaySnapshot["hello"],
    });
    const context = createContext(mutableGateway.gateway, createSessions());
    context.agentSelection.state.scopeId = null;
    const page = await createRenderedPage(context, {
      ...sessionsResult([{ key: "agent:main:visible", kind: "direct", updatedAt: 1 }], 1),
      totalCount: 10_000,
      hasMore: true,
      nextOffset: 1,
    });

    page.updateTranscriptSearchQuery("needle");
    await page.runTranscriptSearch();
    await page.updateComplete;

    expect(request).toHaveBeenCalledExactlyOnceWith("sessions.search", {
      query: "needle",
      limit: 25,
      scope: { includeGlobal: true, includeUnknown: false, configuredAgentsOnly: true },
    });
    expect(context.sessions.list).not.toHaveBeenCalled();
    expect(page.textContent).toContain(
      "3 archived transcripts excluded; open a session to restore its searchable history.",
    );
    expect(
      [...page.querySelectorAll(".sessions-transcript-search__key")].map(
        (element) => element.textContent,
      ),
    ).toEqual(matches.map((match) => match.sessionKey));
    expect(page.querySelector(".sessions-transcript-search__summary")?.textContent).toContain(
      t("sessionsView.transcriptSearchTruncated"),
    );
    expect(page.result?.sessions.map((row) => row.key)).toEqual(["agent:main:visible"]);
  });

  it("skips empty queries but searches connected gateways without method advertisement", async () => {
    const request = vi.fn(async () => ({ results: [], sessions: [] }));
    const mutableGateway = createGateway({ request } as unknown as GatewayBrowserClient);
    mutableGateway.emit({
      hello: gatewayHelloForMethods([]),
    });
    const page = await createRenderedPage(
      createContext(mutableGateway.gateway, createSessions()),
      sessionsResult([], 1),
    );

    page.updateTranscriptSearchQuery("   ");
    await page.runTranscriptSearch();
    await page.updateComplete;

    expect(request).not.toHaveBeenCalled();
    expect(page.querySelector(".sessions-transcript-search__status")?.textContent?.trim()).toBe("");
    expect(
      page.querySelector<HTMLButtonElement>('.sessions-transcript-search button[type="submit"]')
        ?.disabled,
    ).toBe(true);

    page.updateTranscriptSearchQuery("not advertised");
    await vi.waitFor(() =>
      expect(
        page.querySelector<HTMLButtonElement>('.sessions-transcript-search button[type="submit"]')
          ?.disabled,
      ).toBe(false),
    );
    page
      .querySelector<HTMLFormElement>(".sessions-transcript-search__form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() =>
      expect(page.querySelector(".sessions-transcript-search__empty")).not.toBeNull(),
    );
    expect(request).toHaveBeenCalledExactlyOnceWith("sessions.search", {
      query: "not advertised",
      limit: 25,
      scope: {
        agentId: "main",
        includeGlobal: true,
        includeUnknown: false,
        configuredAgentsOnly: true,
      },
    });
  });

  it("drops a transcript result after the query changes while it is pending", async () => {
    const response = createDeferred<TranscriptSearchResponse>();
    const request = vi.fn(() => response.promise);
    const mutableGateway = createGateway({ request } as unknown as GatewayBrowserClient);
    mutableGateway.emit({
      hello: { features: { methods: ["sessions.search"] } } as ApplicationGatewaySnapshot["hello"],
    });
    const page = await createRenderedPage(
      createContext(mutableGateway.gateway, createSessions()),
      sessionsResult([{ key: "agent:main:stale", kind: "direct", updatedAt: 1 }], 1),
    );

    page.updateTranscriptSearchQuery("old query");
    const pending = page.runTranscriptSearch();
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    page.updateTranscriptSearchQuery("new query");
    response.resolve({
      sessions: [{ key: "agent:main:stale", kind: "direct", label: "Stale task" }],
      results: [
        {
          sessionKey: "agent:main:stale",
          sessionId: "stale",
          messageId: "message-stale",
          role: "assistant",
          timestamp: 42,
          snippet: "old query",
          score: 1,
        },
      ],
    });
    await pending;
    await page.updateComplete;

    expect(page.transcriptSearchQuery).toBe("new query");
    expect(page.querySelector(".sessions-transcript-search__status")?.textContent?.trim()).toBe("");
  });

  it("drops transcript results and in-flight work when agent scope changes", async () => {
    const response = createDeferred<TranscriptSearchResponse>();
    const request = vi.fn(() => response.promise);
    const mutableGateway = createGateway({ request } as unknown as GatewayBrowserClient);
    mutableGateway.emit({
      hello: { features: { methods: ["sessions.search"] } } as ApplicationGatewaySnapshot["hello"],
    });
    const context = createContext(mutableGateway.gateway, createSessions());
    let notifyScopeChange: Parameters<ApplicationContext["agentSelection"]["subscribe"]>[0] = () =>
      undefined;
    context.agentSelection.subscribe = (listener) => {
      notifyScopeChange = listener;
      return () => undefined;
    };
    const page = await createRenderedPage(
      context,
      sessionsResult([{ key: "agent:main:stale", kind: "direct", updatedAt: 1 }], 1),
    );

    page.updateTranscriptSearchQuery("needle");
    const pending = page.runTranscriptSearch();
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    context.agentSelection.state.scopeId = null;
    notifyScopeChange(context.agentSelection.state);
    await page.updateComplete;

    expect(page.transcriptSearchQuery).toBe("needle");
    expect(page.querySelector(".sessions-transcript-search__result")).toBeNull();

    response.resolve({
      sessions: [{ key: "agent:main:stale", kind: "direct", label: "Stale task" }],
      results: [
        {
          sessionKey: "agent:main:stale",
          sessionId: "stale",
          messageId: "message-stale",
          role: "assistant",
          timestamp: 42,
          snippet: "needle",
          score: 1,
        },
      ],
    });
    await pending;
    await page.updateComplete;
    expect(page.querySelector(".sessions-transcript-search__status")?.textContent?.trim()).toBe("");
  });

  it.each(["same", "clear", "detach", "replace", "context"])(
    "keeps only current transcript matches after %s while a request is pending",
    async (action) => {
      const response = createDeferred<TranscriptSearchResponse>();
      const currentMatch: TranscriptSearchResponse = {
        sessions: [{ key: "agent:main:current", kind: "direct", label: "Current task" }],
        results: [
          {
            sessionKey: "agent:main:current",
            sessionId: "current",
            messageId: "message-current",
            role: "assistant",
            timestamp: 2,
            snippet: "replacement needle",
            score: 1,
          },
        ],
      };
      const request = vi.fn(async () => currentMatch).mockReturnValueOnce(response.promise);
      const mutableGateway = createGateway({ request } as unknown as GatewayBrowserClient);
      mutableGateway.emit({
        hello: {
          features: { methods: ["sessions.search"] },
        } as ApplicationGatewaySnapshot["hello"],
      });
      const context = createContext(mutableGateway.gateway, createSessions());
      const page = await createRenderedPage(context, sessionsResult([], 1));
      page.updateTranscriptSearchQuery("needle");
      const pending = page.runTranscriptSearch();
      await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
      await page.updateComplete;

      if (action === "clear") {
        page
          .querySelector<HTMLButtonElement>('.sessions-transcript-search button[type="button"]')!
          .click();
      } else if (action === "detach") {
        page.remove();
      } else if (action === "context") {
        page.context = createContext(mutableGateway.gateway, createSessions());
      } else if (action === "replace") {
        page.updateTranscriptSearchQuery("replacement needle");
        await page.runTranscriptSearch();
      } else {
        page.updateTranscriptSearchQuery("needle");
      }
      await page.updateComplete;
      response.resolve({
        sessions: [{ key: "agent:main:old", kind: "direct", label: "Old task" }],
        results: [
          {
            sessionKey: "agent:main:old",
            sessionId: "old",
            messageId: "message-old",
            role: "assistant",
            timestamp: 1,
            snippet: "original needle",
            score: 1,
          },
        ],
      });
      await pending;
      await page.updateComplete;

      expect(request).toHaveBeenCalledTimes(action === "replace" ? 2 : 1);
      expect(context.sessions.list).not.toHaveBeenCalled();
      expect(page.context.sessions.list).not.toHaveBeenCalled();
      expect(page.querySelector(".sessions-transcript-search__snippet")?.textContent).toBe(
        action === "same"
          ? "original needle"
          : action === "replace"
            ? "replacement needle"
            : undefined,
      );
      expect(
        page.querySelector(".sessions-transcript-search__status")?.getAttribute("aria-busy"),
      ).toBe("false");
    },
  );

  it("shows an unavailable unadvertised search RPC and retries the same submitted query", async () => {
    const request = vi
      .fn(async () => ({ results: [], sessions: [] }))
      .mockRejectedValueOnce(new Error("search unavailable"));
    const mutableGateway = createGateway({ request } as unknown as GatewayBrowserClient);
    mutableGateway.emit({
      hello: gatewayHelloForMethods([]),
    });
    const page = await createRenderedPage(
      createContext(mutableGateway.gateway, createSessions()),
      sessionsResult([], 1),
    );
    page.updateTranscriptSearchQuery("needle");
    await page.runTranscriptSearch();
    await page.updateComplete;
    expect(page.querySelector(".sessions-transcript-search__notice")?.textContent).toContain(
      "search unavailable",
    );
    expect(request).toHaveBeenCalledOnce();

    page.querySelector<HTMLButtonElement>(".sessions-transcript-search__notice button")!.click();
    await vi.waitFor(() =>
      expect(page.querySelector(".sessions-transcript-search__empty")).not.toBeNull(),
    );
    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenLastCalledWith("sessions.search", {
      query: "needle",
      limit: 25,
      scope: {
        agentId: "main",
        includeGlobal: true,
        includeUnknown: false,
        configuredAgentsOnly: true,
      },
    });
    expect(page.context.sessions.list).not.toHaveBeenCalled();
    expect(page.querySelector(".sessions-transcript-search__notice")).toBeNull();
  });

  it("searches the changed membership scope without waiting for the metadata list", async () => {
    const refresh = createDeferred();
    const request = vi.fn(async () => ({ results: [], sessions: [] }));
    const mutableGateway = createGateway({ request } as unknown as GatewayBrowserClient);
    mutableGateway.emit({
      hello: { features: { methods: ["sessions.search"] } } as ApplicationGatewaySnapshot["hello"],
    });
    const managed = createManagedSessions();
    const page = await createRenderedPage(
      createContext(mutableGateway.gateway, managed.sessions),
      sessionsResult([{ key: "agent:main:old-scope", kind: "direct" }], 1),
    );
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
      scope: {
        agentId: "main",
        includeGlobal: true,
        includeUnknown: true,
        configuredAgentsOnly: true,
      },
    });
    expect(page.querySelector(".sessions-transcript-search__empty")).not.toBeNull();
    refresh.resolve();
    await vi.waitFor(() => expect(page.refreshing).toBe(false));
  });

  it.each([false, true])(
    "keeps transcript match titles independent of metadata filtering (initially in table: %s)",
    async (initiallyInTable) => {
      const matchingRow = {
        key: "agent:main:content-only",
        kind: "direct" as const,
        label: "Lunar museum itinerary",
        updatedAt: 1,
      };
      const metadataRow = {
        key: "agent:main:metadata-only",
        kind: "direct" as const,
        label: "Metadata-only task",
        updatedAt: 2,
      };
      const request = vi.fn(async () => ({
        sessions: [matchingRow],
        results: [
          {
            sessionKey: matchingRow.key,
            sessionId: "content-only",
            messageId: "message-content-only",
            role: "assistant" as const,
            timestamp: 1,
            snippet: "A needle in the lunar museum itinerary.",
            score: 1,
          },
        ],
      }));
      const mutableGateway = createGateway({ request } as unknown as GatewayBrowserClient);
      mutableGateway.emit({
        hello: {
          features: { methods: ["sessions.search"] },
        } as ApplicationGatewaySnapshot["hello"],
      });
      const managed = createManagedSessions();
      const page = await createRenderedPage(
        createContext(mutableGateway.gateway, managed.sessions),
        sessionsResult(initiallyInTable ? [matchingRow, metadataRow] : [metadataRow], 1),
      );
      const heading = () =>
        page.querySelector(".sessions-transcript-search__result-header strong")?.textContent;
      const form = () => page.querySelector<HTMLFormElement>(".sessions-transcript-search__form")!;
      try {
        const transcriptInput = page.querySelector<HTMLInputElement>(
          ".sessions-transcript-search__input input",
        )!;
        transcriptInput.value = "needle";
        transcriptInput.dispatchEvent(new Event("input", { bubbles: true }));
        await page.updateComplete;
        await vi.waitFor(() =>
          expect(form().querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(
            false,
          ),
        );
        form().dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
        await vi.waitFor(() => expect(heading()).toBe(matchingRow.label));
        expect(request).toHaveBeenCalledOnce();
        expect(managed.sessions.list).not.toHaveBeenCalled();

        const input = page.querySelector<HTMLInputElement>(".sessions-toolbar__search input")!;
        input.value = "metadata-only";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        await page.updateComplete;
        expect(heading()).toBe(matchingRow.label);
        await vi.waitFor(() =>
          expect(managed.refreshList).toHaveBeenCalledWith(
            expect.objectContaining({ search: "metadata-only" }),
          ),
        );
        const [query] = managed.subscribeList.mock.calls.at(-1)!;
        managed.publish(query, {
          result: sessionsResult([metadataRow], 2),
          agentId: "main",
          loading: false,
          error: null,
        });
        await page.updateComplete;
        expect(page.result?.sessions.map((row) => row.key)).toEqual([metadataRow.key]);
        expect(heading()).toBe(matchingRow.label);
        expect(page.querySelector(".sessions-transcript-search__snippet")?.textContent).toBe(
          "A needle in the lunar museum itinerary.",
        );
        expect(request).toHaveBeenCalledOnce();
        expect(managed.sessions.list).not.toHaveBeenCalled();

        form().dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
        await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
        await vi.waitFor(() => expect(heading()).toBe(matchingRow.label));
        expect(managed.sessions.list).not.toHaveBeenCalled();
        expect(request).toHaveBeenLastCalledWith("sessions.search", {
          query: "needle",
          limit: 25,
          scope: {
            agentId: "main",
            includeGlobal: true,
            includeUnknown: false,
            configuredAgentsOnly: true,
          },
        });
      } finally {
        page.remove();
      }
    },
  );

  it.each(["completed", "pending"])(
    "retires %s active-session matches when the route changes to archived sessions",
    async (completion) => {
      const response = createDeferred<TranscriptSearchResponse>();
      const request = vi.fn(() => response.promise);
      const mutableGateway = createGateway({ request } as unknown as GatewayBrowserClient);
      mutableGateway.emit({
        hello: {
          features: { methods: ["sessions.search"] },
        } as ApplicationGatewaySnapshot["hello"],
      });
      const context = createContext(mutableGateway.gateway, createSessions());
      const activeRow: GatewaySessionRow = {
        key: "agent:main:active",
        kind: "direct",
        label: "Active task",
        archived: false,
      };
      const page = await createRenderedPage(context, sessionsResult([activeRow], 1));
      page.updateTranscriptSearchQuery("release notes");
      const pending = page.runTranscriptSearch();
      await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
      const result: TranscriptSearchResponse = {
        sessions: [activeRow],
        results: [
          {
            sessionKey: "agent:main:active",
            sessionId: "active",
            messageId: "message-active",
            role: "assistant",
            timestamp: 42,
            snippet: "release notes from the active task",
            score: 1,
          },
        ],
      };
      if (completion === "completed") {
        response.resolve(result);
        await pending;
        await page.updateComplete;
        expect(page.textContent).toContain("release notes from the active task");
      }

      page.routeData = {
        expandedSessionKey: null,
        statusFilter: "archived",
      };
      await page.updateComplete;
      if (completion === "pending") {
        response.resolve(result);
        await pending;
        await page.updateComplete;
      }

      expect(page.statusFilter).toBe("archived");
      expect(page.textContent).not.toContain("release notes from the active task");
      expect(page.transcriptSearchQuery).toBe("release notes");
      await vi.waitFor(() =>
        expect(page.querySelector(".sessions-transcript-search__status")?.textContent?.trim()).toBe(
          "",
        ),
      );
      request.mockResolvedValueOnce({ results: [], sessions: [] });
      await page.runTranscriptSearch();
      await page.updateComplete;
      expect(page.querySelector(".sessions-transcript-search__empty")).not.toBeNull();
      expect(request).toHaveBeenLastCalledWith("sessions.search", {
        query: "release notes",
        limit: 25,
        scope: {
          agentId: "main",
          archived: true,
          includeGlobal: true,
          includeUnknown: false,
          configuredAgentsOnly: true,
        },
      });
    },
  );
});
