import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { repairToolUseResultPairing } from "../../agents/session-transcript-repair.js";
import { normalizeLegacySessionEntryDelivery } from "../../infra/state-migrations.legacy-session-store.js";
import { recordDeliveredCommandExchange } from "../../plugin-sdk/session-transcript-runtime.js";
import * as transcriptEvents from "../../sessions/transcript-events.js";
import {
  CRON_DIRECT_DELIVERY_CONTEXT_KIND,
  OPENCLAW_TRANSCRIPT_ARTIFACT_API,
  isTranscriptOnlyOpenClawAssistantMessage,
} from "../../shared/transcript-only-openclaw-assistant.js";
import { deleteTestEnvValue, setTestEnvValue } from "../../test-utils/env.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../runtime-snapshot.js";
import { resolveSessionTranscriptPathInDir } from "./paths.js";
import {
  loadTranscriptEvents,
  appendTranscriptEvent,
  loadSessionEntry,
  persistSessionTranscriptTurn,
  readLatestTranscriptAssistantText,
  replaceSessionEntry,
  updateSessionEntry,
} from "./session-accessor.js";
import * as activeTranscriptEvents from "./session-accessor.sqlite-active-events.js";
import { replaceSessionEntrySync } from "./session-accessor.sqlite-entry.js";
import { replaceTranscriptEvents } from "./session-accessor.sqlite-transcript-write.test-support.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";
import { waitForSessionTranscriptIndexReconcile } from "./session-transcript-reconcile.js";
import { useTempSessionsFixture } from "./test-helpers.js";
import { createExactAssistantMessage } from "./transcript-message.test-support.js";
import { registerRecentTranscriptTextSnapshotTests } from "./transcript-recent-text.test-support.js";
import {
  bindOwnedSessionTranscriptWrites,
  runWithOwnedSessionTranscriptWrite,
  withOwnedSessionTranscriptWrites,
} from "./transcript-write-context.js";
import {
  appendAssistantMessageToSessionTranscript,
  appendExactAssistantMessageToSessionTranscript,
  readLatestAssistantTextFromSessionTranscript,
  readRecentUserAssistantTextForSession,
} from "./transcript.js";
import type { InternalSessionEntry, SessionEntry } from "./types.js";

function assertOk<T extends { ok: boolean }>(result: T): asserts result is T & { ok: true } {
  expect(result.ok).toBe(true);
}

function textMessage(role: string, text: string) {
  return expect.objectContaining({ role, content: [{ type: "text", text }] });
}

type SessionEntryFixture = Partial<InternalSessionEntry> & { channel?: string };

const sessionDirs = useSessionStoreTempDirs(
  (cleanup) =>
    afterAll(async () => {
      await cleanup();
      clearRuntimeConfigSnapshot();
    }),
  "transcript-test-",
);

