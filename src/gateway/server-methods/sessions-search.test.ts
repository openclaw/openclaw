/** Gateway session-search validation and agent-scoping tests. */

import { mkdirSync } from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { resolveSessionStorePathCore } from "../../config/sessions.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.js";
import { applySessionEntryCanonicalReplacements } from "../../config/sessions/session-accessor.sqlite-replacement-projection.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { prepareUserProfileCatalog } from "../../state/user-profile-list.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { GatewayRequestContext, RespondFn } from "./types.js";

const fixedStorePath = path.resolve("/stores/shared/sessions.sqlite");
const templateStorePath = path.resolve("/stores/{agentId}.json");

const searchSessionTranscriptsMock = vi.fn();
const readSessionEntriesMock = vi.fn();
const readSessionEntrySummariesMock = vi.fn();
const resolveExistingAgentSessionStoreTargetsAsyncMock = vi.fn();

vi.mock("../../config/sessions/session-transcript-search.js", () => ({
  searchSessionTranscripts: (...args: unknown[]) => searchSessionTranscriptsMock(...args),
}));
vi.mock("../../config/sessions/session-entry-read-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/sessions/session-entry-read-runtime.js")>()),
  readSessionEntriesFromStoreInWorker: (...args: unknown[]) => readSessionEntriesMock(...args),
  readSessionEntrySummariesInWorker: (...args: unknown[]) => readSessionEntrySummariesMock(...args),
}));
vi.mock("../../config/sessions/targets-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/sessions/targets-runtime.js")>()),
  resolveExistingAgentSessionStoreTargetsAsync: (...args: unknown[]) =>
    resolveExistingAgentSessionStoreTargetsAsyncMock(...args),
}));

import { sessionReadHandlers } from "./sessions-read.js";

let cfg: OpenClawConfig = {
  agents: {
    ownership: "explicit",
    defaults: { systemAgent: { agentId: "main" } },
    entries: { main: {}, work: {} },
  },
};

async function callSearch(
  params: Record<string, unknown>,
  scopes?: string[],
  profileId?: string,
): Promise<ReturnType<typeof vi.fn>> {
  const respond = vi.fn();
  await expectDefined(
    sessionReadHandlers["sessions.search"],
    'sessionReadHandlers["sessions.search"] test invariant',
  )({
    req: { id: "req-search" } as never,
    params,
    respond: respond as unknown as RespondFn,
    context: { getRuntimeConfig: () => cfg } as unknown as GatewayRequestContext,
    client: scopes
      ? ({
          connect: { scopes },
          ...(profileId
            ? {
                authenticatedUserProfile: {
                  profileId,
                  displayName: null,
                  hasAvatar: false,
                  updatedAt: 1,
                },
              }
            : {}),
        } as never)
      : null,
    isWebchatConnect: () => false,
  });
  return respond;
}

async function useRestrictedSearchMetadata(others: "none" | "view" = "none") {
  const accessor = await vi.importActual<
    typeof import("../../config/sessions/session-entry-read-runtime.js")
  >("../../config/sessions/session-entry-read-runtime.js");
  const sessions = await vi.importActual<typeof import("../../config/sessions/targets-runtime.js")>(
    "../../config/sessions/targets-runtime.js",
  );
  readSessionEntriesMock.mockImplementation(accessor.readSessionEntriesFromStoreInWorker);
  readSessionEntrySummariesMock.mockImplementation(accessor.readSessionEntrySummariesInWorker);
  resolveExistingAgentSessionStoreTargetsAsyncMock.mockImplementation(
    sessions.resolveExistingAgentSessionStoreTargetsAsync,
  );
  searchSessionTranscriptsMock.mockImplementation((params: { sessionKeys?: string[] }) => ({
    hits: (params.sessionKeys ?? []).map((sessionKey) => ({
      sessionKey,
      sessionId: sessionKey,
      messageId: `message:${sessionKey}`,
      role: "user",
      timestamp: 1,
      snippet: "needle",
      score: 1,
    })),
    indexing: false,
  }));
  cfg = {
    agents: { ownership: "explicit", entries: { main: {} } },
    gateway: {
      roles: {
        default: "restricted",
        definitions: {
          restricted: { sessions: { others }, agents: "*", scopes: ["operator.read"] },
        },
      },
    },
  };
  setRuntimeConfigSnapshot(cfg);
  return {
    viewer: ensureProfileForEmail("search-viewer@example.test"),
    other: ensureProfileForEmail("search-other@example.test"),
  };
}

