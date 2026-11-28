import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, test, vi } from "vitest";
import type { SessionsSearchResult } from "../../../packages/gateway-protocol/src/index.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import {
  persistSessionTranscriptTurn,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { resolveSqliteTranscriptScope } from "../../config/sessions/session-accessor.sqlite-scope.js";
import { replaceSqliteTranscriptEventsInTransaction } from "../../config/sessions/session-accessor.sqlite-transcript-store.js";
import { replaceSqliteTranscriptSuffixInTransaction } from "../../config/sessions/session-accessor.sqlite-transcript-suffix.js";
import * as transcriptSearch from "../../config/sessions/session-transcript-search.js";
import { timedMessageEvent } from "../../config/sessions/transcript-message.test-support.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { runOpenClawAgentWriteTransaction } from "../../state/openclaw-agent-db.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { retainSessionListForegroundWork } from "../session-projection-work.js";
import {
  identifiedClient,
  initializeSessionReadContext,
  requestContext,
  sessionReadHandlers,
  disposeSessionReadContexts,
} from "./sessions-read-cache.test-support.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./types.js";

afterEach(() => vi.restoreAllMocks());

async function withSearchState(run: () => Promise<void>) {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    try {
      await run();
    } finally {
      await disposeSessionReadContexts();
    }
  });
}

async function search(
  context: GatewayRequestContext,
  client: GatewayClient,
  params: Record<string, unknown>,
) {
  const releaseForeground = retainSessionListForegroundWork();
  try {
    await initializeSessionReadContext(context);
    let response:
      | { ok: boolean; payload?: SessionsSearchResult; error?: { message?: string } }
      | undefined;
    const respond: RespondFn = (ok, payload, error) => {
      response = { ok, payload: payload as SessionsSearchResult, error };
    };
    await expectDefined(
      sessionReadHandlers["sessions.search"],
      "search handler",
    )({
      req: { type: "req", id: "search-rewrite-fence-test", method: "sessions.search" },
      params,
      context,
      client,
      respond,
      isWebchatConnect: () => false,
    });
    return expectDefined(response, "search response");
  } finally {
    releaseForeground();
  }
}

async function seed(
  agentId: string,
  name: string,
  owner: string,
  text?: string,
  extra: Parameters<typeof upsertSessionEntryCore>[1] = {},
) {
  const sessionKey = `agent:${agentId}:${name}`;
  const sessionId = `${agentId}-${name}`;
  const scope = { agentId, sessionKey };
  await upsertSessionEntryCore(scope, {
    sessionId,
    updatedAt: Date.now(),
    displayName: name,
    createdActor: { type: "human", source: "profile", id: owner },
    visibility: "shared",
    ...extra,
  });
  if (text) {
    await persistSessionTranscriptTurn(
      { ...scope, sessionId },
      {
        cwd: "/fixture",
        updateMode: "none",
        messages: [{ message: { role: "user", content: text }, now: Date.now() }],
      },
    );
  }
  return sessionKey;
}

