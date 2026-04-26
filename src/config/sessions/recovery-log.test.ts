import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { MsgContext } from "../../auto-reply/templating.js";
import { createSuiteTempRootTracker } from "../../test-helpers/temp-dir.js";
import {
  SESSION_RECOVERY_MAX_STRING_LENGTH,
  SESSION_RECOVERY_REDACTED_VALUE,
  appendSessionRecoveryEvent,
  buildSessionRecoveryEvent,
  readSessionRecoveryEventsForTest,
  resolveSessionRecoveryLogPath,
} from "./recovery-log.js";
import {
  clearSessionStoreCacheForTest,
  recordSessionMetaFromInbound,
  updateLastRoute,
} from "./store.js";

const suiteRootTracker = createSuiteTempRootTracker({
  prefix: "openclaw-session-recovery-log-",
});

describe("session recovery log", () => {
  beforeAll(async () => {
    await suiteRootTracker.setup();
  });

  afterEach(() => {
    clearSessionStoreCacheForTest();
  });

  afterAll(async () => {
    await suiteRootTracker.cleanup();
  });

  async function createStorePath() {
    const dir = await suiteRootTracker.make("case");
    const storePath = path.join(dir, "sessions.json");
    await fs.writeFile(storePath, "{}", "utf-8");
    return storePath;
  }

  it("appends JSONL recovery events next to the session store", async () => {
    const storePath = await createStorePath();
    await appendSessionRecoveryEvent({
      storePath,
      eventId: "event-1",
      eventType: "session.bound",
      timestamp: 123,
      sessionKey: "agent:main:discord:dm:user-1",
      sessionId: "sess-1",
      source: { kind: "inbound", provider: "discord", channel: undefined },
      details: { messageSid: "msg-1", omitted: undefined },
    });

    const logPath = resolveSessionRecoveryLogPath(storePath);
    const raw = await fs.readFile(logPath, "utf-8");
    expect(raw.trim().split(/\r?\n/)).toHaveLength(1);
    const stat = await fs.stat(logPath);
    expect(stat.mode & 0o077).toBe(0);

    const events = await readSessionRecoveryEventsForTest(storePath);
    expect(events).toEqual([
      {
        version: 1,
        eventId: "event-1",
        eventType: "session.bound",
        timestamp: 123,
        sessionKey: "agent:main:discord:dm:user-1",
        sessionId: "sess-1",
        source: { kind: "inbound", provider: "discord" },
        details: { messageSid: "msg-1" },
      },
    ]);
  });

  it("tightens permissions when appending to an existing recovery log", async () => {
    if (process.platform === "win32") {
      return;
    }
    const storePath = await createStorePath();
    const logPath = resolveSessionRecoveryLogPath(storePath);
    await fs.writeFile(logPath, "", { encoding: "utf-8", mode: 0o666 });
    await fs.chmod(logPath, 0o666);

    await appendSessionRecoveryEvent({
      storePath,
      eventId: "event-existing-file",
      eventType: "session.bound",
      timestamp: 123,
      sessionKey: "agent:main:discord:dm:user-1",
    });

    const stat = await fs.stat(logPath);
    expect(stat.mode & 0o077).toBe(0);
  });

  it("sanitizes recovery details before events are serialized", () => {
    const longBody = "x".repeat(SESSION_RECOVERY_MAX_STRING_LENGTH + 10);
    const event = buildSessionRecoveryEvent({
      eventId: "event-redaction",
      eventType: "outbound.sent",
      timestamp: 123,
      sessionKey: "agent:main:discord:dm:user-1",
      details: {
        contextTokens: 1234,
        accessToken: "secret-token",
        headers: {
          authorization: "Bearer secret",
          cookie: "session=secret",
        },
        nested: [{ apiKey: "secret-key" }, { body: longBody }],
      },
    });

    expect(event.details).toMatchObject({
      contextTokens: 1234,
      accessToken: SESSION_RECOVERY_REDACTED_VALUE,
      headers: {
        authorization: SESSION_RECOVERY_REDACTED_VALUE,
        cookie: SESSION_RECOVERY_REDACTED_VALUE,
      },
      nested: [
        { apiKey: SESSION_RECOVERY_REDACTED_VALUE },
        { body: expect.stringContaining("…[truncated]") },
      ],
    });
    expect((event.details?.nested as Array<{ body?: string }>)[1]?.body?.length).toBeGreaterThan(
      SESSION_RECOVERY_MAX_STRING_LENGTH,
    );
  });

  it("records inbound session metadata as an append-only recovery event", async () => {
    const storePath = await createStorePath();
    const ctx: MsgContext = {
      Provider: "discord",
      Surface: "discord",
      ChatType: "direct",
      From: "user-1",
      To: "bot-1",
      AccountId: "default",
      OriginatingChannel: "discord" as MsgContext["OriginatingChannel"],
      OriginatingTo: "user-1",
      MessageSid: "message-1",
      MessageThreadId: "thread-1",
      NativeChannelId: "dm-1",
    };

    const entry = await recordSessionMetaFromInbound({
      storePath,
      sessionKey: "Agent:Main:Discord:DM:User-1",
      ctx,
    });

    expect(entry?.sessionId).toBeTruthy();
    const events = await readSessionRecoveryEventsForTest(storePath);
    expect(events).toHaveLength(2);
    expect(events.map((event) => event.eventType)).toEqual([
      "inbound.received",
      "session.meta.recorded",
    ]);
    for (const event of events) {
      expect(event).toMatchObject({
        version: 1,
        sessionKey: "agent:main:discord:dm:user-1",
        sessionId: entry?.sessionId,
        source: {
          kind: "inbound",
          provider: "discord",
          surface: "discord",
          channel: "discord",
          chatType: "direct",
        },
        details: {
          accountId: "default",
          from: "user-1",
          to: "bot-1",
          originatingTo: "user-1",
          messageSid: "message-1",
          messageThreadId: "thread-1",
          nativeChannelId: "dm-1",
        },
      });
    }
  });

  it("records routing resolution as an append-only recovery event", async () => {
    const storePath = await createStorePath();
    const entry = await updateLastRoute({
      storePath,
      sessionKey: "Agent:Main:Discord:DM:User-1",
      channel: "discord",
      to: "user-1",
      accountId: "default",
      threadId: "thread-1",
      ctx: {
        Provider: "discord",
        Surface: "discord",
        ChatType: "direct",
        From: "user-1",
        To: "bot-1",
        MessageSid: "message-1",
      },
    });

    const events = await readSessionRecoveryEventsForTest(storePath);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      version: 1,
      eventType: "routing.resolved",
      sessionKey: "agent:main:discord:dm:user-1",
      sessionId: entry.sessionId,
      source: {
        kind: "routing",
        provider: "discord",
        surface: "discord",
        channel: "discord",
        chatType: "direct",
      },
      details: {
        accountId: "default",
        to: "user-1",
        threadId: "thread-1",
        deliveryContext: {
          channel: "discord",
          to: "user-1",
          accountId: "default",
          threadId: "thread-1",
        },
        inbound: {
          from: "user-1",
          to: "bot-1",
          messageSid: "message-1",
        },
      },
    });
  });

  it("does not fail route updates when recovery event append fails", async () => {
    const storePath = await createStorePath();
    const appendSpy = vi.spyOn(fs, "appendFile").mockRejectedValueOnce(new Error("disk full"));
    try {
      await expect(
        updateLastRoute({
          storePath,
          sessionKey: "agent:main:webchat:dm:user-1",
          channel: "webchat",
          to: "user-1",
        }),
      ).resolves.toMatchObject({ sessionId: expect.any(String), lastTo: "user-1" });
    } finally {
      appendSpy.mockRestore();
    }
  });

  it("does not fail inbound metadata recording when recovery event append fails", async () => {
    const storePath = await createStorePath();
    const appendSpy = vi.spyOn(fs, "appendFile").mockRejectedValueOnce(new Error("disk full"));
    try {
      await expect(
        recordSessionMetaFromInbound({
          storePath,
          sessionKey: "agent:main:webchat:dm:user-1",
          ctx: { Provider: "webchat", ChatType: "direct" },
        }),
      ).resolves.toMatchObject({ sessionId: expect.any(String) });
    } finally {
      appendSpy.mockRestore();
    }
  });
});
