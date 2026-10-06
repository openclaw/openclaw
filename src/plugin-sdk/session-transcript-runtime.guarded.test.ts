import fs from "node:fs";
import { afterEach, assert, beforeEach, describe, expect, it } from "vitest";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import {
  createSessionEntryWithTranscript,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { withOwnedSessionTranscriptWrites } from "../config/sessions/transcript-write-context.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  onInternalSessionTranscriptUpdate,
  type InternalSessionTranscriptUpdate,
} from "../sessions/transcript-events.js";
import {
  closeOpenClawAgentDatabasesForTest,
  resolveIncognitoOpenClawAgentSqlitePath,
  resolveOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import {
  appendSessionTranscriptMessageByIdentityStrict as appendStrict,
  appendSessionTranscriptMessagesByIdentity as appendGroup,
  readSessionTranscriptEvents as readEvents,
  readVisibleSessionTranscriptMessageEntries as readEntries,
  type SessionTranscriptReadParams,
} from "./session-transcript-runtime.js";

describe("guarded session transcript runtime SDK", () => {
  let state: OpenClawTestState;
  beforeEach(async () => {
    state = await createOpenClawTestState({ prefix: "openclaw-sdk-transcript-", applyEnv: false });
  });
  afterEach(async () => {
    closeOpenClawAgentDatabasesForTest();
    await state.cleanup();
  });

  async function seed(route: "default" | "configured" | "incognito") {
    const agentId = route === "default" ? "main" : "secondary";
    const incognito = route === "incognito";
    if (!incognito) {
      state.applyEnv();
    }
    const config: OpenClawConfig | undefined =
      route === "configured"
        ? { session: { store: state.path("configured", "{agentId}", "sessions.json") } }
        : undefined;
    const storePath = incognito
      ? resolveIncognitoOpenClawAgentSqlitePath({ agentId, env: state.env })
      : resolveSessionStorePathCore(config?.session?.store, { agentId, env: state.env });
    const scope: SessionTranscriptReadParams & { config?: OpenClawConfig } = {
      agentId,
      sessionId: "fresh-session",
      sessionKey: `agent:${agentId}:${incognito ? "dashboard:incognito-" : ""}fresh-session`,
      ...(incognito ? { env: state.env, storePath } : {}),
      ...(config ? { config } : {}),
    };
    const persistedScope = { ...scope, storePath };
    const entry = {
      sessionId: scope.sessionId,
      updatedAt: 10,
      activeWriterRunId: "current-writer",
    };
    if (incognito) {
      await upsertSessionEntryCore(persistedScope, entry);
    } else {
      await expect(
        createSessionEntryWithTranscript(persistedScope, () => ({ ok: true, entry })),
      ).resolves.toMatchObject({ ok: true });
    }
    const superseded = <T>(run: () => Promise<T>) =>
      withOwnedSessionTranscriptWrites(
        {
          sessionTarget: { ...persistedScope, expectedWriterRunId: "superseded-writer" },
          withTranscriptWrite: async (write) => await write(),
        },
        run,
      );
    return { scope, persistedScope, superseded };
  }

  it("appends and replays an ordered incognito group with explicit env", async () => {
    const { scope, persistedScope } = await seed("incognito");
    const messages = [
      {
        eventId: "batch-assistant",
        idempotencyLookup: "scan" as const,
        message: { role: "assistant", content: "checking", idempotencyKey: "batch:assistant" },
        now: 1_000,
      },
      {
        eventId: "batch-result",
        idempotencyLookup: "scan" as const,
        message: { role: "toolResult", content: "done", idempotencyKey: "batch:result" },
        now: 2_000,
      },
    ];
    const appended = await appendGroup({ ...scope, messages });
    const replayed = await appendGroup({ ...scope, messages });
    expect(appended.map((result) => result.appended)).toEqual([true, true]);
    expect(replayed.map((result) => result.appended)).toEqual([false, false]);
    const events = await readEvents(persistedScope);
    expect(events).toHaveLength(3);
    expect(events.slice(1)).toMatchObject([
      { id: "batch-assistant", parentId: null },
      { id: "batch-result", parentId: "batch-assistant" },
    ]);
    const target = { agentId: "secondary", env: state.env };
    expect(fs.existsSync(resolveOpenClawAgentSqlitePath(target))).toBe(false);
    expect(fs.existsSync(resolveIncognitoOpenClawAgentSqlitePath(target))).toBe(false);
  });

  it("publishes a configured strict assistant with run ownership once and keeps default writes silent", async () => {
    const { scope, persistedScope } = await seed("configured");
    const updates: InternalSessionTranscriptUpdate[] = [];
    const unsubscribe = onInternalSessionTranscriptUpdate((update) => updates.push(update));
    try {
      const message = {
        role: "assistant",
        content: [{ type: "text", text: "persisted answer" }],
        stopReason: "stop",
        timestamp: 1_000,
        idempotencyKey: "native:attempt:assistant",
      };
      const params = { ...scope, message, runId: "current-writer", updateMode: "inline" as const };
      const written = await appendStrict(params);
      assert(written.kind === "result");
      const [entry] = await readEntries(persistedScope);
      assert(entry);
      expect(entry.message).toMatchObject({ ...message, __openclaw: { runId: "current-writer" } });
      expect(written.result.message).toEqual(entry.message);
      expect(updates).toEqual([
        expect.objectContaining({
          message: entry.message,
          messageId: entry.entryId,
          messageSeq: 1,
          runId: "current-writer",
        }),
      ]);
      await expect(appendStrict(params)).resolves.toMatchObject({
        kind: "result",
        result: { appended: false, messageId: entry.entryId },
      });
      await expect(
        appendStrict({
          ...scope,
          message: { ...message, idempotencyKey: "separate-journal:assistant" },
        }),
      ).resolves.toMatchObject({ kind: "result", result: { appended: true } });
      expect(updates).toHaveLength(1);
      expect(await readEntries(persistedScope)).toHaveLength(2);
    } finally {
      unsubscribe();
    }
  });

  it("distinguishes strict singleton results, suppression, and rebound without a store path", async () => {
    const { scope, persistedScope, superseded } = await seed("default");
    const message = {
      role: "assistant",
      content: [{ type: "text", text: "persisted" }],
      timestamp: 1_000,
      idempotencyKey: "strict:assistant",
    };
    await expect(appendStrict({ ...scope, message })).resolves.toMatchObject({
      kind: "result",
      result: { appended: true },
    });
    await expect(
      appendStrict({
        ...scope,
        message: { role: "user", content: "blocked" },
        prepareMessageAfterIdempotencyCheck: () => undefined,
      }),
    ).resolves.toEqual({ kind: "suppressed" });
    const events = await readEvents(persistedScope);
    expect(events).toEqual([
      expect.objectContaining({ type: "session" }),
      expect.objectContaining({ type: "message", message }),
    ]);
    await expect(superseded(() => appendStrict({ ...scope, message }))).resolves.toEqual({
      kind: "rejected",
      reason: "session-rebound",
    });
    await upsertSessionEntryCore(persistedScope, {
      sessionId: "replacement-session",
      updatedAt: 20,
    });
    await expect(
      appendStrict({
        ...scope,
        message: { role: "assistant", content: "stale" },
      }),
    ).resolves.toEqual({ kind: "rejected", reason: "session-rebound" });
    await expect(readEvents(persistedScope)).resolves.toEqual(events);
    await expect(
      readEvents({ ...persistedScope, sessionId: "replacement-session" }),
    ).resolves.toEqual([]);
  });
});
