/** Gateway session-search validation and agent-scoping tests. */

import { mkdirSync } from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { prepareUserProfileCatalog } from "../../state/user-profile-list.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { GatewayRequestContext, RespondFn } from "./types.js";

const fixedStorePath = path.resolve("/stores/shared/sessions.sqlite");
const templateStorePath = path.resolve("/stores/{agentId}.json");

const searchSessionTranscriptsMock = vi.fn();
const readSessionEntrySummariesMock = vi.fn();
const resolveExistingAgentSessionStoreTargetsAsyncMock = vi.fn();

vi.mock("../../config/sessions/session-transcript-search.js", () => ({
  searchSessionTranscripts: (...args: unknown[]) => searchSessionTranscriptsMock(...args),
}));
vi.mock("../../config/sessions/session-entry-read-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/sessions/session-entry-read-runtime.js")>()),
  readSessionEntrySummariesInWorker: (...args: unknown[]) => readSessionEntrySummariesMock(...args),
}));
vi.mock("../../config/sessions/targets-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/sessions/targets-runtime.js")>()),
  resolveExistingAgentSessionStoreTargetsAsync: (...args: unknown[]) =>
    resolveExistingAgentSessionStoreTargetsAsyncMock(...args),
}));

import { sessionReadHandlers } from "./sessions-read.js";

function defaultConfig(): OpenClawConfig {
  return {
    agents: {
      ownership: "explicit",
      defaults: { systemAgent: { agentId: "main" } },
      entries: { main: {}, work: {} },
    },
  };
}

let cfg = defaultConfig();

function hit(sessionKey: string, overrides: Record<string, unknown> = {}) {
  return {
    sessionKey,
    sessionId: sessionKey,
    messageId: `message:${sessionKey}`,
    role: "user",
    timestamp: 1,
    snippet: "needle",
    score: 1,
    ...overrides,
  };
}

function entry(sessionId: string, profileId: string) {
  return {
    sessionId,
    updatedAt: 1,
    visibility: "shared" as const,
    createdActor: { type: "human" as const, source: "profile" as const, id: profileId },
  };
}

function expectError(respond: ReturnType<typeof vi.fn>, error: Record<string, unknown>) {
  expect(respond).toHaveBeenCalledWith(false, undefined, expect.objectContaining(error));
  expect(searchSessionTranscriptsMock).not.toHaveBeenCalled();
}

function expectResults(
  respond: ReturnType<typeof vi.fn>,
  results: Record<string, unknown>[],
  extra = {},
) {
  expect(respond).toHaveBeenCalledWith(
    true,
    expect.objectContaining({
      ...extra,
      results: results.map((result) => expect.objectContaining(result)),
    }),
  );
}

function expectRequest(overrides: Record<string, unknown>) {
  expect(searchSessionTranscriptsMock).toHaveBeenCalledWith({
    agentId: "main",
    query: "needle",
    limit: undefined,
    storePath: expect.any(String),
    ...overrides,
  });
}

