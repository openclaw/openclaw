import { once } from "node:events";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import { makeAgentAssistantMessage } from "../agents/test-helpers/agent-message-fixtures.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import {
  appendTranscriptMessage,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { applySessionEntryCanonicalReplacements } from "../config/sessions/session-accessor.sqlite-replacement-projection.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { prepareUserProfileCatalog } from "../state/user-profile-list.js";
import { ensureCanonicalUserProfileForEmail } from "../state/user-profile-writes.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { resolveGatewayAuth } from "./auth.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import { createGatewayHttpServer } from "./server-http.js";
import * as historyState from "./session-history-state.js";
import {
  appendHistoryMessage,
  historyStream,
  historyTexts,
  type SessionHistoryBody,
} from "./sessions-history-http-read.test-support.js";

const emails = {
  creator: "history-creator@example.test",
  selected: "history-selected@example.test",
  outsider: "history-outsider@example.test",
};
const privateText = "confidential HTTP history";

function heldRead() {
  const entered = createDeferred();
  const release = createDeferred();
  return {
    entered,
    release,
    hold: async <T>(work: Promise<T>): Promise<T> => {
      const result = await work;
      entered.resolve();
      await release.promise;
      return result;
    },
  };
}

describe("HTTP history independent confidential access", () => {
  let state: Awaited<ReturnType<typeof createOpenClawTestState>>;
  let server: ReturnType<typeof createGatewayHttpServer>;
  let releaseProfiles: (() => void) | undefined;
  let port: number;
  let storePath: string;
  let creatorId: string;
  let selectedId: string;
  let sequence = 0;
  let scope: { agentId: string; sessionKey: string; sessionId: string };

  beforeAll(async () => {
    state = await createOpenClawTestState({
      scenario: "minimal",
      label: "http-confidential-access",
      prepareProfileCatalog: true,
    });
    // No role configuration or membership grants: access is independent of both.
    const cfg: OpenClawConfig = {
      agents: { entries: { main: {} } },
      plugins: { enabled: false },
      gateway: {
        trustedProxies: ["127.0.0.1"],
        auth: {
          mode: "trusted-proxy",
          trustedProxy: { userHeader: "x-forwarded-user", allowLoopback: true },
        },
      },
    };
    setRuntimeConfigSnapshot(cfg);
    creatorId = (await ensureCanonicalUserProfileForEmail(emails.creator)).id;
    selectedId = (await ensureCanonicalUserProfileForEmail(emails.selected)).id;
    await ensureCanonicalUserProfileForEmail(emails.outsider);
    releaseProfiles = (await prepareUserProfileCatalog()).release;
    storePath = openOpenClawAgentDatabase({ agentId: "main", env: state.env }).path;
    const context = createDirectChatContext({
      getRuntimeConfig: () => cfg,
      getCommittedRuntimeConfig: () => cfg,
    });
    server = createGatewayHttpServer({
      clients: new Set(),
      controlUiEnabled: false,
      controlUiBasePath: "",
      handleHooksRequest: async () => false,
      resolvedAuth: resolveGatewayAuth({ authConfig: cfg.gateway?.auth }),
      getResolvedAuth: () => resolveGatewayAuth({ authConfig: cfg.gateway?.auth }),
      getRuntimeConfig: () => cfg,
      getGatewayRequestContext: () => context,
      httpRequestLifetime: context,
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected HTTP history fixture listener");
    }
    port = address.port;
  });

  beforeEach(async () => {
    const sessionId = `http-confidential-${++sequence}`;
    scope = { agentId: "main", sessionId, sessionKey: `agent:main:${sessionId}` };
    await upsertSessionEntryCore(scope, {
      sessionId,
      updatedAt: sequence,
      createdActor: { type: "human", source: "profile", id: creatorId },
      visibility: "shared",
      access: { mode: "audience", profileIds: [selectedId] },
    });
    await appendTranscriptMessage(scope, {
      eventId: `${sessionId}-initial`,
      message: makeAgentAssistantMessage({ content: [{ type: "text", text: privateText }] }),
    });
  });

  afterEach(() => vi.restoreAllMocks());

  afterAll(async () => {
    try {
      server?.closeAllConnections();
      if (server) {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
    } finally {
      releaseProfiles?.();
      await state?.cleanup();
    }
  });

  function requestHistory(reader: keyof typeof emails, sse = false) {
    return fetch(
      `http://127.0.0.1:${port}/sessions/${encodeURIComponent(scope.sessionKey)}/history`,
      {
        headers: {
          "x-forwarded-for": "192.0.2.10",
          "x-forwarded-proto": "https",
          "x-forwarded-user": emails[reader],
          "x-openclaw-scopes": "operator.read",
          ...(sse ? { accept: "text/event-stream" } : {}),
        },
      },
    );
  }

  async function expectNotFound(response: Response) {
    if (response.status !== 404) {
      await response.body?.cancel();
    }
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      ok: false,
      error: { type: "not_found", message: `Session not found: ${scope.sessionKey}` },
    });
  }

  async function revokeSelected() {
    // Ordinary row writes intentionally preserve access; use its canonical mutation owner.
    await applySessionEntryCanonicalReplacements({
      agentId: scope.agentId,
      storePath,
      sessionKeys: [scope.sessionKey],
      update: (rows) => {
        expect(rows).toHaveLength(1);
        return {
          result: undefined,
          replacements: rows.map((row) => ({
            ...row,
            previousSessionKeys: [],
            accessMutation: true,
            entry: { ...row.entry, access: { mode: "creator" as const } },
          })),
        };
      },
    });
  }

  it.each([
    ["JSON", false],
    ["SSE", true],
  ] as const)(
    "enforces creator, selected and outsider access before %s transcript reads",
    async (_, sse) => {
      const read = vi.spyOn(historyState, "readSessionHistorySnapshotAsync");
      for (const reader of ["creator", "selected"] as const) {
        read.mockClear();
        const response = await requestHistory(reader, sse);
        expect(response.status).toBe(200);
        if (sse) {
          await using stream = historyStream(response);
          await stream.expectTexts([privateText]);
        } else {
          expect(historyTexts((await response.json()) as SessionHistoryBody)).toEqual([
            privateText,
          ]);
        }
        expect(read).toHaveBeenCalledTimes(1);
      }
      read.mockClear();
      await expectNotFound(await requestHistory("outsider", sse));
      expect(read).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["JSON", false],
    ["SSE", true],
  ] as const)(
    "rechecks confidential access before publishing a held initial %s snapshot",
    async (_, sse) => {
      const { entered, release, hold } = heldRead();
      const original = historyState.readSessionHistorySnapshotAsync;
      vi.spyOn(historyState, "readSessionHistorySnapshotAsync").mockImplementationOnce((params) =>
        hold(original(params)),
      );
      const pending = requestHistory("selected", sse);
      try {
        await awaitGateBeforeSettlement(entered.promise, pending, "History read was not held");
        await revokeSelected();
      } finally {
        release.resolve();
      }
      await expectNotFound(await pending);
      // Revocation is audience-specific, not a missing/deleted transcript or failed auth.
      const creator = await requestHistory("creator");
      expect(creator.status).toBe(200);
      expect(historyTexts((await creator.json()) as SessionHistoryBody)).toEqual([privateText]);
    },
  );

  it.each(["inline", "refresh"] as const)(
    "closes SSE without publishing a held %s update after audience revocation",
    async (kind) => {
      const fromSnapshot = vi.spyOn(historyState.SessionHistorySseState, "fromSnapshot");
      await using stream = historyStream(await requestHistory("selected", true));
      await stream.expectTexts([privateText]);
      const live = expectDefined(
        fromSnapshot.mock.results.find((result) => result.type === "return")?.value,
        "SSE history state",
      );
      const { entered, release, hold } = heldRead();
      if (kind === "inline") {
        const original = live.prepareInlineMessage.bind(live);
        vi.spyOn(live, "prepareInlineMessage").mockImplementationOnce((params) =>
          hold(original(params)),
        );
      } else {
        const original = live.refreshAsync.bind(live);
        vi.spyOn(live, "refreshAsync").mockImplementationOnce(() => hold(original()));
      }
      const unpublishedText = `revoked ${kind} content`;
      const nextChunk = stream.reader.read();
      const appended = appendHistoryMessage({
        ...scope,
        updateMode: kind === "inline" ? "inline" : "file-only",
        message: makeAgentAssistantMessage({
          content: [{ type: "text", text: unpublishedText }],
        }),
      });
      try {
        await awaitGateBeforeSettlement(
          entered.promise,
          Promise.all([appended, nextChunk]),
          "SSE publication was not held",
        );
        await revokeSelected();
      } finally {
        release.resolve();
      }
      await appended;
      expect(await nextChunk).toEqual({ done: true, value: undefined });
      expect(stream.streamState.buffer).not.toContain(unpublishedText);
      await expectNotFound(await requestHistory("selected"));
      const creator = await requestHistory("creator");
      expect(creator.status).toBe(200);
      expect(historyTexts((await creator.json()) as SessionHistoryBody)).toEqual([
        privateText,
        unpublishedText,
      ]);
    },
  );
});
