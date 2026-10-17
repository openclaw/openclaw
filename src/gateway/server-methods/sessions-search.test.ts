/** Gateway session-search validation and agent-scoping tests. */

import { mkdirSync } from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { prepareUserProfileCatalog } from "../../state/user-profile-list.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import type { GatewayRequestContext, RespondFn } from "./types.js";

const fixedStorePath = path.resolve("/stores/shared/sessions.sqlite");
const templateStorePath = path.resolve("/stores/{agentId}.json");

const searchMock = vi.fn();
const summariesMock = vi.fn();
const targetsMock = vi.fn();

vi.mock("../../config/sessions/session-transcript-search.js", () => ({
  searchSessionTranscripts: (...args: unknown[]) => searchMock(...args),
}));
vi.mock("../../config/sessions/session-entry-read-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/sessions/session-entry-read-runtime.js")>()),
  readSessionEntrySummariesInWorker: (...args: unknown[]) => summariesMock(...args),
}));
vi.mock("../../config/sessions/targets-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/sessions/targets-runtime.js")>()),
  resolveExistingAgentSessionStoreTargetsAsync: (...args: unknown[]) => targetsMock(...args),
}));

import { sessionReadHandlers } from "./sessions-read.js";

let cfg: OpenClawConfig;

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

function expectError(respond: Mock, message?: unknown, code = "INVALID_REQUEST") {
  expect(respond).toHaveBeenCalledWith(
    false,
    undefined,
    expect.objectContaining({ code, ...(message === undefined ? {} : { message }) }),
  );
  expect(searchMock).not.toHaveBeenCalled();
}

function expectResults(respond: Mock, results: Record<string, unknown>[], extra = {}) {
  expect(respond).toHaveBeenCalledWith(
    true,
    expect.objectContaining({
      ...extra,
      results: results.map((result) => expect.objectContaining(result)),
    }),
  );
}

function expectRequest(overrides: Record<string, unknown>) {
  expect(searchMock).toHaveBeenCalledWith({
    agentId: "main",
    query: "needle",
    limit: undefined,
    storePath: expect.any(String),
    ...overrides,
  });
}

async function callSearch(params: Record<string, unknown>, profileId?: string): Promise<Mock> {
  const respond = vi.fn();
  const handler = expectDefined(sessionReadHandlers["sessions.search"], "search handler");
  await handler({
    req: { id: "req-search" } as never,
    params: { query: "needle", ...params },
    respond: respond as unknown as RespondFn,
    context: { getRuntimeConfig: () => cfg } as unknown as GatewayRequestContext,
    client: profileId
      ? ({
          connect: { scopes: ["operator.read"] },
          authenticatedUserProfile: {
            profileId,
            displayName: null,
            hasAvatar: false,
            updatedAt: 1,
          },
        } as never)
      : null,
    isWebchatConnect: () => false,
  });
  return respond;
}