function searchAs(profileId: string, params: Record<string, unknown>) {
  return callSearch(params, ["operator.read"], profileId);
}

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
  readSessionEntrySummariesMock.mockImplementation(accessor.readSessionEntrySummariesInWorker);
  resolveExistingAgentSessionStoreTargetsAsyncMock.mockImplementation(
    sessions.resolveExistingAgentSessionStoreTargetsAsync,
  );
  searchSessionTranscriptsMock.mockImplementation((params: { sessionKeys?: string[] }) => ({
    hits: (params.sessionKeys ?? []).map((sessionKey) => hit(sessionKey)),
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

describe("sessions.search gateway method", () => {
  beforeEach(() => {
    cfg = defaultConfig();
    searchSessionTranscriptsMock.mockReset();
    searchSessionTranscriptsMock.mockReturnValue({ hits: [], indexing: false });
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
        replaceSessionEntrySync({ agentId: "main", sessionKey }, entry(sessionKey, profileId));
      }
      cfg = { ...cfg, agents: { ownership: "explicit", entries: { research: {} } } };
      setRuntimeConfigSnapshot(cfg);
      closeOpenClawAgentDatabasesForTest();

      const respond = await searchAs(viewer.id, { agentId: "main", query: "needle" });
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

      const respond = await searchAs(viewer.id, { agentId: "retired-agent", query: "needle" });
      expectError(respond, {
        code: "UNAVAILABLE",
        message: expect.stringContaining("duplicate rows"),
      });
    });
  });

  it("hides a retired session whose visibility changes while its transcript is searched", async () => {
    await withOpenClawTestState(profileState, async () => {
      const { viewer, other } = await useRestrictedSearchMetadata("view");
      using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
      const sessionKey = "agent:main:retained";
      const retained = entry("retained-session", other.id);
      replaceSessionEntrySync({ agentId: "main", sessionKey }, retained);
      cfg = { ...cfg, agents: { ownership: "explicit", entries: { research: {} } } };
      setRuntimeConfigSnapshot(cfg);
      searchSessionTranscriptsMock.mockImplementationOnce(() => {
        replaceSessionEntrySync(
          { agentId: "main", sessionKey },
          { ...retained, visibility: "draft" },
        );
        return {
          hits: [{ sessionKey, sessionId: retained.sessionId, messageId: "private", score: 1 }],
          indexing: false,
        };
      });

      const respond = await searchAs(viewer.id, { agentId: "main", query: "needle" });

      expect(respond).toHaveBeenCalledWith(true, { results: [] });
    });
  });

  it("validates params and rejects whitespace-only queries", async () => {
    expectError(await callSearch({ query: "needle", limit: 26 }), { code: "INVALID_REQUEST" });
    expectError(await callSearch({ query: "   " }), { message: "query must not be empty" });
  });

  it.each([undefined, fixedStorePath, templateStorePath])(
    "derives one agent and canonical filters from sessionKeys with store %s",
    async (storePath) => {
      if (storePath) {
        cfg = { ...cfg, session: { store: storePath } };
      }
      searchSessionTranscriptsMock.mockReturnValue({
        hits: [hit("agent:work:main")],
        indexing: true,
        truncated: true,
      });

      const respond = await callSearch({
        query: " needle ",
        sessionKeys: ["agent:work:main", "agent:work:other"],
        limit: 5,
      });

      expectRequest({
        agentId: "work",
        limit: 5,
        sessionKeys: ["agent:work:main", "agent:work:other"],
        storePath: storePath?.replace("{agentId}", "work") ?? expect.any(String),
      });
      expectResults(respond, [{ score: 1 }], { indexing: true, truncated: true });
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

    expectError(respond, {
      code: "INVALID_REQUEST",
      message: 'agent "research" does not match session key agent "ops"',
    });
  });

  it("filters incognito candidates before applying a non-admin result limit", async () => {
    const incognitoKey = "agent:main:dashboard:incognito-newer";
    const durableKey = "agent:main:dashboard:durable";
    const candidates = [hit(incognitoKey, { score: 10 }), hit(durableKey)];
    searchSessionTranscriptsMock.mockImplementation(
      (params: { limit?: number; sessionKeys?: string[] }) => {
        const selected = candidates.filter((candidate) =>
          params.sessionKeys?.includes(candidate.sessionKey),
        );
        return {
          hits: selected.slice(0, params.limit),
          indexing: false,
          truncated: selected.length > (params.limit ?? selected.length),
        };
      },
    );
    readSessionEntrySummariesMock.mockResolvedValue([
      { sessionKey: incognitoKey, entry: { incognito: true } },
      { sessionKey: durableKey, entry: {} },
    ]);

    const respond = await searchAs("viewer@example.com", { query: "needle", limit: 1 });

    expectRequest({
      limit: 1,
      sessionKeys: [durableKey],
    });
    expectResults(respond, [{ sessionKey: durableKey }]);
  });

  it("rejects filters spanning multiple agent stores", async () => {
    const respond = await callSearch({
      query: "needle",
      sessionKeys: ["agent:main:main", "agent:work:main"],
    });

    expectError(respond, {
      code: "INVALID_REQUEST",
      message: expect.stringContaining("one agent per call"),
    });
  });

  it("uses agentId to disambiguate an unscoped store key", async () => {
    await callSearch({ agentId: "work", query: "needle", sessionKeys: ["main", "global"] });

    expectRequest({
      agentId: "work",
      sessionKeys: ["agent:work:main", "global"],
    });
  });

  it("does not allow agentId to widen an unfiltered search", async () => {
    const respond = await callSearch({ agentId: "work", query: "needle" });

    expectError(respond, { code: "INVALID_REQUEST", message: "agentId requires sessionKeys" });
  });

  it("searches only scoped keys in existing retired stores and deduplicates migrated hits", async () => {
    resolveExistingAgentSessionStoreTargetsAsyncMock.mockResolvedValue([
      { agentId: "retired", storePath: "/stores/retired-a/sessions.json" },
      { agentId: "retired", storePath: "/stores/retired-b/sessions.json" },
    ]);
    const duplicate = hit("agent:retired:main", { messageId: "message-1", score: 3 });
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

    const respond = await callSearch({
      agentId: "retired",
      query: "needle",
      sessionKeys: ["main"],
      limit: 3,
    });

    expect(searchSessionTranscriptsMock).toHaveBeenCalledTimes(2);
    expect(resolveExistingAgentSessionStoreTargetsAsyncMock).toHaveBeenCalledOnce();
    expect(searchSessionTranscriptsMock).toHaveBeenNthCalledWith(1, {
      agentId: "retired",
      query: "needle",
      limit: 25,
      sessionKeys: ["agent:retired:main"],
      storePath: "/stores/retired-a/sessions.json",
    });
    expectResults(
      respond,
      ["message-1", "message-3", "message-2"].map((messageId) => ({ messageId })),
      { archivedTranscriptsExcluded: 5 },
    );
  });

  it.each(["main", "retired"])(
    "delegates omitted-filter namespace selection to search for %s in a fixed store",
    async (agentId) => {
      cfg = {
        agents: { entries: { main: {} } },
        session: { store: fixedStorePath },
      };
      resolveExistingAgentSessionStoreTargetsAsyncMock.mockResolvedValue([
        { agentId: "retired", storePath: fixedStorePath },
      ]);
      await callSearch({ ...(agentId === "retired" ? { agentId } : {}), query: "needle" });

      expect(readSessionEntrySummariesMock).not.toHaveBeenCalled();
      expectRequest({
        agentId,
        limit: agentId === "retired" ? 25 : undefined,
        storePath: fixedStorePath,
      });
    },
  );
});
