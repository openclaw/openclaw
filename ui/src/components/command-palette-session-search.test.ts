/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionsSearchResult } from "../../../packages/gateway-protocol/src/index.js";
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

  it.each([
    {
      name: "punctuation-normalized title",
      query: "per session communi",
      title: "Per-session communication controls in UI",
      sameSession: true,
    },
    { name: "transcript-only match", serverMatch: false },
    { name: "server metadata match", serverMatch: true },
    {
      name: "indexing",
      response: { indexing: true },
      notice: "Indexing older messages — search again shortly.",
    },
    { name: "truncated", response: { truncated: true } },
    {
      name: "archived",
      response: { archivedTranscriptsExcluded: 3 },
      notice: "3 archived transcripts excluded; open a session to restore its searchable history.",
    },
    {
      name: "transcript failure",
      failure: true,
      notice: "Transcript search unavailable — showing chat titles and metadata",
    },
  ])("keeps metadata and transcript results selectable: $name", async (scenario) => {
    const query = scenario.query ?? "needle";
    const title = scenario.title ?? "needle";
    const metadata = createSessionResult("agent:main:metadata", title);
    const contextOnly = scenario.sameSession
      ? metadata
      : createSessionResult("agent:main:context", "Unrelated title");
    const roster = {
      ...metadata,
      count: 2,
      totalCount: 2,
      sessions: [...metadata.sessions, ...contextOnly.sessions],
    };
    const list = vi.fn<ApplicationContext["sessions"]["list"]>(async (options) =>
      options?.search && !scenario.serverMatch ? metadata : roster,
    );
    const searchResult: SessionsSearchResult = {
      sessions: contextOnly.sessions,
      results: [
        {
          sessionKey: contextOnly.sessions[0]!.key,
          sessionId: "context",
          messageId: "message-context",
          role: "assistant",
          timestamp: 42,
          snippet: "The needle appears only in the conversation body.",
          score: 10,
        },
      ],
      ...scenario.response,
    };
    const request = vi.fn(async (method: string) => {
      if (method === "models.list") {
        return { models: [] };
      }
      if (scenario.failure) {
        throw new Error("transcript index unavailable");
      }
      return searchResult;
    });
    const { gateway } = createGateway(true, { methods: ["sessions.search"], request });
    const { palette } = await mountPalette(createContext(gateway, list));
    await enterQuery(palette, query);
    await vi.advanceTimersByTimeAsync(200);
    await palette.updateComplete;
    expect(request.mock.calls.filter(([method]) => method === "sessions.search")).toHaveLength(1);
    expect(request).toHaveBeenCalledWith("sessions.search", {
      query,
      limit: 25,
      scope: {
        includeGlobal: false,
        includeUnknown: false,
        configuredAgentsOnly: true,
        excludeSubagents: true,
        excludeCron: true,
        excludeSystem: true,
        excludeDock: true,
      },
    });
    expect(palette.querySelector('[role="listbox"]')?.getAttribute("aria-busy")).toBe("false");
    const items = [...palette.querySelectorAll<HTMLElement>(".cmd-palette__item")];
    expect(items).toHaveLength(scenario.sameSession || scenario.failure ? 1 : 2);
    expect(items[0]?.textContent).toContain(title);
    expect(palette.querySelectorAll(".cmd-palette__input")).toHaveLength(1);
    if (scenario.sameSession) {
      const buttons = [...palette.querySelectorAll("button")];
      expect(buttons.some((button) => button.textContent?.match(/Sessions\s*1/u))).toBe(true);
      expect(buttons.some((button) => button.textContent?.match(/Messages\s*0/u))).toBe(true);
    } else if (!scenario.failure) {
      expect(items[1]?.textContent).toContain("Unrelated title");
      expect(items[1]?.textContent).toContain("needle appears only in the conversation body");
    }
    if (scenario.notice) {
      expect(palette.textContent).toContain(scenario.notice);
    } else {
      expect(palette.textContent).not.toContain("Search notices");
      expect(palette.textContent).not.toContain("may be incomplete");
    }
    expect(palette.textContent).not.toContain("Chat search failed");
    findPaletteOption(palette, title)!.click();
    expect(palette.onSelectSession).toHaveBeenCalledWith("agent:main:metadata");
  });

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
    await vi.advanceTimersByTimeAsync(200);
    await palette.updateComplete;

    expect(palette.textContent).toContain("Older planning discussion");
    expect(palette.textContent).toContain("uncommonneedle is only in this older conversation");
    expect(list.mock.calls.every(([options]) => Boolean(options?.search))).toBe(true);
    expect(palette.textContent).not.toContain("Search notices");
  });
});
