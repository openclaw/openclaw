/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionsSearchResult } from "../../../packages/gateway-protocol/src/index.js";
import type { SessionsListResult } from "../api/types.ts";
import type { ApplicationContext } from "../app/context.ts";
import { installDialogPolyfill } from "../test-helpers/modal-dialog.ts";
import {
  createContext,
  createGateway,
  createSessionResult,
  enterQuery,
  findPaletteOption,
  mountPalette,
} from "./command-palette.test-support.ts";
import "./command-palette.ts";

describe("CommandPalette session search", () => {
  let restoreDialogPolyfill: () => void;
  beforeEach(() => {
    vi.useFakeTimers();
    restoreDialogPolyfill = installDialogPolyfill();
  });
  afterEach(() => {
    document.body.replaceChildren();
    restoreDialogPolyfill();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each([false, true])(
    "keeps transcript snippets with a server metadata match: %s",
    async (serverMatch) => {
      const metadata = createSessionResult("agent:main:metadata", "needle");
      const contextOnly = createSessionResult("agent:main:context", "Unrelated title");
      const roster = {
        ...metadata,
        count: 2,
        totalCount: 2,
        sessions: [...metadata.sessions, ...contextOnly.sessions],
      } as SessionsListResult;
      const list = vi.fn<ApplicationContext["sessions"]["list"]>(async (options) =>
        options?.search && !serverMatch ? metadata : roster,
      );
      const searchResult: SessionsSearchResult = {
        sessions: contextOnly.sessions,
        results: [
          {
            sessionKey: "agent:main:context",
            sessionId: "context",
            messageId: "message-context",
            role: "assistant",
            timestamp: 42,
            snippet: "The needle appears only in the conversation body.",
            score: 10,
          },
        ],
      };
      const request = vi.fn(async (method: string) =>
        method === "models.list" ? { models: [] } : searchResult,
      );
      const { gateway } = createGateway(true, {
        methods: ["sessions.search"],
        request,
      });
      const { palette } = await mountPalette(createContext(gateway, list));

      await enterQuery(palette, "needle");
      await vi.advanceTimersByTimeAsync(50);
      await vi.waitFor(() =>
        expect(request.mock.calls.filter(([method]) => method === "sessions.search")).toHaveLength(
          1,
        ),
      );
      await palette.updateComplete;

      expect(request).toHaveBeenCalledWith("sessions.search", {
        query: "needle",
        limit: 25,
        scope: {
          includeGlobal: false,
          includeUnknown: false,
          configuredAgentsOnly: true,
          excludeSubagents: true,
          excludeCron: true,
          excludeSystem: true,
        },
      });
      const chatItems = [...palette.querySelectorAll<HTMLElement>(".cmd-palette__item")];
      expect(chatItems).toHaveLength(2);
      expect(chatItems[0]?.textContent).toContain("needle");
      expect(chatItems[1]?.textContent).toContain("Unrelated title");
      expect(chatItems[1]?.textContent).toContain("needle appears only in the conversation body");
      expect(palette.querySelectorAll(".cmd-palette__input")).toHaveLength(1);
    },
  );

  it("finds an older transcript beyond the first 200 sessions without downloading the roster", async () => {
    const older = createSessionResult("agent:main:older", "Older planning discussion");
    const recent = Array.from({ length: 200 }, (_, index) => ({
      key: "agent:main:recent-" + index,
      kind: "direct" as const,
      displayName: "Recent discussion " + index,
      updatedAt: 300 - index,
    }));
    const list = vi.fn<ApplicationContext["sessions"]["list"]>(async (options) => {
      const rows = options?.search ? [] : [...recent, ...older.sessions];
      const offset = options?.offset ?? 0;
      const limit = options?.limit ?? 100;
      return {
        ...older,
        count: Math.min(limit, rows.length - offset),
        totalCount: rows.length,
        hasMore: offset + limit < rows.length,
        nextOffset: offset + limit < rows.length ? offset + limit : null,
        sessions: rows.slice(offset, offset + limit),
      };
    });
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method !== "sessions.search") {
        return { models: [] };
      }
      const keys = (params as { sessionKeys?: string[] }).sessionKeys;
      const includesOlder = !keys || keys.includes("agent:main:older");
      return {
        sessions: includesOlder ? older.sessions : [],
        results: includesOlder
          ? [
              {
                sessionKey: "agent:main:older",
                sessionId: "older",
                messageId: "older-message",
                role: "assistant",
                timestamp: 1,
                snippet: "The uncommonneedle is only in this older conversation.",
                score: 1,
              },
            ]
          : [],
      };
    });
    const { gateway } = createGateway(true, { methods: ["sessions.search"], request });
    const { palette } = await mountPalette(createContext(gateway, list));
    await enterQuery(palette, "uncommonneedle");
    await vi.advanceTimersByTimeAsync(50);
    await palette.updateComplete;

    expect(palette.textContent).toContain("Older planning discussion");
    expect(palette.textContent).toContain("uncommonneedle is only in this older conversation");
    expect(list.mock.calls.every(([options]) => Boolean(options?.search))).toBe(true);
    expect(palette.textContent).not.toContain("Search notices");
  });

  it("keeps metadata matches selectable when transcript search fails", async () => {
    const metadata = createSessionResult("agent:main:metadata", "Needle planning");
    const list = vi.fn<ApplicationContext["sessions"]["list"]>(async () => metadata);
    const request = vi.fn(async (method: string) => {
      if (method === "models.list") {
        return { models: [] };
      }
      throw new Error("transcript index unavailable");
    });
    const { gateway } = createGateway(true, {
      methods: ["sessions.search"],
      request,
    });
    const { palette } = await mountPalette(createContext(gateway, list));

    await enterQuery(palette, "needle");
    await vi.advanceTimersByTimeAsync(50);
    await vi.waitFor(() =>
      expect(request.mock.calls.filter(([method]) => method === "sessions.search")).toHaveLength(1),
    );
    await palette.updateComplete;

    expect(palette.querySelector('[role="listbox"]')?.getAttribute("aria-busy")).toBe("false");
    const metadataItem = findPaletteOption(palette, "Needle planning");
    expect(metadataItem?.textContent).toContain("Needle planning");
    metadataItem?.click();
    expect(palette.onSelectSession).toHaveBeenCalledWith("agent:main:metadata");
    expect(palette.textContent).toContain(
      "Transcript search unavailable — showing chat titles and metadata",
    );
    expect(palette.textContent).not.toContain("Chat search failed");
  });

  it.each([
    {
      state: "indexing",
      response: { indexing: true },
      notice: "Indexing older messages — search again shortly.",
    },
    {
      state: "truncated",
      response: { truncated: true },
      notice: null,
    },
    {
      state: "archived",
      response: { archivedTranscriptsExcluded: 3 },
      notice: "3 archived transcripts excluded; open a session to restore its searchable history.",
    },
  ])(
    "shows a partial-search notice when transcript results are $state",
    async ({ response, notice }) => {
      const metadata = createSessionResult("agent:main:metadata", "Needle planning");
      const contextOnly = createSessionResult("agent:main:context", "Unrelated title");
      const roster = {
        ...metadata,
        count: 2,
        totalCount: 2,
        sessions: [...metadata.sessions, ...contextOnly.sessions],
      } as SessionsListResult;
      const list = vi.fn<ApplicationContext["sessions"]["list"]>(async (options) =>
        options?.search ? metadata : roster,
      );
      const request = vi.fn(async (method: string) =>
        method === "models.list"
          ? { models: [] }
          : {
              sessions: contextOnly.sessions,
              results: [
                {
                  sessionKey: "agent:main:context",
                  sessionId: "context",
                  messageId: "message-context",
                  role: "assistant" as const,
                  timestamp: 42,
                  snippet: "The needle also appears in this transcript.",
                  score: 10,
                },
              ],
              ...response,
            },
      );
      const { gateway } = createGateway(true, {
        methods: ["sessions.search"],
        request,
      });
      const { palette } = await mountPalette(createContext(gateway, list));

      await enterQuery(palette, "needle");
      await vi.advanceTimersByTimeAsync(50);
      await vi.waitFor(() =>
        expect(request.mock.calls.filter(([method]) => method === "sessions.search")).toHaveLength(
          1,
        ),
      );
      await palette.updateComplete;

      expect(palette.querySelector('[role="listbox"]')?.getAttribute("aria-busy")).toBe("false");
      if (notice) {
        expect(palette.textContent).toContain(notice);
      } else {
        expect(palette.textContent).not.toContain("Search notices");
        expect(palette.textContent).not.toContain("may be incomplete");
      }
      expect(palette.textContent).toContain("Needle planning");
      expect(palette.textContent).toContain("Unrelated title");
      expect(palette.textContent).toContain("needle also appears in this transcript");
    },
  );
});