function withRestrictedState(
  run: (viewer: string, other: string, state: OpenClawTestState) => Promise<void>,
  others: "none" | "view" = "none",
) {
  return withOpenClawTestState(
    { scenario: "minimal", prepareProfileCatalog: true },
    async (state) => {
      const accessor = await vi.importActual<
        typeof import("../../config/sessions/session-entry-read-runtime.js")
      >("../../config/sessions/session-entry-read-runtime.js");
      const sessions = await vi.importActual<
        typeof import("../../config/sessions/targets-runtime.js")
      >("../../config/sessions/targets-runtime.js");
      summariesMock.mockImplementation(accessor.readSessionEntrySummariesInWorker);
      targetsMock.mockImplementation(sessions.resolveExistingAgentSessionStoreTargetsAsync);
      searchMock.mockImplementation((params: { sessionKeys?: string[] }) => ({
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
      const viewer = ensureProfileForEmail("search-viewer@example.test").id;
      const other = ensureProfileForEmail("search-other@example.test").id;
      using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
      await run(viewer, other, state);
    },
  );
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
    searchMock.mockReset().mockReturnValue({ hits: [], indexing: false });
    summariesMock.mockReset().mockResolvedValue([]);
    targetsMock.mockReset().mockResolvedValue([]);
  });

  it("finds visible rows in a cold retired main store without an explicit key filter", async () => {
    await withRestrictedState(async (viewer, other) => {
      const visibleKey = "agent:main:retained";
      for (const [sessionKey, profileId] of [
        [visibleKey, viewer],
        ["agent:main:foreign", other],
      ] as const) {
        replaceSessionEntrySync({ agentId: "main", sessionKey }, entry(sessionKey, profileId));
      }
      cfg = { ...cfg, agents: { ownership: "explicit", entries: { research: {} } } };
      setRuntimeConfigSnapshot(cfg);
      closeOpenClawAgentDatabasesForTest();

      const respond = await callSearch({ agentId: "main" }, viewer);
      expect(respond).toHaveBeenCalledWith(true, {
        results: [expect.objectContaining({ sessionKey: visibleKey })],
      });
    });
  });

  it("reports duplicate retired rows before searching either transcript store", async () => {
    await withRestrictedState(async (viewer, _other, state) => {
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
            createdActor: { type: "human", source: "profile", id: viewer },
          },
        );
      }

      const respond = await callSearch({ agentId: "retired-agent" }, viewer);
      expectError(respond, expect.stringContaining("duplicate rows"), "UNAVAILABLE");
    });
  });

  it("hides a retired session whose visibility changes while its transcript is searched", async () => {
    await withRestrictedState(async (viewer, other) => {
      const sessionKey = "agent:main:retained";
      const retained = entry("retained-session", other);
      replaceSessionEntrySync({ agentId: "main", sessionKey }, retained);
      cfg = { ...cfg, agents: { ownership: "explicit", entries: { research: {} } } };
      setRuntimeConfigSnapshot(cfg);
      searchMock.mockImplementationOnce(() => {
        replaceSessionEntrySync(
          { agentId: "main", sessionKey },
          { ...retained, visibility: "draft" },
        );
        return {
          hits: [{ sessionKey, sessionId: retained.sessionId, messageId: "private", score: 1 }],
          indexing: false,
        };
      });

      const respond = await callSearch({ agentId: "main" }, viewer);

      expect(respond).toHaveBeenCalledWith(true, { results: [] });
    }, "view");
  });

  it.each<[string, Record<string, unknown>, unknown]>([
    ["invalid limits", { limit: 26 }, undefined],
    ["whitespace-only queries", { query: "   " }, "query must not be empty"],
    [
      "multiple agent stores",
      { sessionKeys: ["agent:main:main", "agent:work:main"] },
      expect.stringContaining("one agent per call"),
    ],
    ["agentId widening an unfiltered search", { agentId: "work" }, "agentId requires sessionKeys"],
  ])("rejects %s before transcript lookup", async (_name, params, message) => {
    expectError(await callSearch(params), message);
  });

  it.each([undefined, fixedStorePath, templateStorePath])(
    "derives one agent and canonical filters from sessionKeys with store %s",
    async (storePath) => {
      if (storePath) {
        cfg = { ...cfg, session: { store: storePath } };
      }
      searchMock.mockReturnValue({
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
      sessionKeys: ["global"],
    });

    expectError(respond, 'agent "research" does not match session key agent "ops"');
  });

  it("filters incognito candidates before applying a non-admin result limit", async () => {
    const incognitoKey = "agent:main:dashboard:incognito-newer";
    const durableKey = "agent:main:dashboard:durable";
    const candidates = [hit(incognitoKey, { score: 10 }), hit(durableKey)];
    searchMock.mockImplementation((params: { limit?: number; sessionKeys?: string[] }) => {
      const selected = candidates.filter((candidate) =>
        params.sessionKeys?.includes(candidate.sessionKey),
      );
      return {
        hits: selected.slice(0, params.limit),
        indexing: false,
        truncated: selected.length > (params.limit ?? selected.length),
      };
    });
    summariesMock.mockResolvedValue([
      { sessionKey: incognitoKey, entry: { incognito: true } },
      { sessionKey: durableKey, entry: {} },
    ]);

    const respond = await callSearch({ limit: 1 }, "viewer@example.com");

    expectRequest({
      limit: 1,
      sessionKeys: [durableKey],
    });
    expectResults(respond, [{ sessionKey: durableKey }]);
  });

  it("uses agentId to disambiguate an unscoped store key", async () => {
    await callSearch({ agentId: "work", sessionKeys: ["main", "global"] });

    expectRequest({
      agentId: "work",
      sessionKeys: ["agent:work:main", "global"],
    });
  });

  it("searches only scoped keys in existing retired stores and deduplicates migrated hits", async () => {
    targetsMock.mockResolvedValue([
      { agentId: "retired", storePath: "/stores/retired-a/sessions.json" },
      { agentId: "retired", storePath: "/stores/retired-b/sessions.json" },
    ]);
    const duplicate = hit("agent:retired:main", { messageId: "message-1", score: 3 });
    searchMock
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
      sessionKeys: ["main"],
      limit: 3,
    });

    expect(searchMock).toHaveBeenCalledTimes(2);
    expect(targetsMock).toHaveBeenCalledOnce();
    expect(searchMock).toHaveBeenNthCalledWith(1, {
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
      targetsMock.mockResolvedValue([{ agentId: "retired", storePath: fixedStorePath }]);
      await callSearch(agentId === "retired" ? { agentId } : {});

      expect(summariesMock).not.toHaveBeenCalled();
      expectRequest({
        agentId,
        limit: agentId === "retired" ? 25 : undefined,
        storePath: fixedStorePath,
      });
    },
  );
});