// Activity summaries are optional: existing transcripts without one still hold recall hits, so
// rewrite fencing must not depend on a certified summary watermark — for clears and non-empty
// replacements alike.
test.each([
  { withActivitySummary: true, replacement: "clear" },
  { withActivitySummary: false, replacement: "clear" },
  { withActivitySummary: true, replacement: "non-empty" },
  { withActivitySummary: false, replacement: "non-empty" },
])(
  "recall discards hits when a destructive transcript rewrite lands during its worker read (activity summary: $withActivitySummary, replacement: $replacement)",
  async ({ withActivitySummary, replacement }) => {
    await withSearchState(async () => {
      const owner = ensureProfileForEmail("recall-rewrite@example.test").id;
      const cfg: OpenClawConfig = { agents: { entries: { main: {} } } };
      setRuntimeConfigSnapshot(cfg);
      const key = await seed(
        "main",
        "rewrite-target",
        owner,
        "needle",
        withActivitySummary
          ? {
              activitySummary: {
                version: 1,
                text: "needle discussion",
                updatedAt: Date.now(),
                sessionId: "main-rewrite-target",
                generation: null,
                maxSeq: null,
                leafEntryId: null,
                coveredMessages: 1,
                totalMessages: 1,
                omittedContent: false,
              },
            }
          : {},
      );
      const read = transcriptSearch.searchSessionTranscripts;
      let rewritten = false;
      vi.spyOn(transcriptSearch, "searchSessionTranscripts").mockImplementation(async (...args) => {
        const result = await read(...args);
        if (!rewritten) {
          rewritten = true;
          runOpenClawAgentWriteTransaction(
            (database) => {
              replaceSqliteTranscriptEventsInTransaction(
                database,
                resolveSqliteTranscriptScope({
                  agentId: "main",
                  sessionKey: key,
                  sessionId: "main-rewrite-target",
                }),
                replacement === "clear"
                  ? []
                  : [
                      timedMessageEvent("replacement", null, Date.now(), {
                        role: "user",
                        content: "replacement",
                      }),
                    ],
              );
            },
            { agentId: "main" },
          );
        }
        return result;
      });
      const result = await search(requestContext(cfg), identifiedClient(owner), {
        query: "needle",
        recall: { requesterAgentId: "main", requesterSessionKey: "agent:main:main" },
      });
      expect(result.ok, result.error?.message).toBe(true);
      expect(result.payload?.results).toEqual([]);
    });
  },
);

// Suffix removal is destructive even when a nonmatching prefix survives: the retained prefix
// keeps rawSeq non-null and hasMessages true, so a summary-less loaded row has neither a prior
// watermark nor an empty postimage to fence on. The suffix producer must certify the rewrite.
test.each([false, true])(
  "recall discards hits when a suffix removal retains a nonmatching prefix during its worker read (activity summary: %s)",
  async (withActivitySummary) => {
    await withSearchState(async () => {
      const owner = ensureProfileForEmail("recall-suffix@example.test").id;
      const cfg: OpenClawConfig = { agents: { entries: { main: {} } } };
      setRuntimeConfigSnapshot(cfg);
      const key = await seed(
        "main",
        "suffix-target",
        owner,
        undefined,
        withActivitySummary
          ? {
              activitySummary: {
                version: 1,
                text: "needle discussion",
                updatedAt: Date.now(),
                sessionId: "main-suffix-target",
                generation: null,
                maxSeq: null,
                leafEntryId: null,
                coveredMessages: 2,
                totalMessages: 2,
                omittedContent: false,
              },
            }
          : {},
      );
      const scope = resolveSqliteTranscriptScope({
        agentId: "main",
        sessionKey: key,
        sessionId: "main-suffix-target",
      });
      const prefix = timedMessageEvent("prefix", null, Date.now(), {
        role: "user",
        content: "unrelated prefix",
      });
      const needle = timedMessageEvent("needle", "prefix", Date.now(), {
        role: "assistant",
        content: "needle",
      });
      const events = [prefix, needle];
      runOpenClawAgentWriteTransaction(
        (database) => {
          replaceSqliteTranscriptEventsInTransaction(database, scope, events);
        },
        { agentId: "main" },
      );
      const read = transcriptSearch.searchSessionTranscripts;
      let removed = false;
      vi.spyOn(transcriptSearch, "searchSessionTranscripts").mockImplementation(async (...args) => {
        const result = await read(...args);
        if (!removed) {
          removed = true;
          runOpenClawAgentWriteTransaction(
            (database) => {
              replaceSqliteTranscriptSuffixInTransaction(database, scope, {
                expectedEvents: events,
                nextEvents: [prefix],
                persistedPrefixLength: 1,
              });
            },
            { agentId: "main" },
          );
        }
        return result;
      });
      const result = await search(requestContext(cfg), identifiedClient(owner), {
        query: "needle",
        recall: { requesterAgentId: "main", requesterSessionKey: "agent:main:main" },
      });
      expect(result.ok, result.error?.message).toBe(true);
      expect(result.payload?.results).toEqual([]);
    });
  },
);