const profileState = { scenario: "minimal", prepareProfileCatalog: true } as const;

function useScopedSearchRows(sessionKeys: string[]) {
  const rows = sessionKeys.map((sessionKey) => ({
    sessionKey,
    entry: { sessionId: sessionKey, updatedAt: 1, visibility: "shared" },
  }));
  readSessionEntriesMock.mockImplementation((params: { sessionKeys: string[] }) => ({
    entries: rows.filter((row) => params.sessionKeys.includes(row.sessionKey)),
  }));
}

describe("sessions.search gateway method", () => {
  beforeEach(() => {
    cfg = {
      agents: {
        ownership: "explicit",
        defaults: { systemAgent: { agentId: "main" } },
        entries: { main: {}, work: {} },
      },
    };
    searchSessionTranscriptsMock.mockReset();
    searchSessionTranscriptsMock.mockReturnValue({ hits: [], indexing: false });
    readSessionEntriesMock.mockReset();
    readSessionEntriesMock.mockResolvedValue({ entries: [] });
    readSessionEntrySummariesMock.mockReset();
    readSessionEntrySummariesMock.mockResolvedValue([]);
    resolveExistingAgentSessionStoreTargetsAsyncMock.mockReset();
    resolveExistingAgentSessionStoreTargetsAsyncMock.mockResolvedValue([]);
  });

  it("finds visible rows in a cold retired main store without an explicit key filter", async () => {
    await withOpenClawTestState(profileState, async () => {
      const { viewer, other } = await useRestrictedSearchMetadata();
      using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
      const visibleKey = "agent:main:retained";
      for (const [sessionKey, profileId] of [
        [visibleKey, viewer.id],
        ["agent:main:foreign", other.id],
      ] as const) {
        replaceSessionEntrySync(
          { agentId: "main", sessionKey },
          {
            sessionId: sessionKey,
            updatedAt: 1,
            visibility: "shared",
            createdActor: { type: "human", source: "profile", id: profileId },
          },
        );
      }
      cfg = { ...cfg, agents: { ownership: "explicit", entries: { research: {} } } };
      setRuntimeConfigSnapshot(cfg);
      closeOpenClawAgentDatabasesForTest();

      const respond = await callSearch(
        { agentId: "main", query: "needle" },
        ["operator.read"],
        viewer.id,
      );
      expect(respond).toHaveBeenCalledWith(true, {
        results: [expect.objectContaining({ sessionKey: visibleKey })],
      });
    });
  });

  it("reports duplicate retired rows before searching either transcript store", async () => {
    await withOpenClawTestState(profileState, async (state) => {
      const { viewer } = await useRestrictedSearchMetadata();
      using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
      cfg = {
        ...cfg,
        session: { store: state.statePath("agents", "{agentId}", "sessions", "sessions.json") },
      };
      setRuntimeConfigSnapshot(cfg);
      const sessionKey = "agent:retired-agent:main";
      for (const directory of ["Retired Agent", "retired-agent"]) {
        const storePath = state.statePath("agents", directory, "sessions", "sessions.json");
        mkdirSync(path.dirname(storePath), { recursive: true });
        replaceSessionEntrySync(
          { agentId: "retired-agent", sessionKey, storePath },
          {
            sessionId: directory === "Retired Agent" ? "retired-first" : "retired-second",
            updatedAt: 1,
            createdActor: { type: "human", source: "profile", id: viewer.id },
          },
        );
      }

      const respond = await callSearch(
        { agentId: "retired-agent", query: "needle" },
        ["operator.read"],
        viewer.id,
      );
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({
          code: "UNAVAILABLE",
          message: expect.stringContaining("duplicate rows"),
        }),
      );
      expect(searchSessionTranscriptsMock).not.toHaveBeenCalled();
    });
  });

  it("hides a retired session whose visibility changes while its transcript is searched", async () => {
    await withOpenClawTestState(profileState, async () => {
      const { viewer, other } = await useRestrictedSearchMetadata("view");
      using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
      const sessionKey = "agent:main:retained";
      const entry = {
        sessionId: "retained-session",
        updatedAt: 1,
        visibility: "shared" as const,
        createdActor: { type: "human" as const, source: "profile" as const, id: other.id },
      };
      replaceSessionEntrySync({ agentId: "main", sessionKey }, entry);
      cfg = { ...cfg, agents: { ownership: "explicit", entries: { research: {} } } };
      setRuntimeConfigSnapshot(cfg);
      searchSessionTranscriptsMock.mockImplementationOnce(() => {
        replaceSessionEntrySync({ agentId: "main", sessionKey }, { ...entry, visibility: "draft" });
        return {
          hits: [{ sessionKey, sessionId: entry.sessionId, messageId: "private", score: 1 }],
          indexing: false,
        };
      });

      const respond = await callSearch(
        { agentId: "main", query: "needle" },
        ["operator.read"],
        viewer.id,
      );

      expect(respond).toHaveBeenCalledWith(true, { results: [] });
    });
  });

  it("filters confidential rows before scoped and unscoped FTS for creator, selected and outsider", async () => {
    await withOpenClawTestState(profileState, async () => {
      const { viewer: selected, other: creator } = await useRestrictedSearchMetadata("view");
      const outsider = ensureProfileForEmail("search-outsider@example.test");
      using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
      const sessionKey = "agent:main:confidential";
      replaceSessionEntrySync(
        { agentId: "main", sessionKey },
        {
          sessionId: "confidential-search",
          updatedAt: 1,
          visibility: "shared",
          access: { mode: "audience", profileIds: [selected.id] },
          createdActor: { type: "human", source: "profile", id: creator.id },
        },
      );
      for (const profile of [creator, selected, outsider]) {
        for (const sessionKeys of [undefined, [sessionKey]]) {
          searchSessionTranscriptsMock.mockClear();
          const respond = await callSearch(
            { query: "needle", ...(sessionKeys ? { sessionKeys } : {}) },
            ["operator.read"],
            profile.id,
          );
          const allowed = profile !== outsider;
          expect(respond).toHaveBeenCalledWith(true, {
            results: allowed ? [expect.objectContaining({ sessionKey })] : [],
          });
          if (allowed) {
            expect(searchSessionTranscriptsMock).toHaveBeenCalledExactlyOnceWith(
              expect.objectContaining({ sessionKeys: [sessionKey] }),
            );
          } else {
            expect(searchSessionTranscriptsMock).not.toHaveBeenCalled();
          }
        }
      }
    });
  });

  it("rechecks confidential audience before publishing transcript hits", async () => {
    await withOpenClawTestState(profileState, async () => {
      const { viewer, other } = await useRestrictedSearchMetadata("view");
      using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
      const sessionKey = "agent:main:revoked-audience";
      const entry = {
        sessionId: "revoked-audience",
        updatedAt: 1,
        visibility: "shared" as const,
        createdActor: { type: "human" as const, source: "profile" as const, id: other.id },
      };
      replaceSessionEntrySync(
        { agentId: "main", sessionKey },
        { ...entry, access: { mode: "audience", profileIds: [viewer.id] } },
      );
      searchSessionTranscriptsMock.mockImplementationOnce(async () => {
        // Ordinary bookkeeping preserves access; only the canonical owner may revoke it.
        await applySessionEntryCanonicalReplacements({
          agentId: "main",
          storePath: resolveSessionStorePathCore(cfg.session?.store, { agentId: "main" }),
          sessionKeys: [sessionKey],
          update: (rows) => ({
            result: undefined,
            replacements: rows.map((row) => ({
              ...row,
              previousSessionKeys: [],
              accessMutation: true,
              entry: { ...row.entry, access: { mode: "creator" as const } },
            })),
          }),
        });
        return {
          hits: [{ sessionKey, sessionId: entry.sessionId, messageId: "private", score: 1 }],
          indexing: false,
        };
      });
      const respond = await callSearch({ query: "needle" }, ["operator.read"], viewer.id);
      expect(searchSessionTranscriptsMock).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ sessionKeys: [sessionKey] }),
      );
      expect(respond).toHaveBeenCalledWith(true, { results: [] });
    });
  });

  it("validates params and rejects whitespace-only queries", async () => {
    const invalidLimit = await callSearch({ query: "needle", limit: 26 });
    expect(invalidLimit).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );

    const emptyQuery = await callSearch({ query: "   " });
    expect(emptyQuery).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: "query must not be empty" }),
    );
    expect(searchSessionTranscriptsMock).not.toHaveBeenCalled();
  });

  it.each([undefined, fixedStorePath, templateStorePath])(
    "derives one agent and canonical filters from sessionKeys with store %s",
    async (storePath) => {
      if (storePath) {
        cfg = { ...cfg, session: { store: storePath } };
      }
      useScopedSearchRows(["agent:work:main", "agent:work:other"]);
      searchSessionTranscriptsMock.mockReturnValue({
        hits: [
          {
            sessionKey: "agent:work:main",
            sessionId: "session-work",
            messageId: "message-1",
            role: "assistant",
            timestamp: 123,
            snippet: "needle",
            score: 1,
          },
        ],
        indexing: true,
        truncated: true,
      });

      const respond = await callSearch({
        query: " needle ",
        sessionKeys: ["agent:work:main", "agent:work:other"],
        limit: 5,
      });

      expect(searchSessionTranscriptsMock).toHaveBeenCalledWith({
        agentId: "work",
        query: "needle",
        limit: 5,
        sessionKeys: ["agent:work:main", "agent:work:other"],
        storePath: storePath?.replace("{agentId}", "work") ?? expect.any(String),
      });
      expect(respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({
          indexing: true,
          truncated: true,
          results: [expect.objectContaining({ score: 1 })],
        }),
      );
    },
  );

  it("rejects a bare fixed-store key scoped to a non-owner before transcript lookup", async () => {
    cfg = {
      session: { store: fixedStorePath },
      agents: {
        ownership: "explicit",
        defaults: { sessionStore: { agentId: "ops" } },
        entries: { ops: {}, research: {} },
      },
    };

    const respond = await callSearch({
      agentId: "research",
      query: "needle",
      sessionKeys: ["global"],
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: 'agent "research" does not match session key agent "ops"',
      }),
    );
    expect(searchSessionTranscriptsMock).not.toHaveBeenCalled();
  });

  it("filters incognito candidates before applying a non-admin result limit", async () => {
    const incognitoKey = "agent:main:dashboard:incognito-newer";
    const durableKey = "agent:main:dashboard:durable";
    const incognitoHit = {
      sessionKey: incognitoKey,
      sessionId: "session-incognito",
      messageId: "message-incognito",
      role: "user",
      timestamp: 200,
      snippet: "needle private",
      score: 10,
    };
    const durableHit = {
      sessionKey: durableKey,
      sessionId: "session-durable",
      messageId: "message-durable",
      role: "user",
      timestamp: 100,
      snippet: "needle durable",
      score: 1,
    };
    searchSessionTranscriptsMock.mockImplementation(
      (params: { limit?: number; sessionKeys?: string[] }) => {
        const candidates = [incognitoHit, durableHit].filter((hit) =>
          params.sessionKeys?.includes(hit.sessionKey),
        );
        return {
          hits: candidates.slice(0, params.limit),
          indexing: false,
          truncated: candidates.length > (params.limit ?? candidates.length),
        };
      },
    );
    readSessionEntrySummariesMock.mockResolvedValue([
      { sessionKey: incognitoKey, entry: { incognito: true } },
      { sessionKey: durableKey, entry: {} },
    ]);

    const respond = await callSearch(
      { query: "needle", limit: 1 },
      ["operator.read"],
      "viewer@example.com",
    );

    expect(searchSessionTranscriptsMock).toHaveBeenCalledWith({
      agentId: "main",
      query: "needle",
      limit: 1,
      sessionKeys: [durableKey],
      storePath: expect.any(String),
    });
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        results: [expect.objectContaining({ sessionKey: durableKey })],
      }),
    );
  });

  it("rejects filters spanning multiple agent stores", async () => {
    const respond = await callSearch({
      query: "needle",
      sessionKeys: ["agent:main:main", "agent:work:main"],
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: expect.stringContaining("one agent per call"),
      }),
    );
    expect(searchSessionTranscriptsMock).not.toHaveBeenCalled();
  });

  it("uses agentId to disambiguate an unscoped store key", async () => {
    useScopedSearchRows(["agent:work:main", "global"]);
    await callSearch({ agentId: "work", query: "needle", sessionKeys: ["main", "global"] });

    expect(searchSessionTranscriptsMock).toHaveBeenCalledWith({
      agentId: "work",
      query: "needle",
      limit: undefined,
      sessionKeys: ["agent:work:main", "global"],
      storePath: expect.any(String),
    });
  });

  it("does not allow agentId to widen an unfiltered search", async () => {
    const respond = await callSearch({ agentId: "work", query: "needle" });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST", message: "agentId requires sessionKeys" }),
    );
    expect(searchSessionTranscriptsMock).not.toHaveBeenCalled();
  });

  it.each([false, true])("deduplicates authorized retired copies (scoped: %s)", async (scoped) => {
    resolveExistingAgentSessionStoreTargetsAsyncMock.mockResolvedValue([
      { agentId: "retired", storePath: "/stores/retired-a/sessions.json" },
      { agentId: "retired", storePath: "/stores/retired-b/sessions.json" },
    ]);
    const duplicate = {
      sessionKey: "agent:retired:main",
      sessionId: "session-retired",
      messageId: "message-1",
      role: "user",
      timestamp: 20,
      snippet: "needle",
      score: 3,
    };
    // Admin transcript-copy deduplication is separate from canonical-row admission below.
    searchSessionTranscriptsMock
      .mockReturnValueOnce({
        hits: [duplicate, { ...duplicate, messageId: "message-2", score: 1 }],
        indexing: false,
        archivedTranscriptsExcluded: 2,
      })
      .mockReturnValueOnce({
        hits: [{ ...duplicate }, { ...duplicate, messageId: "message-3", score: 2 }],
        indexing: false,
        archivedTranscriptsExcluded: 3,
      });

    const respond = await callSearch(
      {
        agentId: "retired",
        query: "needle",
        ...(scoped ? { sessionKeys: ["main"] } : {}),
        limit: 3,
      },
      ["operator.admin"],
      "legacy-search-administrator",
    );

    expect(searchSessionTranscriptsMock).toHaveBeenCalledTimes(2);
    expect(resolveExistingAgentSessionStoreTargetsAsyncMock).toHaveBeenCalledOnce();
    expect(searchSessionTranscriptsMock).toHaveBeenNthCalledWith(1, {
      agentId: "retired",
      query: "needle",
      limit: 25,
      ...(scoped ? { sessionKeys: ["agent:retired:main"] } : {}),
      storePath: "/stores/retired-a/sessions.json",
    });
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        archivedTranscriptsExcluded: 5,
        results: [
          expect.objectContaining({ messageId: "message-1" }),
          expect.objectContaining({ messageId: "message-3" }),
          expect.objectContaining({ messageId: "message-2" }),
        ],
      }),
    );
  });

  it.each(["main", "retired"])(
    "filters omitted-key searches by current metadata and namespace for %s in a fixed store",
    async (agentId) => {
      cfg = {
        agents: { entries: { main: {} } },
        session: { store: fixedStorePath },
      };
      resolveExistingAgentSessionStoreTargetsAsyncMock.mockResolvedValue([
        { agentId: "retired", storePath: fixedStorePath },
      ]);
      const sessionKey = `agent:${agentId}:visible`;
      readSessionEntrySummariesMock.mockResolvedValue([
        { sessionKey, entry: { sessionId: "visible", visibility: "shared" } },
        {
          sessionKey: `agent:${agentId}:confidential`,
          entry: { sessionId: "confidential", access: { mode: "creator" } },
        },
        { sessionKey: "agent:other:foreign", entry: { sessionId: "foreign" } },
      ]);
      await callSearch({ ...(agentId === "retired" ? { agentId } : {}), query: "needle" });

      expect(readSessionEntrySummariesMock).toHaveBeenCalledTimes(2);
      expect(readSessionEntrySummariesMock).toHaveBeenCalledWith({
        agentId,
        storePath: fixedStorePath,
      });
      const ftsCall = expectDefined(
        searchSessionTranscriptsMock.mock.invocationCallOrder[0],
        "FTS invocation",
      );
      expect(readSessionEntrySummariesMock.mock.invocationCallOrder[0]).toBeLessThan(ftsCall);
      expect(readSessionEntrySummariesMock.mock.invocationCallOrder[1]).toBeGreaterThan(ftsCall);
      expect(searchSessionTranscriptsMock).toHaveBeenCalledWith({
        agentId,
        query: "needle",
        limit: agentId === "retired" ? 25 : undefined,
        sessionKeys: [sessionKey],
        storePath: fixedStorePath,
      });
    },
  );
});
