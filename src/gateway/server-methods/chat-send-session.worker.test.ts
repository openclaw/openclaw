import { existsSync, statSync } from "node:fs";
import { StatementSync } from "node:sqlite";
import { expect, it } from "vitest";
import { observeSqliteReadSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.sqlite-entry.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { openNodeSqliteDatabase } from "../../infra/node-sqlite.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { loadGatewaySessionEntryReadOnlyAsync } from "../session-utils-store.js";
import { normalizeChatSendRequest } from "./chat-send-request.js";
import {
  loadCurrentChatSendSession,
  prepareChatSendSession,
  qualifyChatSendSession,
} from "./chat-send-session.js";

function prepareSession(cfg: OpenClawConfig, sessionKey: string, agentId = "main") {
  const request = normalizeChatSendRequest({
    client: null,
    params: { sessionKey, agentId, message: "Hello", idempotencyKey: "prepared-read" },
  });
  if (!request.ok) {
    throw new Error(request.error);
  }
  return prepareChatSendSession({
    request: request.value,
    client: null,
    context: createDirectChatContext({ getRuntimeConfig: () => cfg }),
  });
}

it.each([false, true])(
  "prepares chat session metadata off-thread with the selected owner (global: %s)",
  async (global) => {
    await withOpenClawTestState({ label: "chat-session-worker" }, async (state) => {
      const cfg = {
        agents: { ownership: "explicit", entries: { main: {}, work: {} } },
        ...(global ? { session: { scope: "global" as const } } : {}),
      } satisfies OpenClawConfig;
      await state.writeConfig(cfg);
      const sessionKey = global ? "global" : "agent:work:main";
      const entry = {
        sessionId: "work-session",
        updatedAt: 1,
        skillsSnapshot: { prompt: "saved prompt".repeat(4096), skills: [] },
      };
      await replaceSessionEntry({ sessionKey, agentId: "work" }, entry);
      const databasePath = resolveOpenClawAgentSqlitePath({ agentId: "work" });
      const identity = statSync(databasePath, { bigint: true });
      const sql = observeSqliteReadSql(StatementSync.prototype);
      try {
        const prepared = await prepareSession(cfg, "global", "work");
        expect(prepared).toMatchObject({
          ok: true,
          value: {
            agentId: "work",
            sessionKey,
            entry,
            capturedReadSource: {
              agentId: "work",
              path: databasePath,
              databaseIdentity: `${identity.dev}:${identity.ino}`,
              databaseBirthtime: identity.birthtimeNs.toString(),
            },
          },
        });
        expect(sql.queries.filter((query) => /\bsession_nodes\b/u.test(query))).toEqual([]);
      } finally {
        sql.restore();
      }
    });
  },
);

it("retains an empty existing source without creating a missing durable store", async () => {
  await withOpenClawTestState({ label: "chat-session-missing" }, async (state) => {
    const cfg = {
      agents: { ownership: "explicit", entries: { main: {} } },
    } satisfies OpenClawConfig;
    await state.writeConfig(cfg);
    const key = "agent:main:dashboard:missing";
    const databasePath = resolveOpenClawAgentSqlitePath({ agentId: "main" });
    expect(await loadGatewaySessionEntryReadOnlyAsync(key, undefined, cfg)).toMatchObject({
      entry: undefined,
      capturedReadSources: [],
    });
    expect(existsSync(databasePath)).toBe(false);
    await replaceSessionEntry(
      { sessionKey: "agent:main:main" },
      { sessionId: "other-session", updatedAt: 1 },
    );
    const loaded = await loadGatewaySessionEntryReadOnlyAsync(key, undefined, cfg);
    expect(loaded.entry).toBeUndefined();
    expect(loaded.capturedReadSource).toMatchObject({ path: databasePath, agentId: "main" });
    expect(loaded.capturedReadSources).toEqual([loaded.capturedReadSource]);
  });
});

it.each([false, true])(
  "gives first sends the same admitted store (empty file: %s)",
  async (emptyFile) => {
    await withOpenClawTestState({ label: "chat-session-first-sends" }, async (state) => {
      const cfg = {
        agents: { ownership: "explicit", entries: { main: {} } },
        session: { store: state.path("initial.sqlite") },
      } satisfies OpenClawConfig;
      await state.writeConfig(cfg);
      if (emptyFile) {
        openNodeSqliteDatabase(cfg.session.store).close();
      }
      const results = await Promise.all([
        prepareSession(cfg, "agent:main:dashboard:first"),
        prepareSession(cfg, "agent:main:dashboard:second"),
      ]);
      const first = results[0];
      expect(first?.ok).toBe(true);
      if (!first?.ok) {
        throw new Error("First session preparation failed");
      }
      expect(first.value.capturedReadSource).toBeDefined();
      for (const result of results) {
        expect(result.ok).toBe(true);
        if (!result.ok) {
          throw new Error("Concurrent session preparation failed");
        }
        expect(result.value.capturedReadSource).toEqual(first.value.capturedReadSource);
        const session = qualifyChatSendSession(result.value);
        try {
          await expect(loadCurrentChatSendSession(session, () => cfg)).resolves.toMatchObject({
            entry: undefined,
            capturedReadSource: first.value.capturedReadSource,
          });
        } finally {
          session.releaseSessionTarget();
        }
      }
    });
  },
);

it("keeps incognito session preparation with its process-held owner", async () => {
  await withOpenClawTestState({ label: "chat-session-incognito" }, async (state) => {
    const cfg = {
      agents: { ownership: "explicit", entries: { main: {} } },
    } satisfies OpenClawConfig;
    await state.writeConfig(cfg);
    const key = "agent:main:dashboard:incognito-worker";
    expect(await prepareSession(cfg, key)).toMatchObject({
      ok: false,
      error: `Incognito session "${key}" was not found.`,
    });
    await replaceSessionEntry({ sessionKey: key }, { sessionId: "private-session", updatedAt: 1 });
    expect(await prepareSession(cfg, key)).toMatchObject({
      ok: true,
      value: {
        entry: { sessionId: "private-session" },
        capturedReadSource: { databaseIdentity: expect.any(Symbol) },
      },
    });
    expect(existsSync(resolveOpenClawAgentSqlitePath({ agentId: "main" }))).toBe(false);
  });
});