describe("appendAssistantMessageToSessionTranscript", () => {
  beforeAll(async () => {
    const tempDir = sessionDirs.make();
    setRuntimeConfigSnapshot({});
    const sessionsDir = path.join(tempDir, "agents", "main", "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    const storePath = path.join(sessionsDir, "sessions.json");
    await replaceSessionEntry(
      { sessionKey: "agent:main:warm", storePath },
      { sessionId: "warm-session", chatType: "direct", updatedAt: 1 },
    );
    await appendAssistantMessageToSessionTranscript({
      agentId: "main",
      sessionKey: "agent:main:warm",
      text: "warm",
      storePath,
    });
  });

  const fixture = useTempSessionsFixture("transcript-test-");
  beforeEach(() => setRuntimeConfigSnapshot({}));
  const sessionId = "test-session-id";
  const sessionKey = "agent:main:test-session";
  function transcriptScope() {
    return { agentId: "main", sessionId, sessionKey, storePath: fixture.storePath() };
  }
  type FixtureAppend<P> = Omit<P, "sessionKey" | "storePath">;
  function appendMirror(
    text: string,
    params: Omit<
      FixtureAppend<Parameters<typeof appendAssistantMessageToSessionTranscript>[0]>,
      "text"
    > = {},
  ) {
    return appendAssistantMessageToSessionTranscript({
      text,
      sessionKey,
      storePath: fixture.storePath(),
      ...params,
    });
  }
  function appendExact(
    params: FixtureAppend<Parameters<typeof appendExactAssistantMessageToSessionTranscript>[0]>,
  ) {
    return appendExactAssistantMessageToSessionTranscript({
      sessionKey,
      storePath: fixture.storePath(),
      ...params,
    });
  }
  function persistMessages(
    messages: Parameters<typeof persistSessionTranscriptTurn>[1]["messages"],
  ) {
    return persistSessionTranscriptTurn(transcriptScope(), { updateMode: "none", messages });
  }
  function recentText(
    params: Omit<
      Parameters<typeof readRecentUserAssistantTextForSession>[0],
      "agentId" | "sessionKey" | "storePath"
    > = {},
  ) {
    return readRecentUserAssistantTextForSession({
      agentId: "main",
      sessionKey,
      storePath: fixture.storePath(),
      ...params,
    });
  }
  function appendText(
    text: string,
    params: Omit<Parameters<typeof appendExact>[0], "message"> = {},
  ) {
    return appendExact({ ...params, message: createExactAssistantMessage({ text }) });
  }
  async function recordCommand(
    params: Omit<Parameters<typeof recordDeliveredCommandExchange>[0], "sessionKey" | "storePath">,
  ) {
    return recordDeliveredCommandExchange({
      sessionKey,
      storePath: fixture.storePath(),
      ...params,
    });
  }
  async function startEntryChange(patch: Partial<InternalSessionEntry>) {
    const gate = createDeferred();
    const started = createDeferred();
    const change = updateSessionEntry(transcriptScope(), async () => {
      started.resolve();
      await gate.promise;
      return patch;
    });
    await started.promise;
    return async () => {
      gate.resolve();
      await change;
    };
  }
  type BeforeMessageWriteParams = Parameters<
    NonNullable<
      Parameters<typeof appendExactAssistantMessageToSessionTranscript>[0]["beforeMessageWrite"]
    >
  >[0];
  type TranscriptRepairMessage = Parameters<typeof repairToolUseResultPairing>[0][number];

  function writeLegacyTranscriptFixture(params: {
    transcriptPath: string;
    message: { role: "user"; content: string; timestamp: number };
  }) {
    const entries = [
      {
        type: "session",
        version: 4,
        id: sessionId,
        timestamp: new Date(0).toISOString(),
        cwd: fixture.sessionsDir(),
      },
      {
        type: "message",
        id: "legacy-message",
        parentId: null,
        timestamp: new Date(params.message.timestamp).toISOString(),
        message: params.message,
      },
    ];
    fs.writeFileSync(
      params.transcriptPath,
      `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    );
  }

  async function writeTranscriptStore(entry: SessionEntryFixture = {}) {
    await replaceSessionEntry(
      { agentId: "main", sessionKey, storePath: fixture.storePath() },
      normalizeLegacySessionEntryDelivery({
        sessionId,
        chatType: "direct",
        updatedAt: 1,
        channel: "discord",
        ...entry,
      } as SessionEntry),
    );
  }

  async function loadFixtureMessages(): Promise<Array<{ message?: unknown }>> {
    return (await loadTranscriptEvents(transcriptScope())) as Array<{
      message?: unknown;
    }>;
  }

  it("appends replayable, redacted command exchanges exactly once without changing prior rows", async () => {
    await writeTranscriptStore();
    await appendMirror("Earlier reply");
    const before = await loadFixtureMessages();
    const params = {
      sessionKey,
      storePath: fixture.storePath(),
      commandText: "/login openai",
      commandId: "login-message",
      replyText: "Sign in at https://example.test/device?state=secret-state\nCode: EXAMPLE-CODE",
      replyId: "device-code",
    };
    assertOk(await recordDeliveredCommandExchange(params));
    expect((await recordDeliveredCommandExchange(params)).ok).toBe(true);
    assertOk(
      await recordDeliveredCommandExchange({
        ...params,
        replyId: "complete",
        replyText: "Login complete.",
      }),
    );
    const after = await loadFixtureMessages();
    expect(after.slice(0, before.length)).toEqual(before);
    const messages = after.slice(before.length).map((event) => event.message);
    expect(messages).toEqual([
      textMessage("user", "/login openai"),
      expect.objectContaining({
        role: "assistant",
        content: [
          { type: "text", text: "Sign in at [login URL redacted]\nCode: [login code redacted]" },
        ],
      }),
      textMessage("assistant", "Login complete."),
    ]);
    expect(messages.some(isTranscriptOnlyOpenClawAssistantMessage)).toBe(false);
    expect(JSON.stringify(after)).not.toContain("EXAMPLE-CODE");
    expect(JSON.stringify(after)).not.toContain("secret-state");
  });

  it.each([
    {
      commandText: "/pair",
      replyText: Buffer.from(
        JSON.stringify({ url: "wss://example.test", bootstrapToken: "secret-pairing-token" }),
      ).toString("base64url"),
      expected: "[pairing code redacted]",
    },
    {
      commandText: "/status",
      replyText:
        "Verify: https://example.test/auth?state=secret-state\nHelp: https://example.test/help",
      expected: "Verify: [login URL redacted]\nHelp: https://example.test/help",
    },
  ])("redacts credential-bearing $commandText replies before storage", async (testCase) => {
    await writeTranscriptStore();
    assertOk(await recordCommand({ ...testCase, commandId: "secret-command", replyId: "reply" }));
    const events = await loadFixtureMessages();
    expect(events.at(-1)?.message).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: testCase.expected }],
    });
    expect(JSON.stringify(events)).not.toContain(testCase.replyText);
  });

  it.each([
    [
      '/debug set gateway.auth.token="synthetic-private-token"',
      '/debug set gateway.auth.token="__OPENCLAW_REDACTED__"',
    ],
    [
      '/config set gateway.auth={"mode":"token","token":"synthetic-private-token"}',
      '/config set gateway.auth={"mode":"token","token":"__OPENCLAW_REDACTED__"}',
    ],
    [
      "/debug set channels.telegram.botToken=synthetic-private-token",
      '/debug set channels.telegram.botToken="__OPENCLAW_REDACTED__"',
    ],
    [
      '/debug: set models.providers.local.headers.X-Service-Access="q7m2n9v4p6r8x5"',
      '/debug set models.providers.local.headers.X-Service-Access="__OPENCLAW_REDACTED__"',
    ],
    [
      '/config@OpenClawBot: set models.providers.local.headers.X-Service-Access="q7m2n9v4p6r8x5"',
      '/config set models.providers.local.headers.X-Service-Access="__OPENCLAW_REDACTED__"',
    ],
    ['/debug set logging.level="debug"', '/debug set logging.level="debug"'],
  ])("redacts configuration input %s before recording", async (commandText, expected) => {
    await writeTranscriptStore();
    const result = await recordCommand({
      commandText,
      replyText: "Configuration updated.",
      commandId: "config-command",
      replyId: "reply",
    });
    assertOk(result);
    const events = await loadFixtureMessages();
    expect(events.at(-2)?.message).toMatchObject({
      role: "user",
      content: [{ type: "text", text: expected }],
    });
    expect(JSON.stringify(events)).not.toContain("synthetic-private-token");
    expect(JSON.stringify(events)).not.toContain("q7m2n9v4p6r8x5");
  });

  it.each(["/btw hello", "/side hello", "/btw: hello", "/side@OpenClawBot: hello"])(
    "keeps %s ephemeral",
    async (commandText) => {
      await writeTranscriptStore();
      const before = await loadFixtureMessages();
      await recordCommand({
        commandText,
        replyText: "Side answer",
        commandId: "side-command",
        replyId: "reply",
      });
      expect(await loadFixtureMessages()).toEqual(before);
    },
  );

  it("uses the session key agent for configured session.store templates", async () => {
    const tempDir = sessionDirs.make();
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    const emitSpy = vi.spyOn(transcriptEvents, "emitSessionTranscriptUpdate");
    try {
      setTestEnvValue("OPENCLAW_STATE_DIR", path.join(tempDir, "default-state"));
      const storeTemplate = path.join(tempDir, "agents", "{agentId}", "sessions", "sessions.json");
      const sessionsDir = path.join(tempDir, "agents", "worker", "sessions");
      fs.mkdirSync(sessionsDir, { recursive: true });
      const storePath = path.join(sessionsDir, "sessions.json");
      setRuntimeConfigSnapshot({ session: { store: storeTemplate } });
      const configuredSessionKey = "agent:worker:configured-store";
      const target = {
        agentId: "worker",
        sessionId: "worker-session-id",
        sessionKey: configuredSessionKey,
        storePath,
      };
      await replaceSessionEntry(target, {
        sessionId: target.sessionId,
        chatType: "direct",
        updatedAt: 1,
      });
      const beforeMessageWrite = vi.fn(({ message }: BeforeMessageWriteParams) => message);

      const result = await appendAssistantMessageToSessionTranscript({
        sessionKey: configuredSessionKey,
        text: "mirrored worker store reply",
        config: { session: { store: storeTemplate } },
        beforeMessageWrite,
      });

      assertOk(result);
      expect(result.target).toEqual(target);
      await expect(loadTranscriptEvents(target)).resolves.toContainEqual(
        expect.objectContaining({
          message: textMessage("assistant", "mirrored worker store reply"),
        }),
      );
      expect(beforeMessageWrite).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: "worker",
          sessionKey: configuredSessionKey,
        }),
      );
      expect(emitSpy.mock.calls[0]?.[0]).toMatchObject({
        agentId: "worker",
        sessionKey: configuredSessionKey,
      });
    } finally {
      emitSpy.mockRestore();
      if (previousStateDir === undefined) {
        deleteTestEnvValue("OPENCLAW_STATE_DIR");
      } else {
        setTestEnvValue("OPENCLAW_STATE_DIR", previousStateDir);
      }
    }
  });

  it("does not advance the registry marker for duplicate delivery mirror replays", async () => {
    const updatedAt = Date.parse("2026-05-18T10:00:00.000Z");
    const firstAppendAt = Date.parse("2026-05-18T10:05:00.000Z");
    const duplicateReplayAt = Date.parse("2026-05-18T10:10:00.000Z");
    const sessionFile = "duplicate-marker.jsonl";
    await writeTranscriptStore({ sessionFile, updatedAt, status: "done" });
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(firstAppendAt);
      const first = await appendMirror("Replay-safe marker");
      assertOk(first);

      vi.setSystemTime(duplicateReplayAt);
      const duplicate = await appendMirror("Replay-safe marker");
      assertOk(duplicate);

      const saved = loadSessionEntry({
        agentId: "main",
        sessionKey,
        storePath: fixture.storePath(),
      });
      expect(saved?.updatedAt).toBe(firstAppendAt);
      expect(duplicate.messageId).toBe(first.messageId);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses spawned cwd when creating a missing transcript header", async () => {
    const taskCwd = path.join(fixture.sessionsDir(), "task-repo");
    fs.mkdirSync(taskCwd, { recursive: true });
    await writeTranscriptStore({ spawnedCwd: taskCwd });
    const result = await appendMirror("Hello from task cwd!");
    assertOk(result);
    const events = await loadFixtureMessages();
    expect(events).toContainEqual(
      expect.objectContaining({
        cwd: taskCwd,
        type: "session",
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        message: textMessage("assistant", "Hello from task cwd!"),
      }),
    );
  });

  it.each(["file", "store", "agent", "bound"] as const)(
    "keeps owned write tracking scoped to the matching %s target",
    async (kind) => {
      const file = (id: string) => resolveSessionTranscriptPathInDir(id, fixture.sessionsDir());
      const ownerTarget = {
        agentId: "main",
        sessionKey: "global",
        ...(kind === "store" ? { storePath: "/tmp/main.sqlite" } : {}),
      };
      const otherTarget = {
        agentId: "worker",
        sessionKey: "global",
        ...(kind === "store" ? { storePath: "/tmp/worker.sqlite" } : {}),
      };
      const scoped = kind === "store" || kind === "agent";
      const owner = scoped
        ? { sessionFile: "global", sessionKey: "global", sessionTarget: ownerTarget }
        : { sessionFile: file("old-session"), sessionKey };
      const request = scoped
        ? { sessionFile: "global", sessionKey: "global", sessionTarget: otherTarget }
        : { sessionFile: kind === "bound" ? owner.sessionFile : file("next-session"), sessionKey };
      const events: string[] = [];
      const context = {
        ...owner,
        withTranscriptWrite: async <T>(run: () => T | Promise<T>) => {
          events.push("owned-write");
          return await run();
        },
      };
      const write = () =>
        runWithOwnedSessionTranscriptWrite(request, () => {
          events.push("write");
          return "ok";
        });
      const result =
        kind === "bound"
          ? await bindOwnedSessionTranscriptWrites(context, write)()
          : await withOwnedSessionTranscriptWrites(context, write);
      expect(result).toBe("ok");
      expect(events).toEqual(kind === "bound" ? ["owned-write", "write"] : ["write"]);
    },
  );

  it("dedupes delivery mirrors against the active SQLite branch tail", async () => {
    await writeTranscriptStore();
    const written = await persistMessages([
      { message: createExactAssistantMessage({ text: "Active branch reply" }) },
      { message: createExactAssistantMessage({ text: "Inactive branch reply" }) },
    ]);
    const [active, inactive] = written.messages;
    if (!active || !inactive) {
      throw new Error("expected assistant events");
    }
    await appendTranscriptEvent(
      { agentId: "main", sessionId, sessionKey, storePath: fixture.storePath() },
      {
        type: "leaf",
        id: "active-leaf",
        parentId: inactive.messageId,
        targetId: active.messageId,
      },
    );
    const hostRead = vi
      .spyOn(activeTranscriptEvents, "readLatestSessionTranscriptMessageEvent")
      .mockImplementation(() => {
        throw new Error("Delivery mirror must read the active tail in its worker");
      });
    let mirrorResult;
    try {
      mirrorResult = await appendMirror("Active branch reply");
      expect(hostRead).not.toHaveBeenCalled();
    } finally {
      hostRead.mockRestore();
    }
    assertOk(mirrorResult);
    expect(mirrorResult.messageId).toBe(active.messageId);
  });

  it("idempotently appends identified channel finals while preserving repeated replies", async () => {
    await writeTranscriptStore();
    const first = await appendMirror("Repeated command reply", {
      idempotencyKey: "channel-final:message-1:0",
      deliveryMirror: { kind: "channel-final", sourceMessageId: "message-1" },
    });
    const replay = await appendMirror("Repeated command reply", {
      idempotencyKey: "channel-final:message-1:0",
      deliveryMirror: { kind: "channel-final", sourceMessageId: "message-1" },
    });
    const nextTurn = await appendMirror("Repeated command reply", {
      idempotencyKey: "channel-final:message-2:0",
      deliveryMirror: { kind: "channel-final", sourceMessageId: "message-2" },
    });
    assertOk(first);
    assertOk(replay);
    assertOk(nextTurn);
    expect(replay.messageId).toBe(first.messageId);
    expect(nextTurn.messageId).not.toBe(first.messageId);
    const messages = (await loadFixtureMessages()).flatMap((entry) =>
      entry.message ? [entry.message] : [],
    ) as Array<{ openclawDeliveryMirror?: unknown }>;
    expect(messages).toHaveLength(2);
    expect(messages[0]?.openclawDeliveryMirror).toEqual({
      kind: "channel-final",
      sourceMessageId: "message-1",
    });
  });

  it("does not dedupe delivery mirrors against an older assistant after a user turn", async () => {
    await writeTranscriptStore();
    const exactResult = await appendText("Hello before the large user entry");
    assertOk(exactResult);
    await persistMessages([{ message: { role: "user", content: "x".repeat(128 * 1024) } }]);
    const latestAssistantText =
      await readLatestAssistantTextFromSessionTranscript(transcriptScope());
    expect(latestAssistantText).toMatchObject({
      id: exactResult.messageId,
      text: "Hello before the large user entry",
    });
    const mirrorResult = await appendMirror("Hello before the large user entry");
    assertOk(mirrorResult);
    expect(mirrorResult.messageId).not.toBe(exactResult.messageId);
    const records = await loadFixtureMessages();
    const messages = records.flatMap((record) =>
      record.message ? [record.message] : [],
    ) as Array<{ model?: string; content?: Array<{ text?: string }> }>;
    expect(messages).toHaveLength(3);
    expect(messages[2]).toMatchObject({
      model: "delivery-mirror",
      content: [{ text: "Hello before the large user entry" }],
    });
  });

  it("admits only marked Cron delivery context when explicitly requested", async () => {
    await writeTranscriptStore();
    await persistMessages([
      { eventId: "user", message: { role: "user", content: "ordinary user" } },
      { eventId: "assistant", message: { role: "assistant", content: "ordinary assistant" } },
    ]);
    await appendMirror("scheduled result", {
      idempotencyKey: "cron-delivery",
      deliveryMirror: { kind: CRON_DIRECT_DELIVERY_CONTEXT_KIND },
    });
    await appendMirror("ordinary delivery mirror", {
      idempotencyKey: "channel-delivery",
      deliveryMirror: { kind: "channel-final" },
    });
    const params = {
      agentId: "main",
      sessionKey,
      storePath: fixture.storePath(),
      limit: 10,
    };
    await expect(readRecentUserAssistantTextForSession(params)).resolves.toEqual([
      expect.objectContaining({ role: "user", text: "ordinary user" }),
      expect.objectContaining({ role: "assistant", text: "ordinary assistant" }),
    ]);
    await expect(
      readRecentUserAssistantTextForSession({
        ...params,
        includeCronDirectDeliveryContext: true,
      }),
    ).resolves.toEqual([
      expect.objectContaining({ role: "user", text: "ordinary user" }),
      expect.objectContaining({ role: "assistant", text: "ordinary assistant" }),
      expect.objectContaining({ role: "assistant", text: "scheduled result" }),
    ]);
  });

  registerRecentTranscriptTextSnapshotTests({
    fixture,
    sessionId,
    sessionKey,
    createFixtureTranscriptScope: transcriptScope,
    writeTranscriptStore,
  });

  it("rejects a session key scoped to a different agent", async () => {
    await expect(
      readRecentUserAssistantTextForSession({
        agentId: "main",
        sessionKey: "agent:worker:main",
        storePath: fixture.storePath(),
      }),
    ).rejects.toMatchObject({
      code: "SESSION_TRANSCRIPT_AGENT_SCOPE_MISMATCH",
      name: "SessionTranscriptAgentScopeMismatchError",
    });
  });

  it("resolves an unscoped main alias with the configured agent owner", async () => {
    const mainSessionKey = "agent:main:main";
    await replaceSessionEntry(
      { agentId: "main", sessionKey: mainSessionKey, storePath: fixture.storePath() },
      normalizeLegacySessionEntryDelivery({ sessionId, updatedAt: 1 }),
    );
    await persistSessionTranscriptTurn(
      { agentId: "main", sessionId, sessionKey: mainSessionKey, storePath: fixture.storePath() },
      {
        updateMode: "none",
        messages: [{ message: { role: "user", content: "from main alias", timestamp: 4_000 } }],
      },
    );
    await expect(
      readRecentUserAssistantTextForSession({
        agentId: "main",
        sessionKey: "main",
        storePath: fixture.storePath(),
        beforeTimestampMs: 5_000,
      }),
    ).resolves.toEqual([
      {
        id: expect.any(String),
        role: "user",
        text: "from main alias",
        timestamp: 4_000,
      },
    ]);
  });

  it("does not fall back to stale JSONL when SQLite has no transcript rows", async () => {
    await writeTranscriptStore({
      sessionFile: `sqlite:main:${sessionId}:${fixture.storePath()}`,
    });
    const sessionFile = resolveSessionTranscriptPathInDir(sessionId, fixture.sessionsDir());
    writeLegacyTranscriptFixture({
      transcriptPath: sessionFile,
      message: { role: "user", content: "stale jsonl context", timestamp: 1_000 },
    });
    await expect(
      recentText({
        beforeTimestampMs: 5_000,
      }),
    ).resolves.toEqual([]);
  });

  it("ignores stored session files outside the sessions directory for recent context", async () => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "transcript-outside-"));
    try {
      const outsideFile = path.join(outsideDir, "outside.jsonl");
      await writeTranscriptStore({ sessionFile: outsideFile });
      writeLegacyTranscriptFixture({
        transcriptPath: outsideFile,
        message: { role: "user", content: "outside text", timestamp: 1_000 },
      });
      const sessionFile = resolveSessionTranscriptPathInDir(sessionId, fixture.sessionsDir());
      writeLegacyTranscriptFixture({
        transcriptPath: sessionFile,
        message: { role: "user", content: "contained text", timestamp: 2_000 },
      });
      await persistMessages([
        { message: { role: "user", content: "sqlite text", timestamp: 2_500 } },
      ]);

      await expect(
        readRecentUserAssistantTextForSession({
          agentId: "main",
          sessionKey,
          storePath: fixture.storePath(),
          beforeTimestampMs: 3_000,
        }),
      ).resolves.toEqual([
        {
          id: expect.any(String),
          role: "user",
          text: "sqlite text",
          timestamp: 2_500,
        },
      ]);
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("skips hidden and transcript-only assistant entries when reading latest assistant text", async () => {
    await writeTranscriptStore();
    const finalResult = await appendText("Complete final answer");
    assertOk(finalResult);
    await appendMirror("Earlier retained preview");
    await appendExact({
      message: createExactAssistantMessage({
        text: "Injected transcript text",
        provider: "openclaw",
        model: "gateway-injected",
      }),
    });
    const hiddenAssistant = {
      ...createExactAssistantMessage({ text: "Hidden internal completion" }),
      display: false,
    };
    await appendExact({ message: hiddenAssistant });
    const latestAssistantText =
      await readLatestAssistantTextFromSessionTranscript(transcriptScope());
    expect(latestAssistantText).toMatchObject({
      id: finalResult.messageId,
      text: "Complete final answer",
    });
  });

  it("does not report transcript-only OpenClaw assistant entries as latest assistant text", async () => {
    await writeTranscriptStore();
    const mirrorResult = await appendMirror("Only delivery mirror");
    assertOk(mirrorResult);
    const latestAssistantText =
      await readLatestAssistantTextFromSessionTranscript(transcriptScope());
    expect(latestAssistantText).toBeUndefined();
  });

  it("scans past trailing assistant entries without visible text", async () => {
    await writeTranscriptStore();
    const assistantResult = await appendExact({
      message: createExactAssistantMessage({
        text: "Visible answer before tool call",
      }),
    });
    assertOk(assistantResult);
    const toolOnlyResult = await appendExact({
      message: {
        ...createExactAssistantMessage({
          content: [
            {
              type: "toolCall",
              id: "call_latest_no_visible_text",
              name: "maniple__list_workers",
              arguments: {},
            },
          ],
        }),
        stopReason: "toolUse",
      },
    });
    assertOk(toolOnlyResult);
    const latestAssistantText = readLatestTranscriptAssistantText({
      sessionId,
      sessionKey,
      storePath: fixture.storePath(),
    });
    expect(latestAssistantText).toMatchObject({
      id: assistantResult.messageId,
      text: "Visible answer before tool call",
    });
  });

  it("does not reuse an older matching assistant message across turns", async () => {
    await writeTranscriptStore();

    const olderResult = await appendExactAssistantMessageToSessionTranscript({
      sessionKey,
      storePath: fixture.storePath(),
      message: createExactAssistantMessage({ text: "Repeated answer" }),
    });

    const latestResult = await appendExactAssistantMessageToSessionTranscript({
      sessionKey,
      storePath: fixture.storePath(),
      message: createExactAssistantMessage({ text: "Different latest answer" }),
    });

    const mirrorResult = await appendAssistantMessageToSessionTranscript({
      sessionKey,
      text: "Repeated answer",
      storePath: fixture.storePath(),
    });

    expect(olderResult.ok).toBe(true);
    expect(latestResult.ok).toBe(true);
    expect(mirrorResult.ok).toBe(true);
    if (olderResult.ok && latestResult.ok && mirrorResult.ok) {
      expect(mirrorResult.messageId).not.toBe(olderResult.messageId);
      expect(mirrorResult.messageId).not.toBe(latestResult.messageId);

      const messages = (await loadFixtureMessages()).flatMap((entry) =>
        entry.message ? [entry.message] : [],
      ) as Array<{
        api?: string;
        provider?: string;
        model?: string;
        content?: Array<{ text?: string }>;
      }>;
      expect(messages).toHaveLength(3);
      expect(messages[2]?.api).toBe(OPENCLAW_TRANSCRIPT_ARTIFACT_API);
      expect(messages[2]?.provider).toBe("openclaw");
      expect(messages[2]?.model).toBe("delivery-mirror");
      expect(messages[2]?.content?.[0]?.text).toBe("Repeated answer");
    }
  });

  it("keeps delivery mirrors in transcripts while repair preserves real tool results", async () => {
    await writeTranscriptStore();
    const toolCallId = "call_maniple_list";
    const toolCallTurn = await persistMessages([
      {
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: toolCallId,
              name: "maniple__list_workers",
              arguments: {},
            },
          ],
          stopReason: "toolUse",
        },
      },
    ]);
    const toolCallResult = toolCallTurn.messages[0];
    expect(toolCallResult?.messageId).toBeTypeOf("string");
    const mirrorResult = await appendMirror("Maniple List Workers");
    assertOk(mirrorResult);
    expect(mirrorResult.messageId).not.toBe(toolCallResult?.messageId);
    const messagesAfterMirror = (await loadFixtureMessages()).flatMap((entry) =>
      entry.message ? [entry.message] : [],
    ) as Array<{ api?: string; model?: string }>;
    expect(messagesAfterMirror).toHaveLength(2);
    expect(messagesAfterMirror[1]).toMatchObject({
      api: OPENCLAW_TRANSCRIPT_ARTIFACT_API,
      model: "delivery-mirror",
    });
    await persistMessages([
      {
        message: {
          role: "toolResult",
          toolCallId,
          toolName: "maniple__list_workers",
          content: [{ type: "text", text: "workers listed" }],
          isError: false,
        },
      },
    ]);
    const messages = (await loadFixtureMessages()).flatMap((entry) =>
      entry.message ? [entry.message as TranscriptRepairMessage] : [],
    );
    expect(messages.map((message) => message.role)).toEqual([
      "assistant",
      "assistant",
      "toolResult",
    ]);
    const repair = repairToolUseResultPairing(messages, {
      missingToolResultText: "aborted",
    });
    expect(repair.added).toHaveLength(0);
    expect(repair.messages.map((message) => message.role)).toEqual([
      "assistant",
      "toolResult",
      "assistant",
    ]);
    expect((repair.messages[2] as { model?: string }).model).toBe("delivery-mirror");
  });

  it.each([true, false])("dedupes hook-rewritten replies (keyed=%s)", async (keyed) => {
    await writeTranscriptStore();
    const beforeMessageWrite = vi.fn(({ message }: BeforeMessageWriteParams) => ({
      ...message,
      content: [{ type: "text" as const, text: "[redacted by hook]" }],
    }));
    const idempotencyKey = "cli-assistant:redacted";
    const append = () =>
      keyed
        ? appendText("secret output", { idempotencyKey, beforeMessageWrite })
        : appendMirror("secret output", { beforeMessageWrite });
    assertOk(await append());
    assertOk(await append());
    expect(beforeMessageWrite).toHaveBeenCalledTimes(keyed ? 1 : 2);
    const messages = (await loadFixtureMessages()).flatMap((entry) =>
      entry.message ? [entry.message] : [],
    );
    expect(messages).toEqual([
      expect.objectContaining({
        role: "assistant",
        content: [{ type: "text", text: "[redacted by hook]" }],
        ...(keyed ? { idempotencyKey } : {}),
      }),
    ]);
  });

  it("dedupes a delivery mirror without parsing historical message bodies", async () => {
    await writeTranscriptStore();
    const scope = transcriptScope();
    const history = Array.from({ length: 500 }, (_, index) => ({
      type: "message",
      id: `history-${index}`,
      parentId: index === 0 ? null : `history-${index - 1}`,
      message: {
        role: "user",
        content: `archived-mirror-body-${index} ${"x".repeat(2_000)}`,
      },
    }));
    await replaceTranscriptEvents(scope, [
      ...history,
      {
        type: "message",
        id: "latest-reply",
        parentId: "history-499",
        message: createExactAssistantMessage({ text: "The current reply" }),
      },
    ]);
    await waitForSessionTranscriptIndexReconcile({
      agentId: "main",
      path: resolveSqliteTargetFromSessionStorePath(fixture.storePath(), { agentId: "main" }).path,
    });
    const parse = JSON.parse;
    let parsedHistoricalBodies = 0;
    const parseSpy = vi.spyOn(JSON, "parse").mockImplementation((text, reviver) => {
      if (typeof text === "string" && text.includes("archived-mirror-body-")) {
        parsedHistoricalBodies += 1;
      }
      return parse(text, reviver);
    });
    try {
      const result = await appendMirror("The current reply");
      expect(result).toMatchObject({ ok: true, messageId: "latest-reply" });
      expect(parsedHistoricalBodies).toBe(0);
    } finally {
      parseSpy.mockRestore();
    }
    expect(await loadFixtureMessages()).toHaveLength(history.length + 1);
  });

  it("reports assistant messages blocked by before_message_write", async () => {
    await writeTranscriptStore();
    const result = await appendExact({
      agentId: "main",
      idempotencyKey: "cli-assistant:blocked",
      beforeMessageWrite: vi.fn(() => null),
      message: createExactAssistantMessage({ text: "secret output" }),
    });
    expect(result).toMatchObject({
      ok: false,
      code: "blocked",
    });
  });

  it.each(["session", "lifecycle", "writer"] as const)(
    "rejects concurrent %s replacement",
    async (kind) => {
      const replacementSessionFile = resolveSessionTranscriptPathInDir(
        "replacement-session",
        fixture.sessionsDir(),
      );
      const lifecycleRevision = kind === "writer" ? "owned-revision" : "original-revision";
      await writeTranscriptStore(
        kind === "session"
          ? {}
          : {
              lifecycleRevision,
              ...(kind === "writer" ? { activeWriterRunId: "run-a" } : {}),
            },
      );
      const patch =
        kind === "session"
          ? { sessionId: "replacement-session", sessionFile: replacementSessionFile }
          : kind === "lifecycle"
            ? { lifecycleRevision: "replacement-revision" }
            : { activeWriterRunId: "run-b" };
      const finishChange = await startEntryChange(patch);
      const admission = {
        expectedSessionId: sessionId,
        ...(kind !== "session" ? { expectedLifecycleRevision: lifecycleRevision } : {}),
        ...(kind === "writer" ? { expectedWriterRunId: "run-a" } : {}),
      };
      const append = appendText("late output", admission);
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      await finishChange();
      await expect(append).resolves.toMatchObject({ ok: false, code: "session-rebound" });
      if (kind === "session") {
        expect(fs.existsSync(replacementSessionFile)).toBe(false);
      }
      if (kind === "writer") {
        await expect(
          appendText("current output", { ...admission, expectedWriterRunId: "run-b" }),
        ).resolves.toMatchObject({ ok: true });
      }
    },
  );

  it("rejects revision materialization between the initial check and SQLite append", async () => {
    await writeTranscriptStore({ lifecycleRevision: undefined });
    const scope = transcriptScope();
    const entry = loadSessionEntry(scope);
    if (!entry) {
      throw new Error("expected session entry");
    }
    let revisionMaterialized = false;
    const result = await appendExact({
      expectedLifecycleRevision: null,
      expectedSessionId: sessionId,
      beforeMessageWrite: ({ message }) => {
        replaceSessionEntrySync(scope, {
          ...entry,
          lifecycleRevision: "replacement-revision",
          updatedAt: 2,
        });
        revisionMaterialized = true;
        return message;
      },
      message: createExactAssistantMessage({ text: "late output" }),
    });
    expect(revisionMaterialized).toBe(true);
    expect(result).toMatchObject({ ok: false, code: "session-rebound" });
    expect(await loadFixtureMessages()).toEqual([]);
  });

  it("dedupes concurrent exact assistant appends by idempotency key", async () => {
    await writeTranscriptStore();
    const idempotencyKey = "mirror:concurrent-assistant";
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        appendExact({
          idempotencyKey,
          updateMode: "none",
          message: createExactAssistantMessage({
            text: "Mirrored reply",
            provider: "openclaw",
            model: "delivery-mirror",
          }),
        }),
      ),
    );
    expect(results.every((result) => result.ok)).toBe(true);
    const messageIds = results.map((result) => (result.ok ? result.messageId : ""));
    expect(new Set(messageIds).size).toBe(1);
    const firstOk = results.find((result) => result.ok);
    if (!firstOk?.ok) {
      throw new Error("expected exact assistant append to succeed");
    }
    const records = (await loadFixtureMessages()).filter((record) => {
      const message = record.message as { role?: string; idempotencyKey?: string } | undefined;
      return message?.role === "assistant" && message.idempotencyKey === idempotencyKey;
    });
    expect(records).toHaveLength(1);
  });

  it("can emit file-only transcript refresh events for exact assistant appends", async () => {
    await writeTranscriptStore();
    const emitSpy = vi.spyOn(transcriptEvents, "emitSessionTranscriptUpdate");
    const result = await appendExact({
      updateMode: "file-only",
      message: createExactAssistantMessage({
        text: "Done.",
        provider: "openclaw",
        model: "delivery-mirror",
      }),
    });
    assertOk(result);
    expect(emitSpy).toHaveBeenCalledWith({
      agentId: "main",
      sessionKey,
      target: {
        agentId: "main",
        sessionId,
        sessionKey,
        storePath: fixture.storePath(),
      },
    });
    emitSpy.mockRestore();
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
